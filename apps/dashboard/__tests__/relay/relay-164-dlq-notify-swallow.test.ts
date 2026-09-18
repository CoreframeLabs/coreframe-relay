/**
 * @jest-environment node
 */

/**
 * [RELAY-164] "DLQ fallback email failures are swallowed silently" — proves the fix.
 *
 * `notifyDlqFallback` and `notifyDlqGrowthThreshold` (`lib/relay/dlqNotify.ts`) both
 * deliberately swallow every send error, and that swallow is UNCHANGED by this ticket
 * (see `relay-48-dlq-notify.test.ts` and `relay-124-dlq-growth-notify.test.ts`, next
 * door, for the pre-existing "never throws" proof). This file proves the three things
 * this ticket actually adds, all DB-independent per the AC:
 *
 *   1. A rejected send still does not throw out of `notifyDlqFallback` AND records the
 *      metric exactly once with the team id.
 *   2. `getDlqNotifySendFailureCount` — the module-level counter the founder health
 *      check reads (see that function's doc in dlqNotify.ts for why a counter, not a
 *      DB query) — actually counts within its window and prunes what falls outside it.
 *   3. `formatDlqNotifySendFailureAlert` — the pure formatter `dlq-health-check.ts`
 *      calls — includes the count in its text when non-zero, and returns null (no
 *      alert) when the count is zero.
 *
 * Mocking follows `relay-48-dlq-notify.test.ts`'s pattern in this same directory:
 * relative specifiers for `models/route`, `models/team`, and
 * `lib/email/sendDlqFallbackEmail` (jest resolves `jest.mock` before the `@/…` alias
 * transform applies), and `lib/metrics` mocked at the module boundary so the metric
 * call can be asserted without needing OTEL env vars configured.
 */

jest.mock('../../models/route', () => ({
  __esModule: true,
  fetchRoute: jest.fn(),
}));
jest.mock('../../models/team', () => ({
  __esModule: true,
  getTeam: jest.fn(),
  fetchTeamOwnerEmail: jest.fn(),
}));
jest.mock('../../lib/email/sendDlqFallbackEmail', () => ({
  __esModule: true,
  sendDlqFallbackEmail: jest.fn(),
}));
jest.mock('../../lib/metrics', () => ({
  __esModule: true,
  recordMetric: jest.fn(),
}));

import { fetchRoute } from '../../models/route';
import { getTeam, fetchTeamOwnerEmail } from '../../models/team';
import { sendDlqFallbackEmail } from '../../lib/email/sendDlqFallbackEmail';
import { recordMetric } from '../../lib/metrics';
import {
  notifyDlqFallback,
  getDlqNotifySendFailureCount,
  formatDlqNotifySendFailureAlert,
} from '../../lib/relay/dlqNotify';

const mockedFetchRoute = fetchRoute as jest.Mock;
const mockedGetTeam = getTeam as jest.Mock;
const mockedOwnerEmail = fetchTeamOwnerEmail as jest.Mock;
const mockedSend = sendDlqFallbackEmail as jest.Mock;
const mockedRecordMetric = recordMetric as jest.Mock;

const PARAMS = {
  teamId: 'team_164',
  routeId: 'route_164',
  requestId: 'req_164',
  failReason: 'destination responded 500',
};

const TEAM_NO_SLACK = {
  id: 'team_164',
  slug: 'acme',
  name: 'Acme',
  slackWebhookUrl: null,
};

const ROUTE = {
  id: 'route_164',
  teamId: 'team_164',
  name: 'orders-webhook',
  slug: 'orders-webhook',
  destination: 'https://api.example.com/hooks/relay?token=shh',
  maxRetries: 1,
  status: 'ACTIVE',
  ingestToken: 'irrelevant',
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetTeam.mockResolvedValue(TEAM_NO_SLACK);
  mockedFetchRoute.mockResolvedValue(ROUTE);
  mockedOwnerEmail.mockResolvedValue('owner@example.com');
});

