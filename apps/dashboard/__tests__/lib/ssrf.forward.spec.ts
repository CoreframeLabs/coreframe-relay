/**
 * @jest-environment node
 */

/**
 * [RELAY-33] / gate condition S4 — the SSRF validator runs at FORWARD time.
 *
 * ─── WHY THIS IS A SEPARATE FILE ─────────────────────────────────────────────────────
 *
 * `destinationAuth.forward.spec.ts` doubles the SSRF seam, because its subject is what
 * travels on the wire and there is no address a test listener can bind that the real
 * validator allows. This file is the other half of that trade and it mocks NOTHING. If
 * the `validateDestination` call in `lib/relay/forward.ts` were deleted, this file goes
 * red and its neighbour would not. That is the entire reason it exists — read the block
 * comment at the top of the neighbouring file before changing either.
 *
 * ─── WHAT S4 ACTUALLY ASKS ───────────────────────────────────────────────────────────
 *
 * "A route edited to 169.254.169.254 AFTER ingest is refused at forward." The
 * distinguishing property of a forward-time control is that ingest has already passed:
 * the payload was accepted and queued against whatever the destination was then, and the
 * destination is editable in between. Every DLQ replay has the same shape, because a
 * replay starts from a stored envelope.
 *
 * Until RELAY-33 the forward path ran `DestinationUrlSchema` — "is this an absolute
 * http(s) URL?" — which `http://169.254.169.254/latest/meta-data/` passes, because it is
 * one. That is the exact request the cases below now refuse.
 *
 * Assertions are on the LISTENER, not only on the outcome, wherever a listener exists. A
 * refusal that still opened the connection would satisfy an outcome-only assertion and
 * leak the request anyway.
 */

import http from 'node:http';

import { forwardToDestination } from '@/lib/relay/forward';

/** A listener that answers 200 to anything — so a reachable destination is unambiguous. */
function alwaysOk(): Promise<{
  port: number;
  seen: number;
  close: () => Promise<void>;
}> {
  const state = { seen: 0 };
  const server = http.createServer((_req, res) => {
    state.seen += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('server.listen produced a non-TCP address'));
        return;
      }
      resolve({
        port: address.port,
        get seen() {
          return state.seen;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('[RELAY-33] forward-time SSRF refusal', () => {
  const internal: Array<[string, string]> = [
    ['cloud metadata (the S4 address)', 'http://169.254.169.254/latest/meta-data/'],
    ['RFC-1918', 'http://10.1.2.3/hook'],
    ['loopback by name', 'http://localhost:9/hook'],
    ['IPv4-mapped metadata', 'http://[::ffff:169.254.169.254]/hook'],
    ['link-local by any path', 'http://169.254.169.254/'],
  ];

  it.each(internal)('refuses a %s destination at forward time', async (_label, destination) => {
    const outcome = await forwardToDestination({
      destination,
      headers: {},
      body: '{}',
      requestId: 'c2c4d4a0-0000-4000-8000-00000000000a',
    });

    expect(outcome.ok).toBe(false);
    // `null`, not a status: nothing was sent, so there is no status to report.
    expect(outcome.responseCode).toBeNull();
    expect(outcome.failReason).toMatch(/^destination rejected: /);
  });

  it('refuses a loopback destination a LIVE listener is waiting on — nothing crosses', async () => {
    // The strongest form of the assertion: a destination that WOULD have answered 200.
    // Under the pre-RELAY-33 shape-only check this test sees a request; it must see none.
    const dst = await alwaysOk();

    const outcome = await forwardToDestination({
      destination: `http://127.0.0.1:${dst.port}/hook`,
      headers: {},
      body: '{}',
      requestId: 'c2c4d4a0-0000-4000-8000-00000000000b',
      destinationHeaders: { authorization: 'Bearer never-used' },
    });

    const seen = dst.seen;
    await dst.close();

    expect(outcome.ok).toBe(false);
    expect(outcome.failReason).toMatch(/^destination rejected: /);
    // No connection was made at all — not a rejected one, none.
    expect(seen).toBe(0);
  });

  it('the smoke waiver does not widen to arbitrary loopback, even for a test envelope', async () => {
    // `isTest` is not a skeleton key. The waiver is scoped to loopback on port 4002 —
    // [RELAY-66]'s smoke destination on the local dashboard — and a test-marked envelope
    // pointed anywhere else on loopback is refused exactly like a real one.
    const dst = await alwaysOk();

    const outcome = await forwardToDestination({
      destination: `http://127.0.0.1:${dst.port}/hook`,
      headers: {},
      body: '{}',
      requestId: 'c2c4d4a0-0000-4000-8000-00000000000c',
      isTest: true,
    });

    const seen = dst.seen;
    await dst.close();

    expect(outcome.ok).toBe(false);
    expect(seen).toBe(0);
  });

  it('a test envelope cannot reach cloud metadata by claiming to be a smoke test', async () => {
    const outcome = await forwardToDestination({
      destination: 'http://169.254.169.254/latest/meta-data/',
      headers: {},
      body: '{}',
      requestId: 'c2c4d4a0-0000-4000-8000-00000000000d',
      isTest: true,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failReason).toMatch(/^destination rejected: /);
  });

  it('never echoes the rejected destination back in the failure reason', async () => {
    // The reason is persisted onto a DeliveryLog row and shown in the UI. It names the
    // failure CODE; the host is the customer's private infrastructure.
    const outcome = await forwardToDestination({
      destination: 'http://10.1.2.3/secret-internal-path',
      headers: {},
      body: '{}',
      requestId: 'c2c4d4a0-0000-4000-8000-00000000000e',
    });

    expect(outcome.failReason).not.toContain('10.1.2.3');
    expect(outcome.failReason).not.toContain('secret-internal-path');
  });
});
