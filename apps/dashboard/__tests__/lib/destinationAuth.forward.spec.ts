/**
 * @jest-environment node
 */

/**
 * [RELAY-59] End-to-end against a real local HTTP destination.
 *
 * A live server is stood up INSIDE the test on a random localhost port rather than
 * mocked, because the entire question this ticket answers is "does the value on the
 * wire match the value the customer configured — and does the document that REQUIREs
 * a bearer token answer 2xx when handed one and 4xx without one". A mock would only
 * prove what we chose to send; a listener proves what travels.
 *
 * Four statements this suite makes, each named against an acceptance criterion:
 *
 *   1. A route with a configured bearer token delivers 2xx to a destination that
 *      rejects anything without it. (AC e2e.)
 *   2. The configured `authorization` value arrives byte-for-byte. (AC e2e, again.)
 *   3. An INBOUND `authorization` header the SENDER set is refused at the proxy's
 *      boundary and never rides the envelope to the consumer. (AC: "inbound
 *      Authorization still cannot pass through".)
 *   4. A `cookie` header the customer attempts to configure is refused at write time.
 *      (AC: "allows exactly the configured headers and nothing else".)
 */

import http from 'node:http';

import { forwardToDestination } from '@/lib/relay/forward';
import { encryptDestinationHeaders } from '@/lib/relay/destinationAuth';

const KEY =
  '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

beforeEach(() => {
  process.env.RELAY_DESTINATION_HEADERS_KEY = KEY;
});
afterEach(() => {
  delete process.env.RELAY_DESTINATION_HEADERS_KEY;
});

/**
 * ⚠ WHY THE SSRF SEAM IS DOUBLED IN THIS FILE — [RELAY-33]. READ BEFORE EDITING.
 *
 * This suite stands up a real listener on a random LOOPBACK port, because its whole
 * subject is "what value travels on the wire". [RELAY-33] made the forward path run the
 * real SSRF validator instead of the shape-only stand-in, and the real validator blocks
 * loopback — which is exactly the ticket's point. So every test here began failing at the
 * destination check, having asserted nothing about headers.
 *
 * The failure was correct. There is no address a test can bind that the validator allows:
 * loopback, RFC-1918 and link-local are all blocked, and anything it does allow is, by
 * construction, not local. So one of three things has to give, and only one is acceptable:
 *
 *   ✗ Weaken the validator, or add a `skipSsrf` flag / env var to `forwardToDestination`.
 *     That is the precise shape [RELAY-73] just spent a ticket deleting from the proxy: a
 *     security control switched off by configuration, with production safety resting on a
 *     variable happening to be unset. A door added for a test is still a door.
 *   ✗ Route the tests through the production smoke waiver (loopback + port 4002 +
 *     `isTest`). Tried and rejected: it pins the suite to the dashboard's own dev port, so
 *     the tests fail to bind whenever `next dev` is running — measured, not theorised.
 *   ✓ Double the COLLABORATOR in this file only, and assert the real one, unmocked, in
 *     `ssrf.forward.spec.ts` next door.
 *
 * The double below is deliberately narrow: it delegates every decision to the real
 * validator and overrides it for nothing except `127.0.0.1` on an ephemeral port — the
 * throwaway listener these tests create and nothing else. `169.254.169.254`, `10.0.0.0/8`,
 * `localhost` and every other blocked form are still refused inside this file.
 *
 * What this costs, stated plainly: this file no longer proves the forward path is
 * SSRF-guarded. `ssrf.forward.spec.ts` does, against the real module, including the case
 * where a live listener is waiting and must never be reached. Delete the validator call in
 * `forward.ts` and that file goes red — this one would not. That split is why it exists.
 *
 * [RELAY-33] UPDATE: `forward.ts` now calls `resolveAndValidateDestination` (the
 * DNS-resolving layer), not `validateDestination` directly — closing the DNS-rebinding
 * gap. The override below widens BOTH functions identically, for the exact same reason
 * and the exact same narrow scope: `resolveAndValidateDestination` runs the literal check
 * first and would otherwise reject this suite's real `127.0.0.1` listener as loopback
 * exactly like `validateDestination` did before this file's original double existed.
 */
