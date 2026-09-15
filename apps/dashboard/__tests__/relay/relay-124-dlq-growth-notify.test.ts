/**
 * @jest-environment node
 */

/**
 * [RELAY-124] `notifyDlqGrowthThreshold` — the decision logic behind customer-visible
 * DLQ *growth* alerting.
 *
 * `relay-124-dlq-growth-live.test.ts` (next door) proves this end to end against a
 * real database and a real (or disposable) Slack webhook / real DB-backed email
 * fallback. This file proves the decision logic in isolation, the same split
 * `relay-48-dlq-notify.test.ts` uses for `notifyDlqFallback`: no live database, every
 * boundary and branch exercised with controlled inputs.
 *
 * THE ONE THING THIS FILE EXISTS TO PROVE, ABOVE ALL ELSE
 * ----------------------------------------------------------
 * RELAY-124's core acceptance criterion is that the threshold computation REUSES
 * RELAY-44's existing `evaluateDlqHealth` directly, rather than reimplementing the
 * threshold math a second time. `dlqHealthCheck.ts` is mocked here with
 * `jest.requireActual` wrapping the real `evaluateDlqHealth` in a `jest.fn` spy —
 * everything else in that module (the threshold constants, the metrics type) stays
 * completely real. That lets the "no reimplementation" tests below assert, by
 * function-identity spy, that `notifyDlqGrowthThreshold` calls that exact function
 * with the exact metrics it collected — not merely that it produces the same answer
 * a correct reimplementation would.
 *
 * Mocking follows `relay-48-dlq-notify.test.ts`'s pattern in this same directory:
 * relative specifiers (jest resolves `jest.mock` before the `@/…` alias transform
 * applies), `models/team`, `lib/email/sendDlqFallbackEmail`, and the Slack channel
 * mocked at the module boundary since this file is about the decision logic, not the
 * network calls.
 */

jest.mock('../../lib/prisma', () => ({
  __esModule: true,
  unscopedPrisma: {
    dlqItem: { count: jest.fn() },
    deliveryLog: { count: jest.fn() },
    route: { findFirst: jest.fn() },
  },
}));
jest.mock('../../models/team', () => ({
  __esModule: true,
  getTeam: jest.fn(),
  fetchTeamOwnerEmail: jest.fn(),
}));
jest.mock('../../lib/email/sendDlqFallbackEmail', () => ({
  __esModule: true,
  sendDlqFallbackEmail: jest.fn().mockResolvedValue(undefined),
}));

const mockAlert = jest.fn().mockResolvedValue(undefined);
const mockSlackNotifyFactory = jest.fn((_url: string) => ({ alert: mockAlert }));
jest.mock('slack-notify', () => ({
  __esModule: true,
  default: (url: string) => mockSlackNotifyFactory(url),
}));

jest.mock('../../lib/relay/dlqHealthCheck', () => {
  const actual = jest.requireActual('../../lib/relay/dlqHealthCheck');
  return {
    __esModule: true,
    ...actual,
    // Real implementation underneath — this only adds an observation point, it
    // changes no behavior. If `notifyDlqGrowthThreshold` ever stopped calling this
    // and started reimplementing the comparison itself, this spy would simply never
    // be called, and the "reuse, not reimplementation" tests below would fail.
    evaluateDlqHealth: jest.fn(actual.evaluateDlqHealth),
  };
});

import { unscopedPrisma } from '../../lib/prisma';
import { getTeam, fetchTeamOwnerEmail } from '../../models/team';
import { sendDlqFallbackEmail } from '../../lib/email/sendDlqFallbackEmail';
import {
  evaluateDlqHealth,
  DLQ_GROWTH_ALERT_THRESHOLD,
} from '../../lib/relay/dlqHealthCheck';
import { notifyDlqGrowthThreshold } from '../../lib/relay/dlqNotify';

const mockedDlqCount = unscopedPrisma.dlqItem.count as jest.Mock;
const mockedDeliveryLogCount = unscopedPrisma.deliveryLog.count as jest.Mock;
const mockedRouteFindFirst = unscopedPrisma.route.findFirst as jest.Mock;
const mockedGetTeam = getTeam as jest.Mock;
const mockedOwnerEmail = fetchTeamOwnerEmail as jest.Mock;
const mockedSendEmail = sendDlqFallbackEmail as jest.Mock;
const mockedEvaluateDlqHealth = evaluateDlqHealth as jest.Mock;

const PARAMS = { teamId: 'team_124', routeId: 'route_124' };

