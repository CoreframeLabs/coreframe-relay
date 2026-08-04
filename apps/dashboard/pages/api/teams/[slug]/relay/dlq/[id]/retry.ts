import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { RelayEnvelopeSchema } from '@coreframe-relay/types';
import type { RelayEnvelope } from '@coreframe-relay/types';
import { RELAY_REQUEST_ID_HEADER } from '@coreframe-relay/types/internal';

import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import {
  claimDlqRetry,
  fetchDlqItemForTeam,
  readStoredBody,
  releaseDlqRetryClaim,
} from 'models/dlq';
import { recordAuditEvent } from '@/lib/audit';
// The ONE line [RELAY-33] swaps for the shared package, exactly as `lib/relay/forward.ts`
// does it. Read `lib/relay/ssrfGap.ts` before treating this call as protection: today it
// is shape-only. It is imported anyway — and deliberately not re-implemented here —
// because a second copy of security-critical logic that drifts is worse than one honest
// gap, and because when RELAY-33 lands this call site becomes correct for free.
import { validateDestination } from '@/lib/relay/ssrfGap';
import type { AppEvent } from 'types';

/**
 * POST /api/teams/:slug/relay/dlq/:id/retry — republish a dead webhook to QStash. [RELAY-8]
 *
 * This is the most dangerous endpoint on the DLQ page: it causes a customer's payload to
 * be sent to a customer's endpoint, on an operator's say-so, from a stored record. Five
 * controls sit here, in this order, and the ORDER is the design.
 *
 *  1. **Tenant check before anything else.** The item is fetched with `teamId` in the
 *     WHERE, so an id belonging to another team is a 404 and the function stops. [RELAY-5]
 *     found a real defect of exactly this shape on the consumer path — with the tenant
 *     check left until the write, a cross-tenant envelope produced an actual POST to the
 *     destination *first* and only then failed. Verify ownership, then act; never the
 *     other way round.
 *
 *  2. **Refuse items whose body was never retained.** Over-`MAX_INLINE_PAYLOAD_BYTES`
 *     payloads are stored neither inline nor by key (see `retainBody` in `models/dlq.ts` —
 *     there is no object storage yet), so there is literally nothing to republish. This
 *     answers 422 and the UI disables the button, rather than offering an action that
 *     silently does nothing.
 *
 *  3. **SSRF re-validated at retry time**, through `lib/relay/ssrfGap.ts`. The destination
 *     is read live from the route, not from the DLQ row, precisely because it can be
 *     edited between the failure and the retry — which is the window the gap notice calls
 *     out by name.
 *
 *  4. **Idempotent by atomic claim.** See `claimDlqRetry`. A double-click or two operators
 *     clicking at once must not double-deliver.
 *
 *  5. **Audited.** Every claim that reaches the publish stage writes an `AuditLog` row
 *     carrying the outcome, including failures. An audit trail with a hole in it is the
 *     thing this product is sold on not having.
 */

/**
 * The audit event name.
 *
 * **A cast, and an ugly one, for a boundary reason rather than a technical one.**
 * `recordAuditEvent` types `event` as `AppEvent`, a closed union in `types/base.ts` — a
 * file outside this ticket's file boundary, which two other agents are working around
 * right now. The `AuditLog.event` COLUMN is a plain string by deliberate design (see
 * `lib/audit.ts`: "a migration should not be the cost of recording a new kind of event"),
 * so the row written is correct and complete; only the compile-time union is short a
 * member. The fix is one line adding `| 'dlq.retried'` to `AppEvent`, after which this
 * constant becomes a plain literal. Flagged in the dev log so it is not left to rot.
 */
const DLQ_RETRIED_EVENT = 'dlq.retried' as unknown as AppEvent;

/** Ceiling on the publish call. QStash is a dependency, not an excuse to hang a request. */
const PUBLISH_TIMEOUT_MS = 5_000;

/** Where QStash delivers the republished envelope — the same consumer [RELAY-5] built. */
const QSTASH_CALLBACK_PATH = '/api/relay/qstash';

const idSchema = z.string().uuid();

/**
 * Outcome of a publish, classified by how much we actually know.
 *
 * The distinction between `rejected` and `unknown` is the whole point of this type.
 * `rejected` means QStash answered and refused — nothing was queued, so the retry claim is
 * safe to give back. `unknown` means we never got an answer: the request may have landed.
 * Releasing a claim there could produce a second delivery of a payload the customer has
 * already received, which is the one outcome worse than an item stuck in a retried state
 * that an operator can see.
 */
type PublishResult =
  | { kind: 'published'; messageId: string | null }
  | { kind: 'not_configured' }
  | { kind: 'rejected'; status: number }
  | { kind: 'unknown'; reason: string };

