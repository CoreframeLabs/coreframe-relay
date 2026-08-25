/**
 * @jest-environment node
 */

/**
 * [RELAY-65] DLQ retry must replay the ORIGINAL request headers.
 *
 * ─── The bug this file exists to keep fixed ───────────────────────────────────────────
 *
 * A DLQ retry resent the stored body with `headers: {}`. A destination that verifies a
 * signature header — `stripe-signature`, `x-hub-signature-256`, `x-shopify-hmac-sha256` —
 * rejects that replay every time, so DLQ recovery was broken for exactly the
 * payment/commerce traffic it exists to save.
 *
 * The headers were never missing from the PIPELINE: the proxy's `forwardableHeaders()`
 * puts them on the envelope and every forward attempt sent them. The one place they were
 * dropped was the DLQ WRITE — `recordDlqItem` was not handed them and had no column to
 * put them in. So the fix is only complete if it holds at three separate points, and this
 * file asserts one thing at each:
 *
 *   1. CAPTURE — the final failed attempt persists the headers it just sent.
 *   2. RECOVERY — a stored map round-trips back out, defensively, without widening.
 *   3. WIRE — a signature header actually arrives at a real destination, byte-for-byte.
 *
 * A test at only the retry endpoint would have passed against a build that still stored
 * nothing, because `{}` filtered is still `{}`. Point 1 is the regression guard that
 * matters most.
 */

import http from 'node:http';

// ─── Mocks for the CAPTURE half ───────────────────────────────────────────────────────
//
// Relative specifiers, not the `@/…` aliases: jest resolves a `jest.mock` specifier
// itself, and the alias transform only rewrites imports inside a file being read. Same
// reasoning as relay-50.test.ts next door.
//
// `lib/relay/forward` is deliberately NOT mocked as a whole — `filterForwardHeaders` is
// part of what is under test, so only the network call is replaced.
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

import {
  filterForwardHeaders,
  forwardToDestination,
} from '../../lib/relay/forward';
import { recordDlqItem, readStoredHeaders } from '../../models/dlq';
import {
  assertRouteBelongsToTeam,
  recordDeliveryAttempt,
} from '../../models/delivery';
import { consumeEnvelope } from '../../lib/relay/consume';

const mockedForward = forwardToDestination as jest.Mock;
const mockedDlq = recordDlqItem as jest.Mock;
const mockedAssert = assertRouteBelongsToTeam as jest.Mock;
const mockedRecord = recordDeliveryAttempt as jest.Mock;

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

/** A Stripe-shaped signature header value. Opaque to us; sacred to the destination. */
const STRIPE_SIG = 't=1723497600,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd';

