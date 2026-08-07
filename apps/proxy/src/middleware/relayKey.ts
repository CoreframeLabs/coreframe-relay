import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../types/bindings.js';

/** Header the caller must present. Named by the [RELAY-4] acceptance criteria. */
export const RELAY_KEY_HEADER = 'x-relay-key';

/**
 * Constant-time string comparison.
 *
 * Workers has no `crypto.timingSafeEqual` — that is a Node API, and this runs on V8
 * isolates. So the comparison is done over SHA-256 digests of the two values rather than
 * over the raw bytes. Two properties fall out of that, and both are the reason it is done
 * this way instead of a byte loop with an early length check:
 *
 *   1. The digests are always 32 bytes, so the loop length is independent of the secret's
 *      length. A raw comparison leaks the secret's length through timing before it leaks
 *      anything else.
 *   2. Neither input can be recovered from the value being compared.
 *
 * The loop itself accumulates with `|=` and never returns early, so it runs the same
 * number of operations whether the first byte differs or none do.
 */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);

  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);

  let diff = va.length ^ vb.length;
  for (let i = 0; i < va.length; i++) {
    diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * The pure check, extracted for [RELAY-57] so the ingestion route can run it inline
 * only on the header-credentialed path. A path-token request never reaches this.
 *
 * Returned as a discriminated result rather than thrown: the caller chooses its own
 * status code, and a 401 here must stay shaped exactly like RELAY-4's 401 so a sender
 * mid-migration cannot tell which arm answered it.
 */
export async function verifyRelayKey(
  env: { RELAY_API_SECRET?: string },
  req: Request
): Promise<{ ok: true } | { ok: false; code: 'misconfigured' | 'unauthorized' }> {
  const expected = env.RELAY_API_SECRET;

  if (!expected) {
    // A proxy with no secret configured must refuse everything rather than fail open.
    return { ok: false, code: 'misconfigured' };
  }

  const presented = req.headers.get(RELAY_KEY_HEADER);

  // Compared even when absent, against a value of the same shape, so that a missing
  // header and a wrong header take the same path and the same time.
  const ok = await timingSafeEqualStrings(presented ?? '', expected);
  return ok ? { ok: true } : { ok: false, code: 'unauthorized' };
}

/**
 * Authenticate an inbound webhook against the shared `RELAY_API_SECRET`.
 *
 * [RELAY-57]: this middleware is STILL the auth on every OTHER proxy route. Only the
 * ingest route moved off it, because a required custom header is unusable for
 * Stripe/Shopify/GitHub/Meta — none of them let you set one on an outbound webhook.
 * The migration keeps both accepted; this export remains so health and any future
 * non-ingest routes keep a single auth path.
 *
 * Failure responses carry no detail beyond "unauthorized": telling a caller whether the
 * header was absent or merely wrong is a free bit of information for a brute-forcer.
 */
export const relayKey = createMiddleware<AppEnv>(async (c, next) => {
  const result = await verifyRelayKey(c.env, c.req.raw);
  if (!result.ok) {
    if (result.code === 'misconfigured') {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'proxy.misconfigured',
          requestId: c.get('requestId'),
          reason: 'RELAY_API_SECRET is not set',
        })
      );
      throw new HTTPException(503, { message: 'proxy not configured' });
    }
    throw new HTTPException(401, { message: 'unauthorized' });
  }

  await next();
});
