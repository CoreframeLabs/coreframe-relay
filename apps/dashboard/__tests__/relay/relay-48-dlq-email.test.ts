/**
 * @jest-environment node
 */

/**
 * [RELAY-48] DLQ email fallback — the hook point in `consumeEnvelope`.
 *
 * AC: "DLQ email fallback fires when a route has no Slack webhook configured."
 *
 * This file is the CONSUME half: it proves `consumeEnvelope` calls
 * `notifyDlqFallback` exactly when a `DlqItem` is newly written, and never in the
 * three cases that must not double-send or spam a team that opted into Slack instead
 * (that decision itself is `dlqNotify`'s job and is covered by
 * `relay-48-dlq-notify.test.ts` — this file only checks the wiring):
 *
 *   1. Not yet the final attempt — no DLQ row, no notification.
 *   2. A duplicate DLQ write (the item already existed) — already notified once.
 *   3. `isTest` traffic ("Send test webhook") — must never email a real team owner.
 *
 * And the one positive case: a genuine final-attempt failure notifies exactly once,
 * with the same `teamId`/`routeId`/`requestId`/`failReason` the DLQ row itself got.
 *
 * Mocking follows `relay-65.test.ts`'s pattern in this same directory: relative
 * specifiers (jest resolves `jest.mock` itself, before the `@/…` alias transform
 * would apply), `lib/relay/forward` mocked partially (only the network call), and
 * `notifyDlqFallback` swapped for a plain jest.fn() since its own decision logic is
 * out of scope here.
 */

jest.mock('../../lib/relay/forward', () => {
  const actual = jest.requireActual('../../lib/relay/forward');
  return {
    __esModule: true,
    ...actual,
    forwardToDestination: jest.fn(),
  };
});
jest.mock('../../lib/metrics', () => ({
  __esModule: true,
  recordMetric: jest.fn(),
}));
jest.mock('../../models/delivery', () => ({
  __esModule: true,
  assertRouteBelongsToTeam: jest.fn(),
  recordDeliveryAttempt: jest.fn(),
}));
jest.mock('../../models/dlq', () => {
  const actual = jest.requireActual('../../models/dlq');
  return {
    __esModule: true,
    ...actual,
    recordDlqItem: jest.fn(),
  };
});
jest.mock('../../models/route', () => ({
  __esModule: true,
  fetchRouteForDelivery: jest.fn(),
  fetchRoute: jest.fn(),
}));
jest.mock('../../lib/relay/destinationAuth', () => ({
  __esModule: true,
  decryptDestinationHeaders: jest.fn(),
  DESTINATION_HEADER_ALLOWED_NAMES: [],
  DestinationHeadersKeyError: class DestinationHeadersKeyError extends Error {},
  DestinationHeadersTamperError: class DestinationHeadersTamperError extends Error {},
}));
jest.mock('../../lib/db/scope', () => ({
  __esModule: true,
  withTeamScope: (_t: string, fn: () => Promise<unknown>) => fn(),
  currentTeamId: () => undefined,
}));
jest.mock('../../lib/relay/dlqNotify', () => ({
  __esModule: true,
  notifyDlqFallback: jest.fn().mockResolvedValue(undefined),
}));

import { forwardToDestination } from '../../lib/relay/forward';
import { recordDlqItem } from '../../models/dlq';
import {
  assertRouteBelongsToTeam,
  recordDeliveryAttempt,
} from '../../models/delivery';
import { fetchRouteForDelivery } from '../../models/route';
import { notifyDlqFallback } from '../../lib/relay/dlqNotify';
import { consumeEnvelope } from '../../lib/relay/consume';

const mockedForward = forwardToDestination as jest.Mock;
const mockedDlq = recordDlqItem as jest.Mock;
const mockedAssert = assertRouteBelongsToTeam as jest.Mock;
const mockedRecord = recordDeliveryAttempt as jest.Mock;
const mockedNotify = notifyDlqFallback as jest.Mock;
const mockedFetchRouteForDelivery = fetchRouteForDelivery as jest.Mock;

/** Minimal NextApiResponse stand-in — only what consumeEnvelope touches. */
function makeResponse() {
  const res: Record<string, unknown> = {};
  res.statusCode = 0;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res;
  };
  return res as never;
}

const ENVELOPE = {
  requestId: '5c1a1c9e-1111-4a1a-8a1a-0a0a0a0a0a01',
  routeId: '5c1a1c9e-1111-4a1a-8a1a-0a0a0a0a0a02',
  teamId: '5c1a1c9e-1111-4a1a-8a1a-0a0a0a0a0a03',
  destination: 'https://httpstat.us/500',
  maxRetries: 1,
  receivedAt: '2026-08-31T00:00:00.000Z',
  headers: { 'content-type': 'application/json' },
  body: '{"id":"evt_1"}',
  isTest: false,
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockedAssert.mockResolvedValue(undefined);
  mockedRecord.mockResolvedValue({ log: {}, duplicate: false });
  mockedDlq.mockResolvedValue({ item: {}, duplicate: false });
  mockedFetchRouteForDelivery.mockResolvedValue({
    destinationHeadersEncrypted: null,
  });
  // Every attempt in this file is a failure — the DLQ write is the subject.
  mockedForward.mockResolvedValue({
    ok: false,
    responseCode: 500,
    latencyMs: 8,
    failReason: 'destination responded 500',
  });
});

describe('[RELAY-48] consumeEnvelope notifies the DLQ email fallback', () => {
  it('notifies exactly once on a genuine final-attempt DLQ write', async () => {
    // retriesSoFar === maxRetries (1), so this IS the final attempt.
    await consumeEnvelope(ENVELOPE as never, 1, makeResponse());

    expect(mockedDlq).toHaveBeenCalledTimes(1);
    expect(mockedNotify).toHaveBeenCalledTimes(1);
    expect(mockedNotify).toHaveBeenCalledWith({
      teamId: ENVELOPE.teamId,
      routeId: ENVELOPE.routeId,
      requestId: ENVELOPE.requestId,
      failReason: 'destination responded 500',
    });
  });

  it('does not notify while retries remain — no DLQ row was written', async () => {
    await consumeEnvelope(ENVELOPE as never, 0, makeResponse());

    expect(mockedDlq).not.toHaveBeenCalled();
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it('does not notify on a duplicate DLQ write — already notified once', async () => {
    mockedDlq.mockResolvedValue({ item: {}, duplicate: true });

    await consumeEnvelope(ENVELOPE as never, 1, makeResponse());

    expect(mockedDlq).toHaveBeenCalledTimes(1);
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it('does not email a real team owner for isTest traffic', async () => {
    await consumeEnvelope({ ...ENVELOPE, isTest: true } as never, 1, makeResponse());

    expect(mockedDlq).toHaveBeenCalledTimes(1);
    expect(mockedNotify).not.toHaveBeenCalled();
  });

  it('still answers 200 dlq even though notifyDlqFallback is awaited', async () => {
    const res = makeResponse() as { statusCode: number; body: unknown };
    await consumeEnvelope(ENVELOPE as never, 1, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'dlq', requestId: ENVELOPE.requestId });
  });
});