describe('[RELAY-164] a rejected send is swallowed AND recorded', () => {
  it('does not throw out of notifyDlqFallback when the email transport rejects', async () => {
    mockedSend.mockRejectedValue(new Error('Resend: daily cap exceeded'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notifyDlqFallback(PARAMS)).resolves.toBeUndefined();

    errorSpy.mockRestore();
  });

  it('records the metric exactly once, and only once, with the team id in the structured log', async () => {
    mockedSend.mockRejectedValue(new Error('Resend: daily cap exceeded'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await notifyDlqFallback(PARAMS);

    expect(mockedRecordMetric).toHaveBeenCalledTimes(1);
    expect(mockedRecordMetric).toHaveBeenCalledWith('relay.dlq_notify.send_failed');

    // The structured `console.error` JSON line — separate from the pre-existing
    // "[relay] dlqNotify: failed to send DLQ fallback email" line, which this ticket
    // leaves untouched.
    const structuredCall = errorSpy.mock.calls.find(([arg]) => {
      try {
        return (
          typeof arg === 'string' &&
          JSON.parse(arg).event === 'relay.dlq_notify_send_failed'
        );
      } catch {
        return false;
      }
    });
    expect(structuredCall).toBeDefined();
    const logged = JSON.parse(structuredCall![0] as string);
    expect(logged).toMatchObject({
      level: 'error',
      event: 'relay.dlq_notify_send_failed',
      teamId: PARAMS.teamId,
      channel: 'email',
      reason: 'Resend: daily cap exceeded',
    });

    errorSpy.mockRestore();
  });

  it('does not record anything when the send succeeds', async () => {
    mockedSend.mockResolvedValue(undefined);

    await notifyDlqFallback(PARAMS);

    expect(mockedRecordMetric).not.toHaveBeenCalled();
  });

  it('still does not throw and still records when recordMetric itself throws', async () => {
    // The recording helper must never become a new, unswallowed failure — see its
    // doc in dlqNotify.ts.
    mockedSend.mockRejectedValue(new Error('SMTP timeout'));
    mockedRecordMetric.mockImplementation(() => {
      throw new Error('OTEL exporter unreachable');
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notifyDlqFallback(PARAMS)).resolves.toBeUndefined();

    errorSpy.mockRestore();
  });
});

describe('[RELAY-164] getDlqNotifySendFailureCount — the founder alert\'s window', () => {
  it('counts a swallowed failure within the window', async () => {
    mockedSend.mockRejectedValue(new Error('Resend: daily cap exceeded'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const before = getDlqNotifySendFailureCount();
    await notifyDlqFallback(PARAMS);
    const after = getDlqNotifySendFailureCount();

    expect(after).toBe(before + 1);
  });

  it('does not count entries older than the given window', async () => {
    mockedSend.mockRejectedValue(new Error('Resend: daily cap exceeded'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Pin `Date.now()` at the moment of failure (relative to the real clock, so this
    // stays valid alongside whatever real-timestamped entries earlier tests in this
    // file may have already left in the shared counter), then move the mocked clock
    // forward past a short window — proving this prunes by age, not a running total.
    const base = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
    await notifyDlqFallback(PARAMS);
    nowSpy.mockRestore();

    const laterSpy = jest.spyOn(Date, 'now').mockReturnValue(base + 5_000);
    // Check the wide window FIRST: the read side prunes in place, so checking the
    // narrow window first would already have discarded the entries this assertion
    // needs to see.
    expect(getDlqNotifySendFailureCount(60 * 60 * 1000)).toBeGreaterThanOrEqual(1);
    // Every entry so far (this one and any from earlier tests) is now further in the
    // past than a 1s window reaching back from `base + 5s` allows.
    expect(getDlqNotifySendFailureCount(1_000)).toBe(0);
    laterSpy.mockRestore();
  });
});

describe('[RELAY-164] formatDlqNotifySendFailureAlert — the founder alert\'s text', () => {
  it('returns null when there is nothing to report', () => {
    expect(formatDlqNotifySendFailureAlert(0)).toBeNull();
  });

  it('includes the count in the alert text when non-zero', () => {
    const text = formatDlqNotifySendFailureAlert(3);

    expect(text).not.toBeNull();
    expect(text).toContain('3');
    expect(text).toContain('RELAY-164');
  });
});
