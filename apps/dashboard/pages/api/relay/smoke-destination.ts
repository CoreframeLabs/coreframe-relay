import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * GET|POST /api/relay/smoke-destination — LOCAL-ONLY faux destination for the
 * launch smoke test, [RELAY-66].
 *
 * The smoke test must prove two opposite outcomes through the same delivery
 * pipeline: a destination that answers **500** (drives the message into the DLQ)
 * and one that answers **200** (lets the DLQ retry succeed). `?mode=200` → 200;
 * anything else → 500.
 *
 * No auth, same shape as the RELAY-50 catcher — because the DLQ retry path
 * (RELAY-8) re-reads the route's destination but replays the envelope with
 * EMPTY headers, so any Bearer credential the route was created with cannot
 * reach the retried delivery. An authenticated receiver would be one the smoke
 * test could never redeliver to. The only thing this endpoint can do is answer
 * 200 or 500 to a same-box caller; it writes nothing, reads nothing, and leaks
 * nothing beyond a mode bit. Local-only by construction: a deployed dashboard
 * should NOT carry it (middleware entry notwithstanding).
 */
export const config = { api: { bodyParser: false } };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'bad_request' });
  }

  const mode = Array.isArray(req.query.mode) ? req.query.mode[0] : req.query.mode;

  if (mode === '200') {
    return res.status(200).json({ ok: true, mode: '200' });
  }
  return res.status(500).json({
    ok: false,
    mode: '500',
    note: 'smoke-destination failing on purpose so the DLQ leg has something to prove',
  });
}
