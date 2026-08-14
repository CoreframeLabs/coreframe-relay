import type { NextApiRequest, NextApiResponse } from 'next';

import { RelayEnvelopeSchema } from '@coreframe-relay/types';
import { consumeEnvelope } from '@/lib/relay/consume';
import { timingSafeEqualSecrets } from '@/lib/relay/internalAuth';
import { localOnlyVerdict } from '@/lib/relay/localOnly';

/**
 * POST /api/relay/qstash-test — local-only stand-in for the QStash consumer. [RELAY-50]
 *
 * Upstash will not call a loopback URL, so in `wrangler dev` the proxy cannot REACH the
 * real `/api/relay/qstash` endpoint. This endpoint answers instead, validating nothing
 * except the shared local secret and the envelope — and then runs THE EXACT SAME
 * `consumeEnvelope` the real consumer runs, so a fix on the consumer path lands on
 * both. Its only divergence is the auth surface, which is the honest delta:
 *
 *   Production  — `upstash-signature` verified against the current+next signing keys
 *   Local dev   — Bearer `RELAY_API_SECRET`, constant-time, because the proxy and the
 *                 dashboard are two processes on the same box and no third party can
 *                 plausibly present that header
 *
 * ─── [RELAY-72] WHY THE ORIGINAL "never deployed" ARGUMENT WAS WRONG ─────────────────
 *
 * This file used to claim it was "never deployed, because the binding that routes the
 * proxy here (`RELAY_LOCAL_QUEUE_URL`) is never set on a deployed Worker". That is a
 * statement about the PROXY's configuration and says nothing about who can reach the
 * DASHBOARD. `next build` compiles everything under `pages/api/`, so this route shipped
 * in the production bundle, was listed in `middleware.ts`'s unauthenticated allowlist,
 * skipped `verifySignature`, and took its destination straight from a caller-supplied
 * envelope — a forged-envelope injection into the forward path behind one shared secret.
 *
 * Two controls now stand in front of it, and the environment gate runs FIRST so the
 * secret is never even compared on a deployed dashboard:
 *
 *   1. `localOnlyVerdict` — refuses on any deploy platform, and in a production build
 *      off loopback. See `lib/relay/localOnly.ts`.
 *   2. The Bearer compare, now `timingSafeEqualSecrets` — the previous local compare
 *      returned early on a length mismatch and leaked the secret's length by timing.
 *
 * `middleware.ts` also no longer allowlists this path in a production build, so a
 * deployed dashboard has three independent reasons to refuse it.
 */

export const config = { api: { bodyParser: false } };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // FIRST. A deployed dashboard must not compare the secret, must not read the body,
  // and must not distinguish this path from one that was never built.
  const verdict = localOnlyVerdict(req.headers.host);
  if (!verdict.ok) {
    console.error(
      '[relay] qstash-test refused: local-only endpoint reached on a deployed dashboard',
      { reason: verdict.reason }
    );
    return res.status(404).json({ error: 'not_found' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'bad_request' });
  }

  // Bearer-guard (constant-time) before anything is parsed. A bad body is a 400 for
  // the caller and a 401 for everyone else, in that order, so a token probe without
  // a body still answers 401.
  const presented = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqualSecrets(presented, process.env.RELAY_API_SECRET ?? '')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // bodyParser:false so the raw bytes are exactly what was signed — the same reason
  // the real QStash consumer does it.
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'bad_request' });
  }

  const envelope = RelayEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    console.error('[relay] qstash-test: envelope failed schema validation');
    return res.status(400).json({ error: 'bad_request' });
  }

  // Retry counter arrives as the header the proxy sets on its local-loop fetch.
  // QStash supplies `upstash-retried`; when the caller (the smoke test, or a test
  // driving the DLQ path) explicitly sets `x-relay-test-retried`, that value is
  // passed through so the DLQ's final-attempt branch is exercisable locally. The
  // proxy's own delivery never sets this header, so a production-shaped input
  // without it arrives as first attempt = 0, the same as before.
  const retriedRaw = Number.parseInt(
    String(req.headers['x-relay-test-retried'] ?? '0'),
    10
  );
  return consumeEnvelope(envelope.data, retriedRaw, res);
}
