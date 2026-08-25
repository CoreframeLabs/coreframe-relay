/**
 * @jest-environment node
 */

/**
 * [RELAY-111] Relay's own forward timeout must not undercut n8n's documented ceiling.
 *
 * ─── The bug this file exists to keep fixed ───────────────────────────────────────────
 *
 * `docs/integrations/n8n.md` tells buyers n8n Cloud enforces a hard 100-second
 * Cloudflare timeout on webhook responses — meaning a real, legitimate n8n workflow can
 * take tens of seconds to finish. `lib/relay/forward.ts`'s own forward timeout used to be
 * 10 seconds (`DEFAULT_TIMEOUT_MS`), aborting and recording FAILED/DLQ on a workflow that
 * n8n itself would have let run to completion. That was verified against `webhook.site`
 * only, never against a slow-but-real destination — the earlier RETRYING investigation's
 * own named gap.
 *
 * This suite proves the fix against a REAL, slow HTTP destination (a live local listener
 * that delays its response, not a mocked timer): a delay that would have failed under the
 * OLD 10-second value now succeeds under the NEW default, and — for direct before/after
 * proof rather than a claim — the exact same delay is shown failing when the literal old
 * value is passed explicitly.
 *
 * These tests are deliberately slow (real waits of ~10-12s each) because the whole point
 * is to exercise the actual configured value, not a scaled-down stand-in nobody hits in
 * production.
 */

import http from 'node:http';

import { forwardToDestination } from '@/lib/relay/forward';

// Relative, not the `@/` alias — see destinationAuth.forward.spec.ts next door for why
// jest.mock's hoisted specifier needs this. Same narrow loopback-only double: delegates
// to the real SSRF validator for everything except the throwaway 127.0.0.1 listener this
// file creates, so this suite still proves nothing about SSRF (ssrf.forward.spec.ts does)
// but also doesn't get blocked from reaching its own real localhost server.
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

/**
 * A throwaway HTTP server standing in for a slow-but-legitimate n8n workflow: it accepts
 * the request immediately (proving Relay's fetch connected fine) and only writes the
 * response after `delayMs` — simulating n8n's Webhook trigger in "When Last Node
 * Finishes" mode taking real time to run the workflow before answering.
 */
function slowDestination(delayMs: number): Promise<{
  port: number;
  requestCount: () => number;
  close: () => Promise<void>;
}> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    const timer = setTimeout(() => {
      // The client (Relay's AbortController) may already have torn the connection
      // down by the time this fires in the "old timeout" test — guard the write so a
      // late response after an aborted request doesn't throw inside the server and
      // fail the test with an unrelated error.
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ranForMs: delayMs }));
      }
    }, delayMs);
    res.on('close', () => clearTimeout(timer));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) {
        resolve({
          port: address.port,
          requestCount: () => requests,
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

describe('RELAY-111 — forward timeout respects n8n\'s documented 100s ceiling', () => {
  // A destination that takes 12 seconds to answer: past the OLD 10s default (would have
  // failed), comfortably inside n8n's own documented 100s window and the NEW 110s
  // default (should succeed).
  const SLOW_DELAY_MS = 12_000;

  it(
    'the OLD 10-second value (passed explicitly, matching the literal previous default) times out against a 12s-slow destination',
    async () => {
      const dst = await slowDestination(SLOW_DELAY_MS);

      const outcome = await forwardToDestination({
        destination: `http://127.0.0.1:${dst.port}/webhook`,
        headers: {},
        body: JSON.stringify({ event: 'stripe.charge.succeeded' }),
        requestId: 'c2c4d4a0-0111-4000-8000-000000000001',
        timeoutMs: 10_000, // the literal old DEFAULT_TIMEOUT_MS
      });

      await dst.close();

      expect(outcome.ok).toBe(false);
      expect(outcome.responseCode).toBeNull();
      expect(outcome.failReason).toBe('destination timed out after 10000ms');
      // Real measured latency, not a mocked clock: proves the abort actually fired
      // around 10s, not instantly and not after the full 12s delay.
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(10_000);
      expect(outcome.latencyMs).toBeLessThan(SLOW_DELAY_MS);
    },
    20_000
  );

  it(
    'the NEW default (110s, no timeoutMs override) succeeds against the SAME 12s-slow destination that the old value would have failed',
    async () => {
      const dst = await slowDestination(SLOW_DELAY_MS);

      // No `timeoutMs` passed — this exercises the real DEFAULT_TIMEOUT_MS /
      // RELAY_FORWARD_TIMEOUT_MS fallback in forward.ts, not a test-only stand-in.
      const outcome = await forwardToDestination({
        destination: `http://127.0.0.1:${dst.port}/webhook`,
        headers: {},
        body: JSON.stringify({ event: 'stripe.charge.succeeded' }),
        requestId: 'c2c4d4a0-0111-4000-8000-000000000002',
      });

      expect(dst.requestCount()).toBe(1);
      await dst.close();

      expect(outcome.ok).toBe(true);
      expect(outcome.responseCode).toBe(200);
      expect(outcome.failReason).toBeNull();
      // The forward genuinely waited out the full 12s delay rather than aborting early.
      expect(outcome.latencyMs).toBeGreaterThanOrEqual(SLOW_DELAY_MS);
    },
    20_000
  );

  it(
    'RELAY_FORWARD_TIMEOUT_MS still overrides the default when explicitly set',
    async () => {
      const dst = await slowDestination(2_000);
      process.env.RELAY_FORWARD_TIMEOUT_MS = '500';

      try {
        const outcome = await forwardToDestination({
          destination: `http://127.0.0.1:${dst.port}/webhook`,
          headers: {},
          body: '{}',
          requestId: 'c2c4d4a0-0111-4000-8000-000000000003',
        });

        expect(outcome.ok).toBe(false);
        expect(outcome.failReason).toBe('destination timed out after 500ms');
        expect(outcome.latencyMs).toBeGreaterThanOrEqual(500);
        expect(outcome.latencyMs).toBeLessThan(2_000);
      } finally {
        delete process.env.RELAY_FORWARD_TIMEOUT_MS;
        await dst.close();
      }
    },
    10_000
  );
});