// Relative, not the `@/` alias: jest's resolver applies the alias to IMPORTS but not to
// `jest.mock`'s hoisted specifier. Both forms resolve to the same file, so the module
// registry entry `forward.ts` reads is the one replaced here.
jest.mock('../../lib/relay/ssrfGap', () => {
  const actual = jest.requireActual('../../lib/relay/ssrfGap');

  // The listener this file creates: literal 127.0.0.1, ephemeral port. Nothing else.
  // Returns `null` (never widens) for anything that is not exactly that shape.
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

/**
 * A throwaway HTTP server that returns 200 only when the caller presents the EXACT
 * bearer token configured. Counts every request received and records the headers seen.
 *
 */
function requireBearer(expectedToken: string): Promise<{
  port: number;
  seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}> {
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers });
    const auth = String(req.headers.authorization ?? '');
    if (auth === `Bearer ${expectedToken}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'missing-or-wrong-token' }));
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
          close: () =>
            new Promise<void>((r) => {
              server.close(() => r());
            }),
        });
      } else {
        reject(new Error('server.listen produced a non-TCP address'));
      }
    });
  });
}

describe('forwardToDestination — the RELAY-59 end-to-end', () => {
  it('delivers 2xx to a bearer-requiring destination when the route carries the token', async () => {
    const token = 'sk_test_51_abc123_' + 'x'.repeat(200); // plausibly CRM-shaped
    const dst = await requireBearer(token);

    const outcome = await forwardToDestination({
      destination: `http://127.0.0.1:${dst.port}/hook`,
      headers: {},
      body: JSON.stringify({ event: 'ping' }),
      requestId: 'c2c4d4a0-0000-4000-8000-000000000001',
      // These are the decrypted-at-forward-time headers qstash.ts hands over.
      destinationHeaders: { authorization: `Bearer ${token}` },
    });

    await dst.close();

    expect(outcome.ok).toBe(true);
    expect(outcome.responseCode).toBe(200);
    expect(dst.seen).toHaveLength(1);
    expect(String(dst.seen[0].headers.authorization)).toBe(`Bearer ${token}`);
    expect(String(dst.seen[0].headers['relay-request-id'])).toBe(
      'c2c4d4a0-0000-4000-8000-000000000001'
    );
  });

  it('delivers 401 to the same destination when the route carries no token at all', async () => {
    const dst = await requireBearer('token-route-needs');

    const outcome = await forwardToDestination({
      destination: `http://127.0.0.1:${dst.port}/hook`,
      headers: {},
      body: JSON.stringify({ event: 'ping' }),
      requestId: 'c2c4d4a0-0000-4000-8000-000000000002',
    });

    await dst.close();

    expect(outcome.ok).toBe(false);
    expect(outcome.responseCode).toBe(401);
    // The destination SAW the request and rejected it — this is what tells an
    // operator their auth config was forgotten. A silent swallow here would be a
    // ticket waiting to be filed.
    expect(dst.seen).toHaveLength(1);
    expect(dst.seen[0].headers.authorization).toBeUndefined();
  });

  it('an INBOUND authorization header never crosses — even when a destination header is also set', async () => {
    // The customer has configured their CRM token. The SENDER now sends a webhook
    // with `authorization: Bearer sender-secret` — perhaps Stripe, perhaps an
    // attacker. The invariant the AC is about: the SENDER'S value never crosses.
    const routeToken = 'sk_live_CUSTOMER_TOKEN';
    const senderToken = 'Bearer SOME_SENDER_SECRET_THAT_MUST_NOT_LEAK';
    const dst = await requireBearer(routeToken);

    const outcome = await forwardToDestination({
      destination: `http://127.0.0.1:${dst.port}/hook`,
      // What `forwardableHeaders` in the proxy would have produced for an inbound
      // request that DID carry authorization. The proxy already strips it — but even
      // if it leaked through, this holder must not pass it on.
      headers: {
        authorization: senderToken,
        cookie: 'session=hijack-attempt',
        'x-custom': 'some-header-the-sender-set',
      },
      body: JSON.stringify({ event: 'ping' }),
      requestId: 'c2c4d4a0-0000-4000-8000-000000000003',
      destinationHeaders: { authorization: `Bearer ${routeToken}` },
    });

    await dst.close();

    expect(outcome.ok).toBe(true);
    expect(outcome.responseCode).toBe(200);
    expect(String(dst.seen[0].headers.authorization)).toBe(`Bearer ${routeToken}`);
    expect(dst.seen[0].headers.cookie).toBeUndefined();
    // The relay's own secret header is never forwarded.
    expect(dst.seen[0].headers['x-relay-key']).toBeUndefined();
    // Non-denied inbound headers DO pass — signatures are how receivers verify.
    expect(String(dst.seen[0].headers['x-custom'])).toBe('some-header-the-sender-set');
  });

  it('a header not on the allowed write list cannot reach the wire even via a hand-edited DB row', async () => {
    // Write-time validation would refuse these. But a hand edit or a bug in the
    // writer is precisely the state we must not silently forward.
    const dst = await requireBearer('unused');

    const outcome = await forwardToDestination({
      destination: `http://127.0.0.1:${dst.port}/hook`,
      headers: {},
      body: '{}',
      requestId: 'c2c4d4a0-0000-4000-8000-000000000004',
      destinationHeaders: {
        'x-relay-key': 'should-not-cross',
        cookie: 'session=abc',
        'proxy-authorization': 'Basic abc',
      },
    });

    await dst.close();

    // The forward still happens — the route itself is reachable — but the wire headers
    // carry NONE of the denied names. If any of them crossed, the "everything else is
    // refused" guarantee is broken even when the failure starts inside our own DB.
    expect(dst.seen).toHaveLength(1);
    expect(dst.seen[0].headers['x-relay-key']).toBeUndefined();
    expect(dst.seen[0].headers.cookie).toBeUndefined();
    expect(dst.seen[0].headers['proxy-authorization']).toBeUndefined();
    expect(outcome.responseCode).toBe(401); // because no real auth crossed
  });

  it('never throws on a destination that does not resolve — it returns a ForwardOutcome with latencyMs', async () => {
    // Not RELAY-59's concern directly, but every path the forwarder is wired into must
    // hold this: a return, never a throw. QStash reads the difference as retry-vs-dead.
    const outcome = await forwardToDestination({
      // TEST-NET-2, not TEST-NET-1. [RELAY-33]'s validator blocks 192.0.0.0/16 (its
      // `a === 192 && b === 0` arm), which swallows RFC 5737's 192.0.2.0/24 — so the old
      // address was refused at the destination check and never measured a timeout at all.
      // 198.51.100.0/24 is equally unroutable and is not in any blocked range.
      destination: 'http://198.51.100.1/', // RFC 5737 TEST-NET-2 — never routable
      headers: {},
      body: '{}',
      requestId: 'c2c4d4a0-0000-4000-8000-000000000005',
      timeoutMs: 250,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(250);
  });
});

describe('the stored form cannot be replayed without the key', () => {
  it('a JSON dump of the column contains no plaintext token', () => {
    process.env.RELAY_DESTINATION_HEADERS_KEY = KEY;
    const stored = encryptDestinationHeaders({
      authorization: 'Bearer sk_live_EXFILTRATE_ME',
      'x-api-key': 'LET_ME_OUT',
    });
    const dumped = JSON.stringify(stored);
    // A "strings dumped.json | grep Bearer" breach must yield nothing.
    expect(dumped).not.toContain('Bearer');
    expect(dumped).not.toContain('sk_live_EXFILTRATE_ME');
    expect(dumped).not.toContain('LET_ME_OUT');
    // And it must not look derivable either: no IV/ct/tag substring coincidentally
    // decodes to the token.
    expect(dumped).not.toMatch(/EXFILTRATE/i);
    expect(dumped).not.toMatch(/LET_ME/i);
  });
});