const ENVELOPE = {
  requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3401',
  routeId: '3f2504e0-4f89-41d3-9a0c-0305e82c3402',
  teamId: '3f2504e0-4f89-41d3-9a0c-0305e82c3403',
  destination: 'https://example.com/hook',
  maxRetries: 3,
  receivedAt: '2026-08-19T00:00:00.000Z',
  headers: {
    'stripe-signature': STRIPE_SIG,
    'content-type': 'application/json',
    // Must NOT survive to storage: refused by filterForwardHeaders even though the
    // proxy's narrower inbound strip list lets them through to the envelope.
    'x-api-key': 'sk_live_should_never_be_persisted',
    host: 'relay.example.com',
    'content-length': '17',
  },
  body: '{"id":"evt_123"}',
  isTest: false,
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockedAssert.mockResolvedValue(undefined);
  mockedRecord.mockResolvedValue({ log: {}, duplicate: false });
  mockedDlq.mockResolvedValue({ item: {}, duplicate: false });
  const { fetchRouteForDelivery } = require('../../models/route');
  (fetchRouteForDelivery as jest.Mock).mockResolvedValue({
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

// ─── 1. CAPTURE ───────────────────────────────────────────────────────────────────────

describe('[RELAY-65] the DLQ write persists the headers the failed attempt sent', () => {
  it('stores the signature header on the final attempt', async () => {
    // retriesSoFar === maxRetries, so this is the DLQ-writing attempt.
    await consumeEnvelope(ENVELOPE as never, 3, makeResponse());

    expect(mockedDlq).toHaveBeenCalledTimes(1);
    const candidate = mockedDlq.mock.calls[0][0];

    // THE REGRESSION. Before this ticket `recordDlqItem` received no `headers` at all,
    // so a retry had nothing to replay and a signature check at the destination failed.
    expect(candidate.headers).toBeDefined();
    expect(candidate.headers['stripe-signature']).toBe(STRIPE_SIG);
    expect(candidate.headers['content-type']).toBe('application/json');
  });

  it('does NOT persist headers the forward path would refuse to send', async () => {
    await consumeEnvelope(ENVELOPE as never, 3, makeResponse());
    const candidate = mockedDlq.mock.calls[0][0];

    // Asserted first so the three `not.toHaveProperty` checks below cannot pass
    // vacuously against a build that stores no headers at all.
    expect(candidate.headers).toBeDefined();

    // Data minimisation: the column must never become a longer-lived copy of a sender
    // credential than the delivery attempt itself was. `x-api-key` clears the proxy's
    // inbound strip list but not `filterForwardHeaders`.
    expect(candidate.headers).not.toHaveProperty('x-api-key');
    // Hop-by-hop / framing headers describe a connection that no longer exists.
    expect(candidate.headers).not.toHaveProperty('host');
    expect(candidate.headers).not.toHaveProperty('content-length');
  });

  it('stores what was sent — the stored map equals the filtered sent map', async () => {
    await consumeEnvelope(ENVELOPE as never, 3, makeResponse());
    const candidate = mockedDlq.mock.calls[0][0];

    // The invariant the whole design rests on: storage is neither wider nor narrower
    // than the wire. If these ever diverge, a replay stops being a replay.
    expect(candidate.headers).toEqual(filterForwardHeaders(ENVELOPE.headers));
  });

  it('writes no DLQ row while attempts remain — headers are stored once, at the end', async () => {
    await consumeEnvelope(ENVELOPE as never, 0, makeResponse());
    expect(mockedDlq).not.toHaveBeenCalled();
  });

  it('stores an empty map, not null, for a request that carried no forwardable headers', async () => {
    await consumeEnvelope({ ...ENVELOPE, headers: {} } as never, 3, makeResponse());
    const candidate = mockedDlq.mock.calls[0][0];

    // `{}` ("nothing to replay") and NULL ("never captured") must stay distinguishable —
    // `headersRetained` in the UI reads exactly that difference.
    expect(candidate.headers).toEqual({});
    expect(candidate.headers).not.toBeNull();
  });
});

// ─── 2. RECOVERY ──────────────────────────────────────────────────────────────────────

describe('[RELAY-65] readStoredHeaders recovers a stored map defensively', () => {
  it('round-trips a signature header out of the JSON column', () => {
    const stored = { 'stripe-signature': STRIPE_SIG, 'content-type': 'application/json' };
    expect(readStoredHeaders(stored)).toEqual(stored);
  });

  it('reads a pre-migration NULL as {} rather than throwing', () => {
    // The old-row path. Retry then behaves exactly as it did before this ticket for
    // those rows — no headers — instead of failing.
    expect(readStoredHeaders(null)).toEqual({});
  });

  it('refuses a non-object column value', () => {
    expect(readStoredHeaders(['stripe-signature'] as never)).toEqual({});
    expect(readStoredHeaders('stripe-signature' as never)).toEqual({});
    expect(readStoredHeaders(42 as never)).toEqual({});
  });

  it('drops non-string values instead of coercing them', () => {
    // A hand-edited or malformed row must not hand `fetch` something it throws on.
    // Dropping degrades to "this one header did not survive"; coercing would invent
    // a value the sender never set.
    const out = readStoredHeaders({
      'stripe-signature': STRIPE_SIG,
      'x-count': 7,
      'x-nested': { a: 1 },
      'x-null': null,
    } as never);
    expect(out).toEqual({ 'stripe-signature': STRIPE_SIG });
  });

  it('composed with filterForwardHeaders, keeps signatures and drops credentials', () => {
    // Exactly the composition the retry endpoint applies when rebuilding the envelope.
    const out = filterForwardHeaders(
      readStoredHeaders({
        'stripe-signature': STRIPE_SIG,
        'x-hub-signature-256': 'sha256=abc',
        'x-shopify-hmac-sha256': 'base64hmac',
        authorization: 'Bearer inbound-should-never-be-replayed',
        cookie: 'session=abc',
        connection: 'keep-alive',
      } as never)
    );

    expect(out['stripe-signature']).toBe(STRIPE_SIG);
    expect(out['x-hub-signature-256']).toBe('sha256=abc');
    expect(out['x-shopify-hmac-sha256']).toBe('base64hmac');
    expect(out).not.toHaveProperty('authorization');
    expect(out).not.toHaveProperty('cookie');
    expect(out).not.toHaveProperty('connection');
  });
});

// ─── 3. WIRE ──────────────────────────────────────────────────────────────────────────

/**
 * The only assertion that proves the header reaches a DESTINATION rather than merely
 * surviving our own function calls. A real listener on a random loopback port records
 * what it received.
 *
 * ⚠ The SSRF seam is doubled for this describe block only, exactly as
 * `destinationAuth.forward.spec.ts` does and for the same reason: the real validator
 * blocks loopback (correctly), and there is no address a test can bind that it allows.
 * The double delegates every decision to the real validator and overrides it for nothing
 * except literal `127.0.0.1` on an ephemeral port. `ssrf.forward.spec.ts` remains the file
 * that proves the forward path is SSRF-guarded; this one does not and must not be read as
 * doing so.
 *
 * [RELAY-33] UPDATE: `forward.ts` now calls `resolveAndValidateDestination` (the
 * DNS-resolving layer) rather than `validateDestination` directly, so BOTH are widened
 * identically here — same narrow scope, same "never widens for anything else" property.
 */
jest.mock('../../lib/relay/ssrfGap', () => {
  const actual = jest.requireActual('../../lib/relay/ssrfGap');

  const loopbackOverride = (raw: string) => {
    try {
      const url = new URL(raw);
      if (url.hostname === '127.0.0.1' && Number(url.port) >= 1024) {
        return { ok: true, url };
      }
    } catch {
      // A URL that will not parse stays rejected — the double never widens a failure.
    }
    return null;
  };

  return {
    ...actual,
    validateDestination: (raw: string) => {
      const verdict = actual.validateDestination(raw);
      if (verdict.ok) return verdict;
      return loopbackOverride(raw) ?? verdict;
    },
    resolveAndValidateDestination: async (raw: string) => {
      const verdict = await actual.resolveAndValidateDestination(raw);
      if (verdict.ok) return verdict;
      return loopbackOverride(raw) ?? verdict;
    },
  };
});

/** Records every request, and answers 200 only when the Stripe signature matches. */
function signatureVerifyingDestination(expected: string): Promise<{
  port: number;
  seen: http.IncomingHttpHeaders[];
  close: () => Promise<void>;
}> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.headers['stripe-signature'] === expected) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      // What a real Stripe-verifying receiver does to an unsigned replay, and the
      // behaviour that made RELAY-65 a customer-visible failure.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'signature-verification-failed' }));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) {
        resolve({
          port: address.port,
          seen,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      } else {
        reject(new Error('server.listen produced a non-TCP address'));
      }
    });
  });
}

