import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { Receiver } from '@upstash/qstash';
import { RelayEnvelopeSchema } from '@coreframe-relay/types';

import { consumeEnvelope } from '@/lib/relay/consume';

/**
 * POST /api/relay/qstash — the delivery consumer. [RELAY-5]
 *
 * QStash calls this with the envelope the proxy published at ingestion. This function
 * forwards the payload to the customer's destination, records the outcome in
 * `DeliveryLog`, and on the FINAL attempt writes a `DlqItem`.
 *
 * ─── The four things that make this correct rather than merely working ────────────────
 *
 * 1. **The signature is verified BEFORE the body is parsed**, which is only possible with
 *    the raw bytes — hence `bodyParser: false` below. Next's Pages Router parses JSON by
 *    default and hands you an object; re-serialising that object produces different bytes
 *    (key order, whitespace, unicode escaping) and the signature then never verifies. This
 *    is the single most common way a webhook consumer ends up with signature checking
 *    that is permanently broken, or worse, quietly disabled to "fix" it.
 *
 * 2. **The response status is a control signal, not decoration.** QStash retries on any
 *    non-2xx. So: success → 200; a failure with retries remaining → 502, deliberately, to
 *    ask for the retry; a failure on the final attempt → 200, because the DLQ row is
 *    already written and a further retry would only duplicate work QStash has no way to
 *    know is finished.
 *
 * 3. **Idempotency is the `DeliveryLog.requestId` unique constraint**, handled explicitly
 *    in `models/delivery.ts`. A replayed message updates its row. If that constraint were
 *    allowed to 500, QStash would retry forever against an endpoint that already
 *    delivered.
 *
 * 4. **A DLQ row is written only on the final attempt.** Writing one per failure fills the
 *    DLQ with rows that later succeeded, which makes the whole feature untrustworthy —
 *    an operator cannot act on a queue where most entries are stale.
 */

export const config = {
  api: {
    // Required. See point 1 above — without this the signature can never verify.
    bodyParser: false,
  },
};

/** QStash sets this to the number of retries ALREADY performed: 0 on the first attempt. */
const RETRIED_HEADER = 'upstash-retried';

async function readRawBody(readable: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Verify the QStash signature over the exact bytes received.
 *
 * Fails closed when the signing keys are absent: an unsigned request must never be
 * accepted because the environment happens to be misconfigured. Note this endpoint is
 * publicly reachable — it is in `middleware.ts`'s unauthenticated allowlist by necessity —
 * so this check is the only thing between the open internet and our forwarding path.
 */
async function verifySignature(
  rawBody: string,
  signature: string
): Promise<boolean> {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey || !nextSigningKey || !signature) {
    return false;
  }

  const receiver = new Receiver({ currentSigningKey, nextSigningKey });

  try {
    // `url` is intentionally NOT passed. QStash signs the destination URL in the `sub`
    // claim, and the URL this function sees behind a tunnel or a platform proxy is not
    // byte-identical to the one QStash was given — a mismatch there would reject every
    // genuine message. The body hash and the key signature are still fully verified; what
    // is given up is binding a message to one specific URL of ours. Revisit when
    // [RELAY-42] fixes a stable public hostname.
    return await receiver.verify({ signature, body: rawBody });
  } catch {
    // A bad signature throws rather than returning false. Nothing about the payload is
    // logged here — a 401 path that logs the body is a way to get unauthenticated content
    // into our logs.
    return false;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'bad_request' });
  }

  const rawBody = await readRawBody(req);
  const signature =
    (req.headers['upstash-signature'] as string | undefined) ?? '';

  if (!(await verifySignature(rawBody, signature))) {
    console.warn('[relay] qstash: signature verification failed');
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Only now is the body trusted enough to parse.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'bad_request' });
  }

  const envelope = RelayEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    // 400, not 200. A structurally invalid envelope can never be delivered, but it also
    // cannot be logged against a route — there is no trustworthy routeId to write it to,
    // so there is no honest DeliveryLog row to create. Returning non-2xx at least makes
    // it visible in QStash's own failure surface instead of vanishing. If this ever fires
    // in practice it is a proxy bug, not a customer one.
    console.error('[relay] qstash: envelope failed schema validation');
    return res.status(400).json({ error: 'bad_request' });
  }

  // The delivery half is shared with the local-only `qstash-test` endpoint
  // ([RELAY-50]) — one code path, one place a fix lands.
  const retriedRaw = Number.parseInt(
    String(req.headers[RETRIED_HEADER] ?? '0'),
    10
  );
  return consumeEnvelope(envelope.data, retriedRaw, res);

}
