/**
 * @jest-environment node
 */

/**
 * [RELAY-48] `notifyDlqFallback` — the decision logic behind the DLQ email fallback.
 *
 * `relay-48-dlq-email.test.ts` (next door) proves `consumeEnvelope` calls this
 * function at the right times. This file proves what the function itself decides
 * once called:
 *
 *   1. No `Team.slackWebhookUrl` configured → sends the email. This is the AC as
 *      literally written ("fires when a route has no Slack webhook configured"), and
 *      today it is every team, because nothing writes that column yet — see its
 *      schema comment.
 *   2. `Team.slackWebhookUrl` IS configured → does not send. Proves the gate actually
 *      gates, even though no code path can set the column today — the day a settings
 *      UI ships, this is the line that makes the fallback stop firing without any
 *      change here.
 *   3. Missing route or missing owner email → logs and returns, never throws.
 *   4. The destination URL is reduced to its HOST ONLY on the way into the email —
 *      never the full URL (which can carry a query string) and never any destination
 *      auth header, which this function does not even fetch.
 *   5. Any thrown error anywhere in the lookup/send path is swallowed, never
 *      rethrown — `consumeEnvelope` awaits this function on the DLQ hot path, and a
 *      throw here must never turn a successful DLQ write into a 500.
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
  sendDlqFallbackEmail: jest.fn().mockResolvedValue(undefined),
}));

import { fetchRoute } from '../../models/route';
import { getTeam, fetchTeamOwnerEmail } from '../../models/team';
import { sendDlqFallbackEmail } from '../../lib/email/sendDlqFallbackEmail';
import { notifyDlqFallback } from '../../lib/relay/dlqNotify';

const mockedFetchRoute = fetchRoute as jest.Mock;
const mockedGetTeam = getTeam as jest.Mock;
const mockedOwnerEmail = fetchTeamOwnerEmail as jest.Mock;
const mockedSend = sendDlqFallbackEmail as jest.Mock;

const PARAMS = {
  teamId: 'team_1',
  routeId: 'route_1',
  requestId: 'req_1',
  failReason: 'destination responded 500',
};

const TEAM_NO_SLACK = {
  id: 'team_1',
  slug: 'acme',
  name: 'Acme',
  slackWebhookUrl: null,
};

const ROUTE = {
  id: 'route_1',
  teamId: 'team_1',
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

describe('[RELAY-48] no Slack webhook configured → email fires', () => {
  it('sends the fallback email with team, route, and reason', async () => {
    await notifyDlqFallback(PARAMS);

    expect(mockedSend).toHaveBeenCalledTimes(1);
    expect(mockedSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.com',
        teamSlug: 'acme',
        teamName: 'Acme',
        routeName: 'orders-webhook',
        failReason: 'destination responded 500',
      })
    );
  });

  it('reduces the destination to HOST ONLY — never the full URL', async () => {
    await notifyDlqFallback(PARAMS);

    const call = mockedSend.mock.calls[0][0];
    expect(call.destinationHost).toBe('api.example.com');
    // The regression this guards: a query string can carry a value the customer
    // considers sensitive (here, `token=shh`). It must never reach the email body.
    expect(call.destinationHost).not.toContain('token');
    expect(call.destinationHost).not.toContain('shh');
    expect(call.destinationHost).not.toContain('https://');
  });

  it('never passes destination auth headers — it never even fetches them', async () => {
    await notifyDlqFallback(PARAMS);

    const call = mockedSend.mock.calls[0][0];
    expect(call).not.toHaveProperty('destinationHeaders');
    expect(call).not.toHaveProperty('destinationHeadersEncrypted');
  });
});

describe('[RELAY-48] a Slack webhook IS configured → the fallback stays quiet', () => {
  it('does not send an email', async () => {
    mockedGetTeam.mockResolvedValue({
      ...TEAM_NO_SLACK,
      slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/XXX',
    });

    await notifyDlqFallback(PARAMS);

    expect(mockedSend).not.toHaveBeenCalled();
    // The gate must short-circuit BEFORE the route/owner lookups, not merely before
    // the send — no reason to run two more queries for a notification that Slack
    // (once it exists) will carry instead.
    expect(mockedFetchRoute).not.toHaveBeenCalled();
    expect(mockedOwnerEmail).not.toHaveBeenCalled();
  });
});

describe('[RELAY-48] missing data degrades to "no email", never a throw', () => {
  it('logs and returns when the route is gone', async () => {
    mockedFetchRoute.mockResolvedValue(null);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notifyDlqFallback(PARAMS)).resolves.toBeUndefined();

    expect(mockedSend).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('logs and returns when no owner email can be found', async () => {
    mockedOwnerEmail.mockResolvedValue(null);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notifyDlqFallback(PARAMS)).resolves.toBeUndefined();

    expect(mockedSend).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('[RELAY-48] every failure is swallowed — this must never throw', () => {
  it('a getTeam rejection resolves quietly', async () => {
    mockedGetTeam.mockRejectedValue(new Error('db unreachable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notifyDlqFallback(PARAMS)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a sendEmail rejection resolves quietly', async () => {
    mockedSend.mockRejectedValue(new Error('SMTP timeout'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notifyDlqFallback(PARAMS)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('an unparseable destination falls back to the raw string instead of throwing', async () => {
    mockedFetchRoute.mockResolvedValue({ ...ROUTE, destination: 'not-a-url' });

    await expect(notifyDlqFallback(PARAMS)).resolves.toBeUndefined();

    expect(mockedSend).toHaveBeenCalledWith(
      expect.objectContaining({ destinationHost: 'not-a-url' })
    );
  });
});
