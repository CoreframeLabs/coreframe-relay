import type { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'node:crypto';

import { RelayEnvelopeSchema } from '@coreframe-relay/types';
import { consumeEnvelope } from '@/lib/relay/consume';

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
 * Never deployed, because the binding that routes the proxy here
 * (`RELAY_LOCAL_QUEUE_URL`) is never set on a deployed Worker. If that invariant ever
 * changes, this file must delete itself.
 */

export const config = { api: { bodyParser: false } };

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'bad_request' });
  }

  // Bearer-guard (constant-time) before anything is parsed. A bad body is a 400 for
  // the caller and a 401 for everyone else, in that order, so a token probe without
  // a body still answers 401.
  const presented = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const expected = process.env.RELAY_API_SECRET ?? '';
  if (!timingSafeCompare(presented, expected)) {
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
  // QStash supplies `upstash-retried`; here there is no retry budget — a local test
  // is ONE attempt, by design, so the counter is clamped to zero.
  return consumeEnvelope(envelope.data, 0, res);
}
