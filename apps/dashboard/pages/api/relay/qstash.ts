import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { Receiver } from '@upstash/qstash';
import { RelayEnvelopeSchema } from '@coreframe-relay/types';

import { forwardToDestination } from '@/lib/relay/forward';
import {
  decryptDestinationHeaders,
  DestinationHeadersKeyError,
  DestinationHeadersTamperError,
} from '@/lib/relay/destinationAuth';
import { recordMetric } from '@/lib/metrics';
import {
  assertRouteBelongsToTeam,
  recordDeliveryAttempt,
} from 'models/delivery';
import { recordDlqItem } from 'models/dlq';
import { fetchRouteForDelivery } from 'models/route';

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

  const { requestId, routeId, teamId, destination, maxRetries, headers, body } =
    envelope.data;

  const retried = Number.parseInt(
    String(req.headers[RETRIED_HEADER] ?? '0'),
    10
  );
  const retriesSoFar = Number.isFinite(retried) && retried >= 0 ? retried : 0;
  const attemptCount = retriesSoFar + 1;
  const isFinalAttempt = retriesSoFar >= maxRetries;

  const payloadSizeB = Buffer.byteLength(body, 'utf8');

  // Tenant check BEFORE the outbound request, not after.
  //
  // Found by running this, not by reading it: with the check left to happen inside the
  // DeliveryLog write, an envelope pairing one team's id with another team's route still
  // caused a real POST to the destination first, and then surfaced as a 500 — which
  // QStash reads as "retry", so it would re-deliver a payload that can never be recorded,
  // for the whole retry budget. 400 instead: the pair is wrong permanently, and no amount
  // of retrying will make it right.
  try {
    await assertRouteBelongsToTeam(teamId, routeId);
  } catch {
    console.error('[relay] qstash: envelope route/team pair does not exist', {
      requestId,
    });
    return res.status(400).json({ error: 'bad_request' });
  }

  // ── [RELAY-59] Decrypt the customer-configured destination auth headers. ─────────
  //
  // The route row, not the envelope, is the source. The envelope's `destination` was
  // pinned at ingestion; the AUTH config lives on the route and may have been changed
  // since. This read is scoped by teamId against the envelope's pair, so a route
  // whose headers were edited mid-flight to belong elsewhere yields nothing.
  //
  // Failure mode: if decryption cannot be completed — key gone, tampered ciphertext —
  // the responsible thing is to record a FAILED row and not POST a half-authenticated
  // payload to a destination that may then trust it. This is loud on purpose; the
  // alternative is silently forwarding without auth and the destination then handing
  // the customer a log of unauthenticated POSTs misattributed to them.
  let destinationHeaders: Record<string, string> = {};
  {
    const route = await fetchRouteForDelivery(teamId, routeId);
    const stored = route?.destinationHeadersEncrypted ?? null;
    if (stored) {
      try {
        destinationHeaders = decryptDestinationHeaders(stored);
      } catch (error) {
        // Purposeful difference: a tamper is recorded as FAILED, not retried — a
        // tampered row will not magically decrypt on the next attempt, and 5xx-ing
        // invites QStash to keep retrying a failure it cannot help with.
        if (error instanceof DestinationHeadersTamperError) {
          await recordDeliveryAttempt({
            teamId,
            routeId,
            requestId,
            status: 'FAILED',
            attemptCount,
            responseCode: null,
            latencyMs: null,
            payloadSizeB,
            deliveredAt: null,
          });
          console.error('[relay] qstash: destination headers tampered or key changed', {
            requestId,
          });
          // 200 here on purpose: this is OUR failure, not QStash's or the destination's,
          // and a non-2xx would drive retries that achieve nothing.
          return res.status(200).json({ status: 'failed', requestId });
        }
        if (error instanceof DestinationHeadersKeyError) {
          // Misconfigured deploy. 500 is correct: another attempt after the env is
          // fixed is the right behaviour.
          throw error;
        }
        throw error;
      }
    }
  }

  const outcome = await forwardToDestination({
    destination,
    headers,
    body,
    requestId,
    // Decrypted only now, only here, only for this request. Never stored, never logged.
    destinationHeaders,
  });

  try {
    // Status reflects where this delivery actually stands, so the feed and the DLQ page
    // agree with each other: DELIVERED, RETRYING while attempts remain, DLQ once the
    // budget is spent. FAILED is reserved for a terminal failure with no DLQ row.
    const status = outcome.ok
      ? 'DELIVERED'
      : isFinalAttempt
        ? 'DLQ'
        : 'RETRYING';

    await recordDeliveryAttempt({
      teamId,
      routeId,
      requestId,
      status,
      attemptCount,
      responseCode: outcome.responseCode,
      latencyMs: outcome.latencyMs,
      payloadSizeB,
      deliveredAt: outcome.ok ? new Date() : null,
    });

    if (outcome.ok) {
      recordMetric('delivery.delivered');
      return res.status(200).json({ status: 'delivered', requestId });
    }

    if (isFinalAttempt) {
      await recordDlqItem({
        teamId,
        routeId,
        requestId,
        failReason: outcome.failReason ?? 'delivery failed',
        attemptCount,
        body,
      });

      recordMetric('delivery.dlq');

      // 200 on purpose: the retry budget is spent and the failure is now durably recorded
      // on our side. Asking QStash to retry again would deliver a payload we have already
      // declared dead.
      return res.status(200).json({ status: 'dlq', requestId });
    }

    recordMetric('delivery.retrying');

    // 502 asks QStash for the next retry. The customer's destination failed; we did not.
    return res.status(502).json({ status: 'retrying', requestId });
  } catch (error) {
    // A failure to WRITE the outcome is our fault, not the destination's, and it must be
    // retried — returning 200 here would lose the delivery record silently, which is the
    // exact failure mode [RELAY-44] exists to catch.
    console.error('[relay] qstash: failed to record delivery', {
      requestId,
      name: error instanceof Error ? error.name : 'unknown',
    });
    return res.status(500).json({ error: 'internal_error' });
  }
}
