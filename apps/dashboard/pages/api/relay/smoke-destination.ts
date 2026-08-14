import type { NextApiRequest, NextApiResponse } from 'next';

import { localOnlyVerdict } from '@/lib/relay/localOnly';

/**
 * GET|POST /api/relay/smoke-destination — LOCAL-ONLY faux destination for the
 * launch smoke test, [RELAY-66] / [RELAY-74].
 *
 * The smoke test must prove two opposite outcomes through the same delivery
 * pipeline: a destination that answers **500** (drives the message into the DLQ)
 * and one that answers **200** (lets the DLQ retry succeed). `?mode=200` → 200;
 * anything else → 500.
 *
 * NO BEARER CREDENTIAL, and that is a finding rather than an omission: the DLQ
 * retry path (RELAY-8) re-reads the route's destination but replays the envelope
 * with EMPTY headers, so a Bearer credential set on this route could never reach
 * a retried delivery. `4fcc0bc` removed that guard correctly — it was unreachable
 * dead code — but replaced it with a comment ("must not ship on a deployed
 * dashboard regardless of this allowlist entry") and no control, leaving the
 * endpoint fully open: no auth, no environment check, no host check, and an entry
 * in `middleware.ts`'s unauthenticated allowlist.
 *
 * [RELAY-74] is that promised control. It is an ENVIRONMENT gate, not a credential
 * gate, because the constraint here is *where* this endpoint may answer, not *who*
 * may call it — see `lib/relay/localOnly.ts` for the three arms and why a Host
 * check alone would not be enough. A deployed dashboard answers 404.
 */
export const config = { api: { bodyParser: false } };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // FIRST, before the method check: a deployed dashboard must not even reveal which
  // verbs this endpoint would have accepted. 404 is the same answer Next.js gives for
  // a file that was never built, which is the state this endpoint is meant to be in.
  const verdict = localOnlyVerdict(req.headers.host);
  if (!verdict.ok) {
    console.error(
      '[relay] smoke-destination refused: local-only endpoint reached on a deployed dashboard',
      { reason: verdict.reason }
    );
    return res.status(404).json({ error: 'not_found' });
  }

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
