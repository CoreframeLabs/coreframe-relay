import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'node:crypto';

/**
 * GET|POST /api/relay/smoke-destination — a LOCAL-ONLY faux destination for the
 * launch smoke test, [RELAY-66].
 *
 * The smoke test must prove two opposite outcomes through the same delivery
 * pipeline without touching a customer's server: a destination that answers
 * **500** (drives the message into the DLQ) and a destination that answers
 * **200** (lets the DLQ retry succeed). No existing endpoint can play both
 * parts — the RELAY-50 catcher is always-200 by design — so the smoke leg needs
 * this one switchable receiver.
 *
 * Deliberate, LOCAL-only shape, mirroring `qstash-test`'s posture exactly:
 *
 *   - Bearer-guarded by `RELAY_API_SECRET` (constant-time compare). A guessed
 *     URL gets you nothing — same inbound credential model as the consumer.
 *   - `?mode=500` (default) answers **500**; `?mode=200` answers **200**.
 *   - Bodies are NOT logged: a smoke payload is synthetic, but a receiver that
 *     records bodies is a body-store waiting to be pointed at something real.
 *   - Adds nothing to `middleware.ts` — a same-origin consumer sits behind the
 *     session-allowlist boundary the dashboard already applies, and the Bearer
 *     guard is the defense regardless.
 *
 * This endpoint exists because the smoke test CANNOT use a real customer
 * destination and MUST NOT invent a mock pipeline: it drives the actual
 * `consumeEnvelope` → `forwardToDestination` path and only swaps the far end's
 * answer. Sister to `qstash-test.ts` (the local queue stand-in), RELAY-50's
 * catcher (a real inbox for onboarding), and this (a real failure for the DLQ).
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'bad_request' });
  }

  // Guard first, body never read on a 401.
  const presented = String(req.headers.authorization ?? '').replace(
    /^Bearer\s+/i,
    ''
  );
  const expected = process.env.RELAY_API_SECRET ?? '';
  if (!timingSafeCompare(presented, expected)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const mode = Array.isArray(req.query.mode)
    ? req.query.mode[0]
    : req.query.mode;

  if (mode === '200') {
    return res.status(200).json({ ok: true, mode: '200' });
  }

  // Default (and any other value) is the failure leg — the whole point of the
  // endpoint. Named plainly so a log line or curl at it reads honestly.
  return res.status(500).json({ ok: false, mode: '500', note: 'smoke-destination failing on purpose so the DLQ leg has something to prove' });
}