const ROUTE = {
  id: 'route_124',
  teamId: 'team_124',
  name: 'orders-webhook',
  slug: 'orders-webhook',
  destination: 'https://api.example.com/hooks/relay?token=shh',
  maxRetries: 1,
  status: 'ACTIVE',
  ingestToken: 'irrelevant',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const TEAM_WITH_SLACK = {
  id: 'team_124',
  slug: 'acme',
  name: 'Acme',
  slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/XXX',
};

const TEAM_NO_SLACK = { ...TEAM_WITH_SLACK, slackWebhookUrl: null };

/** Sets up the three counts `collectRouteDlqHealthMetrics` queries for. */
function mockMetrics(newDlqCount: number, totalDeliveryAttempts = 0, failed = 0) {
  mockedDlqCount.mockResolvedValue(newDlqCount);
  mockedDeliveryLogCount
    .mockResolvedValueOnce(totalDeliveryAttempts)
    .mockResolvedValueOnce(failed);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedRouteFindFirst.mockResolvedValue(ROUTE);
  mockedOwnerEmail.mockResolvedValue('owner@example.com');
});

describe('[RELAY-124] threshold reuse — evaluateDlqHealth is called, not reimplemented', () => {
  it('calls the real RELAY-44 evaluateDlqHealth with the collected metrics', async () => {
    mockMetrics(DLQ_GROWTH_ALERT_THRESHOLD + 1);
    mockedGetTeam.mockResolvedValue(TEAM_NO_SLACK);

    await notifyDlqGrowthThreshold(PARAMS);

    expect(mockedEvaluateDlqHealth).toHaveBeenCalledTimes(1);
    expect(mockedEvaluateDlqHealth).toHaveBeenCalledWith({
      newDlqCount: DLQ_GROWTH_ALERT_THRESHOLD + 1,
      totalDeliveryAttempts: 0,
      failedOrDlqDeliveryCount: 0,
    });
    // The real function's real verdict is what drove the email below — not a
    // second, independent comparison against DLQ_GROWTH_ALERT_THRESHOLD.
    expect(mockedEvaluateDlqHealth).toHaveReturnedWith(
      expect.objectContaining({ healthy: false, reasons: ['dlq_growth_exceeded'] })
    );
    expect(mockedSendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not alert exactly at the threshold (same boundary as RELAY-44)', async () => {
    mockMetrics(DLQ_GROWTH_ALERT_THRESHOLD);
    mockedGetTeam.mockResolvedValue(TEAM_NO_SLACK);

    const result = await notifyDlqGrowthThreshold(PARAMS);

    expect(mockedEvaluateDlqHealth).toHaveReturnedWith(
      expect.objectContaining({ healthy: true })
    );
    expect(result).toEqual({ notified: false, channel: null, reasons: [] });
    // The gate short-circuits before ever looking up team/route — no reason to run
    // two more queries for a notification that will not fire.
    expect(mockedGetTeam).not.toHaveBeenCalled();
    expect(mockedRouteFindFirst).not.toHaveBeenCalled();
    expect(mockedSendEmail).not.toHaveBeenCalled();
    expect(mockSlackNotifyFactory).not.toHaveBeenCalled();
  });

  it('alerts one row above the threshold', async () => {
    mockMetrics(DLQ_GROWTH_ALERT_THRESHOLD + 1);
    mockedGetTeam.mockResolvedValue(TEAM_NO_SLACK);

    const result = await notifyDlqGrowthThreshold(PARAMS);

    expect(result.notified).toBe(true);
    expect(result.reasons).toContain('dlq_growth_exceeded');
  });
});

describe('[RELAY-124] Team.slackWebhookUrl set → a real Slack call is made, no email', () => {
  it('posts to the team-specific webhook via slack-notify, with growth context', async () => {
    mockMetrics(DLQ_GROWTH_ALERT_THRESHOLD + 5);
    mockedGetTeam.mockResolvedValue(TEAM_WITH_SLACK);

    const result = await notifyDlqGrowthThreshold(PARAMS);

    expect(mockSlackNotifyFactory).toHaveBeenCalledWith(
      TEAM_WITH_SLACK.slackWebhookUrl
    );
    expect(mockAlert).toHaveBeenCalledTimes(1);
    const call = mockAlert.mock.calls[0][0];
    expect(call.text).toContain(ROUTE.name);
    expect(call.fields.Team).toBe(TEAM_WITH_SLACK.name);
    expect(call.fields.Route).toBe(ROUTE.name);
    expect(call.fields['New DLQ items (last hour)']).toBe(
      String(DLQ_GROWTH_ALERT_THRESHOLD + 5)
    );
    expect(call.fields.Threshold).toBe(String(DLQ_GROWTH_ALERT_THRESHOLD));

    expect(mockedSendEmail).not.toHaveBeenCalled();
    expect(mockedOwnerEmail).not.toHaveBeenCalled();
    expect(result).toEqual({
      notified: true,
      channel: 'slack',
      reasons: ['dlq_growth_exceeded'],
    });
  });

  it('never fetches the route through the team-scoped model helper', async () => {
    // Regression guard for the RLS trap this ticket's implementation had to avoid:
    // `models/route.ts`'s `fetchRoute` uses the team-scoped `prisma` export, which
    // needs `withTeamScope` to have set `app.current_team_id` for this async call
    // chain. This function runs from the session-free cron, so it must go through
    // `unscopedPrisma.route.findFirst` (mocked above) directly instead — this test
    // fails loudly if a future edit swaps it back to the scoped helper.
    mockMetrics(DLQ_GROWTH_ALERT_THRESHOLD + 1);
    mockedGetTeam.mockResolvedValue(TEAM_WITH_SLACK);

    await notifyDlqGrowthThreshold(PARAMS);

    expect(mockedRouteFindFirst).toHaveBeenCalledWith({
      where: { id: PARAMS.routeId, teamId: PARAMS.teamId },
      select: expect.any(Object),
    });
  });
});

describe('[RELAY-124] Team.slackWebhookUrl NOT set → the existing email fallback fires', () => {
  it('reuses sendDlqFallbackEmail with a growth-specific failReason', async () => {
    mockMetrics(DLQ_GROWTH_ALERT_THRESHOLD + 3);
    mockedGetTeam.mockResolvedValue(TEAM_NO_SLACK);

    const result = await notifyDlqGrowthThreshold(PARAMS);

    expect(mockSlackNotifyFactory).not.toHaveBeenCalled();
    expect(mockedOwnerEmail).toHaveBeenCalledWith(PARAMS.teamId);
    expect(mockedSendEmail).toHaveBeenCalledTimes(1);
    const call = mockedSendEmail.mock.calls[0][0];
    expect(call.to).toBe('owner@example.com');
    expect(call.teamName).toBe(TEAM_NO_SLACK.name);
    expect(call.routeName).toBe(ROUTE.name);
    expect(call.destinationHost).toBe('api.example.com');
    expect(call.failReason).toContain(String(DLQ_GROWTH_ALERT_THRESHOLD + 3));
    expect(call.failReason).toContain(String(DLQ_GROWTH_ALERT_THRESHOLD));
    expect(result).toEqual({
      notified: true,
      channel: 'email',
      reasons: ['dlq_growth_exceeded'],
    });
  });

  it('logs and returns without throwing when no owner email can be found', async () => {
    mockMetrics(DLQ_GROWTH_ALERT_THRESHOLD + 1);
    mockedGetTeam.mockResolvedValue(TEAM_NO_SLACK);
    mockedOwnerEmail.mockResolvedValue(null);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await notifyDlqGrowthThreshold(PARAMS);

    expect(mockedSendEmail).not.toHaveBeenCalled();
    expect(result.notified).toBe(false);
    errorSpy.mockRestore();
  });
});

describe('[RELAY-124] every failure is swallowed — this must never throw', () => {
  it('a getTeam rejection resolves quietly', async () => {
    mockMetrics(DLQ_GROWTH_ALERT_THRESHOLD + 1);
    mockedGetTeam.mockRejectedValue(new Error('db unreachable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notifyDlqGrowthThreshold(PARAMS)).resolves.toEqual(
      expect.objectContaining({ notified: false })
    );

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a Slack send rejection resolves quietly instead of throwing', async () => {
    mockMetrics(DLQ_GROWTH_ALERT_THRESHOLD + 1);
    mockedGetTeam.mockResolvedValue(TEAM_WITH_SLACK);
    mockAlert.mockRejectedValueOnce(new Error('slack unreachable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notifyDlqGrowthThreshold(PARAMS)).resolves.toEqual(
      expect.objectContaining({ notified: false })
    );

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a missing route logs and returns instead of throwing', async () => {
    mockMetrics(DLQ_GROWTH_ALERT_THRESHOLD + 1);
    mockedGetTeam.mockResolvedValue(TEAM_NO_SLACK);
    mockedRouteFindFirst.mockResolvedValue(null);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await notifyDlqGrowthThreshold(PARAMS);

    expect(result).toEqual({
      notified: false,
      channel: null,
      reasons: ['dlq_growth_exceeded'],
    });
    expect(mockedSendEmail).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