describe('[RELAY-65] a replayed DLQ item reaches the destination WITH its signature', () => {
  // The real implementation, not the module-level mock — this block is about the wire.
  const realForward = jest.requireActual('../../lib/relay/forward')
    .forwardToDestination as typeof forwardToDestination;

  it('delivers 2xx from a destination that verifies stripe-signature', async () => {
    const dest = await signatureVerifyingDestination(STRIPE_SIG);
    try {
      // Precisely what the retry endpoint rebuilds: the stored column, recovered and
      // re-filtered. Nothing here is hand-written — it is the stored-row path.
      const storedColumn = filterForwardHeaders(ENVELOPE.headers);
      const replayHeaders = filterForwardHeaders(readStoredHeaders(storedColumn));

      const outcome = await realForward({
        destination: `http://127.0.0.1:${dest.port}/hook`,
        headers: replayHeaders,
        body: ENVELOPE.body,
        requestId: ENVELOPE.requestId,
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.responseCode).toBe(200);

      // Byte-for-byte. A signature that is re-encoded is a signature that fails.
      expect(dest.seen).toHaveLength(1);
      expect(dest.seen[0]['stripe-signature']).toBe(STRIPE_SIG);
    } finally {
      await dest.close();
    }
  });

  it('is rejected 400 when replayed with no headers — the pre-fix behaviour', async () => {
    const dest = await signatureVerifyingDestination(STRIPE_SIG);
    try {
      // `headers: {}` is literally what retry.ts sent before this ticket. This asserts
      // the bug was real and that the destination's rejection is what the fix avoids —
      // without it, the test above could pass against a permissive listener.
      const outcome = await realForward({
        destination: `http://127.0.0.1:${dest.port}/hook`,
        headers: {},
        body: ENVELOPE.body,
        requestId: ENVELOPE.requestId,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.responseCode).toBe(400);
      expect(dest.seen[0]['stripe-signature']).toBeUndefined();
    } finally {
      await dest.close();
    }
  });

  it('does not leak an inbound credential to the destination on replay', async () => {
    const dest = await signatureVerifyingDestination(STRIPE_SIG);
    try {
      const storedColumn = filterForwardHeaders(ENVELOPE.headers);
      const outcome = await realForward({
        destination: `http://127.0.0.1:${dest.port}/hook`,
        headers: filterForwardHeaders(readStoredHeaders(storedColumn)),
        body: ENVELOPE.body,
        requestId: ENVELOPE.requestId,
      });

      expect(outcome.ok).toBe(true);
      // The replay is filtered exactly as strictly as a first attempt, never more
      // permissively — the guarantee that makes storing headers acceptable at all.
      expect(dest.seen[0]['x-api-key']).toBeUndefined();
      expect(dest.seen[0]['authorization']).toBeUndefined();
    } finally {
      await dest.close();
    }
  });
});