/**
 * Publish an envelope to QStash.
 *
 * Plain `fetch` against the documented REST shape, mirroring `apps/proxy/src/services/
 * qstash.ts` — which was verified against the live API (a successful publish answers
 * **201**, not 200, hence the `res.ok` range check rather than `=== 200`). The dashboard
 * does carry `@upstash/qstash`, but only for `Receiver.verify`: signature verification
 * against a rotating key pair is worth a dependency, and appending a URL to a path is not.
 *
 * The destination URL is appended UNENCODED. That is what Upstash's own curl example
 * does, and encoding it produces a 400.
 */
async function publishToQStash(
  envelope: RelayEnvelope
): Promise<PublishResult> {
  const base = process.env.UPSTASH_QSTASH_URL;
  const token = process.env.UPSTASH_QSTASH_TOKEN;
  // `RELAY_DASHBOARD_URL` is what the proxy calls the same value; `APP_URL` is BoxyHQ's
  // own name for this app's public origin. Preferring the explicit one and falling back
  // keeps a single-app local setup working without a duplicated variable.
  const dashboard = process.env.RELAY_DASHBOARD_URL || process.env.APP_URL;

  if (!base || !token || !dashboard) {
    return { kind: 'not_configured' };
  }

  const callback = new URL(QSTASH_CALLBACK_PATH, dashboard).toString();
  const publishUrl = `${base.replace(/\/+$/, '')}/v2/publish/${callback}`;

  let res: Response;
  try {
    res = await fetch(publishUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'Upstash-Retries': String(envelope.maxRetries),
        // Reaches the consumer as `relay-request-id`, which is how one webhook stays
        // correlated across proxy → QStash → consumer → DeliveryLog row.
        [`Upstash-Forward-${RELAY_REQUEST_ID_HEADER}`]: envelope.requestId,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
  } catch (error) {
    // Name only, never the message: a fetch error message can carry the full URL, and
    // that URL is built from a token-bearing base in some deployments.
    return {
      kind: 'unknown',
      reason: error instanceof Error ? error.name : 'unknown',
    };
  }

  if (!res.ok) {
    return { kind: 'rejected', status: res.status };
  }

  try {
    const body = (await res.json()) as { messageId?: string };
    return { kind: 'published', messageId: body.messageId ?? null };
  } catch {
    // The message is durable the moment QStash returns 2xx. Failing to parse the id is
    // cosmetic and must not turn a successful publish into a reported failure.
    return { kind: 'published', messageId: null };
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    await throwIfNoTeamAccess(req, res);

    switch (req.method) {
      case 'POST':
        await handlePOST(req, res);
        break;
      default:
        res.setHeader('Allow', 'POST');
        res.status(405).json({
          error: { message: `Method ${req.method} Not Allowed` },
        });
    }
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;
    res.status(status).json({ error: { message } });
  }
}

const handlePOST = async (req: NextApiRequest, res: NextApiResponse) => {
  const user = await getCurrentUserWithTeam(req, res);
  // Re-sending a payload to a customer's endpoint changes the world outside this system.
  // That is an update-level permission, not a read — same call [RELAY-6] makes for route
  // creation, and for the same reason.
  throwIfNotAllowed(user, 'team', 'update');

  const parsedId = idSchema.safeParse(req.query.id);
  if (!parsedId.success) {
    return res.status(400).json({ error: { message: 'Invalid DLQ item id.' } });
  }
  const id = parsedId.data;

  // ── 1. TENANT CHECK, FIRST. Nothing above this line touches the outside world. ──────
  const item = await fetchDlqItemForTeam(user.team.id, id);
  if (!item) {
    // 404 rather than 403: confirming that an id exists but belongs to someone else is
    // itself a disclosure, and there is nothing a caller can do with the distinction.
    return res.status(404).json({ error: { message: 'DLQ item not found.' } });
  }

  // ── 2. Is there anything to republish at all? ───────────────────────────────────────
  const body = readStoredBody(item.payload);
  if (body === null) {
    return res.status(422).json({
      error: {
        message:
          'This item cannot be retried: its body was never stored. The payload exceeded ' +
          'the 64KB inline limit and there is no object storage yet, so there is nothing ' +
          'to republish.',
      },
    });
  }

  // ── 3. The route must still be one we are willing to send to. ───────────────────────
  if (item.route.status === 'PAUSED') {
    return res.status(422).json({
      error: {
        message: `Route "${item.route.name}" is paused. Resume it before retrying — pausing means stop sending to this destination.`,
      },
    });
  }

  // The destination is read from the ROUTE, live, not from the DLQ row — it can be edited
  // between the failure and the retry, and that window is exactly what ssrfGap.ts names.
  const destinationCheck = validateDestination(item.route.destination);
  if (!destinationCheck.ok) {
    return res.status(422).json({
      error: {
        message: `Destination rejected (${destinationCheck.code}). Fix the route's destination before retrying.`,
      },
    });
  }

  // Fail closed on a malformed envelope rather than handing QStash something the consumer
  // will reject with a 400 it can never recover from. Same schema the consumer parses.
  const envelope = RelayEnvelopeSchema.safeParse({
    // The ORIGINAL requestId, not a new one. It keeps the retry correlated to the
    // delivery it came from, and it is what makes the consumer's own guards work:
    // `DeliveryLog.requestId` is `@unique` so the attempt updates the existing row, and
    // `recordDlqItem` dedupes on it so a failed retry cannot create a second DLQ entry
    // for one dead webhook.
    requestId: item.requestId,
    routeId: item.route.id,
    teamId: user.team.id,
    destination: destinationCheck.url.toString(),
    maxRetries: item.route.maxRetries,
    receivedAt: item.createdAt.toISOString(),
    // ⚠ EMPTY, and this is a real limitation rather than an oversight. `DlqItem` has no
    // headers column — [RELAY-5] stored the body and nothing else — so the original
    // request headers are gone. A replay therefore arrives at the destination WITHOUT
    // `stripe-signature`, `x-hub-signature-256` and friends, and a receiver that verifies
    // signatures will reject it. Inventing a `content-type` we did not observe would be
    // worse: it would make a replay look authentic while still being wrong. The UI states
    // this plainly on the confirm step. Retaining headers needs a migration and its own
    // ticket.
    headers: {},
    body,
  });

  if (!envelope.success) {
    return res.status(500).json({
      error: {
        message:
          'Could not rebuild a valid envelope from this item. This is a bug on our side, not a bad request.',
      },
    });
  }

  // ── 4. ATOMIC CLAIM. Past this point a publish may happen, so the guard comes first. ─
  const claimedAt = await claimDlqRetry(user.team.id, id);
  if (!claimedAt) {
    return res.status(409).json({
      error: {
        message:
          'This item has already been retried. Retry is allowed once per item so a double-click cannot double-deliver a payload.',
      },
    });
  }

  const result = await publishToQStash(envelope.data);

  // The audit row is written for EVERY outcome, success or not. "An operator attempted to
  // re-send this payload" is precisely the fact an audit trail exists to preserve, and a
  // trail that records only successes cannot answer the question it will be asked.
  await recordAuditEvent({
    teamId: user.team.id,
    event: DLQ_RETRIED_EVENT,
    actor: user.email,
    target: item.id,
    metadata: {
      requestId: item.requestId,
      routeId: item.route.id,
      routeSlug: item.route.slug,
      // Where the payload was sent, and therefore who can see it now. This is the question
      // an audit of a re-delivery is actually asked.
      destination: item.route.destination,
      attemptCountAtFailure: item.attemptCount,
      payloadBytes: Buffer.byteLength(body, 'utf8'),
      outcome: result.kind,
      claimedAt: claimedAt.toISOString(),
      ...(result.kind === 'published' ? { messageId: result.messageId } : {}),
      ...(result.kind === 'rejected' ? { qstashStatus: result.status } : {}),
      ...(result.kind === 'unknown' ? { reason: result.reason } : {}),
    },
  });

  if (result.kind === 'published') {
    // 202, not 200. QStash has the message; the delivery has not happened yet. Reporting
    // 200 "retried" would tell an operator the webhook was delivered when all that is
    // true is that it was queued.
    return res.status(202).json({
      data: {
        status: 'queued',
        requestId: item.requestId,
        messageId: result.messageId,
      },
    });
  }

  // Definitively refused: QStash answered, and it answered no. Nothing is queued, so the
  // claim is given back and the operator can fix the cause and try again.
  if (result.kind === 'rejected' || result.kind === 'not_configured') {
    await releaseDlqRetryClaim(user.team.id, id, claimedAt);

    return result.kind === 'not_configured'
      ? res.status(503).json({
          error: {
            message:
              'QStash is not configured on this environment, so nothing was published. The item is still retryable.',
          },
        })
      : res.status(502).json({
          error: {
            message: `QStash refused the message (HTTP ${result.status}). Nothing was published; the item is still retryable.`,
          },
        });
  }

  // Ambiguous. The claim is deliberately NOT released — see the note on
  // `releaseDlqRetryClaim`. Say so, rather than implying either outcome.
  return res.status(502).json({
    error: {
      message:
        'QStash could not be reached and the outcome is unknown — the message may or may not have been queued. This item is marked as retried so it cannot be sent twice by accident. Check the delivery log before retrying it manually.',
    },
  });
};
