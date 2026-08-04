// `Prisma` is a value import, not a type-only one: `Prisma.DbNull` is a runtime sentinel.
// A `Json?` column has two distinct nulls in Postgres — SQL NULL and the JSON value
// `null` — and `DbNull` is the one that means "no payload stored".
import { Prisma } from '@prisma/client';
import type { DlqItem } from '@prisma/client';
import { MAX_INLINE_PAYLOAD_BYTES } from '@coreframe-relay/types';

import { prisma } from '@/lib/prisma';
import { assertRouteBelongsToTeam } from 'models/delivery';

/**
 * DlqItem data access. Added in [RELAY-5].
 *
 * EVERY function takes `teamId`, for the reason set out at the top of `models/delivery.ts`.
 * `DlqItem` has no `teamId` column either; it is scoped through `route: { teamId }`.
 */

/**
 * Retention window for a new DLQ item.
 *
 * **Deliberately the FREE tier's 7 days for every team, and that is a stated shortfall,
 * not an oversight.** The schema comment specifies Free 7d / Pro 30d / Business 90d, but
 * nothing yet maps a team to a plan on this path, and there is no reaper deleting expired
 * rows either — so `expiresAt` is currently a recorded intention rather than an enforced
 * policy. Seven days is the conservative direction to be wrong in: it under-promises
 * retention rather than over-promising it. Tier-aware retention needs its own ticket
 * before anyone is billed for 90-day DLQ retention.
 */
const DLQ_RETENTION_DAYS = 7;

export type DlqCandidate = {
  teamId: string;
  routeId: string;
  requestId: string;
  failReason: string;
  attemptCount: number;
  /** Raw request body as received. Stored inline only when small enough — see below. */
  body: string;
};

/**
 * Decide how a body is retained.
 *
 * `DlqItem.payload` is inline only under 64KB (`MAX_INLINE_PAYLOAD_BYTES`); above that the
 * contract says `payload` is null and `payloadKey` points at object storage.
 *
 * **There is no object storage yet.** So an oversized body is stored NEITHER inline nor by
 * key, and the fact that it was discarded is written into `failReason` where an operator
 * reading the DLQ page will see it. The alternative — writing the blob inline anyway —
 * is what [RELAY-12] exists to prevent (unbounded rows on the highest-write path); the
 * other alternative, dropping it silently, would leave a DLQ item that looks retryable and
 * is not. Recording the truncation honestly is the only option that does not lie to the
 * operator. Tracked in [RELAY-12].
 */
function retainBody(body: string, failReason: string) {
  const sizeB = Buffer.byteLength(body, 'utf8');

  if (sizeB >= MAX_INLINE_PAYLOAD_BYTES) {
    return {
      payload: Prisma.DbNull,
      payloadKey: null,
      failReason:
        `${failReason} [payload ${sizeB}B exceeded the ${MAX_INLINE_PAYLOAD_BYTES}B inline ` +
        `limit and no object storage exists yet — body NOT retained, so this item cannot ` +
        `be retried. See RELAY-12.]`,
      sizeB,
    };
  }

  // Stored as a JSON string, not a parsed object: the body may not be JSON at all, and
  // re-encoding a payload is how a signature that the destination would have verified
  // stops verifying. The exact bytes received are the exact bytes replayed.
  return {
    payload: body as Prisma.InputJsonValue,
    payloadKey: null,
    failReason,
    sizeB,
  };
}

/**
 * Write a permanently-failed delivery to the DLQ, at most once per requestId.
 *
 * `DlqItem.requestId` is NOT unique in the schema (unlike `DeliveryLog.requestId`), so the
 * database will not stop a duplicate — a replayed final attempt would otherwise produce
 * two rows for one dead webhook, and a DLQ that double-counts is a DLQ nobody trusts.
 * Guarded here with an explicit existence check.
 */
export async function recordDlqItem(
  candidate: DlqCandidate
): Promise<{ item: DlqItem; duplicate: boolean }> {
  await assertRouteBelongsToTeam(candidate.teamId, candidate.routeId);

  const existing = await fetchDlqItemByRequestId(
    candidate.teamId,
    candidate.requestId
  );
  if (existing) {
    return { item: existing, duplicate: true };
  }

  const retained = retainBody(candidate.body, candidate.failReason);

  const expiresAt = new Date(
    Date.now() + DLQ_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );

  const item = await prisma.dlqItem.create({
    data: {
      routeId: candidate.routeId,
      requestId: candidate.requestId,
      failReason: retained.failReason,
      attemptCount: candidate.attemptCount,
      payload: retained.payload,
      payloadKey: retained.payloadKey,
      expiresAt,
    },
  });

  return { item, duplicate: false };
}

/** Scoped by teamId on purpose — see the note at the top of this file. */
export async function fetchDlqItemByRequestId(
  teamId: string,
  requestId: string
): Promise<DlqItem | null> {
  return prisma.dlqItem.findFirst({
    where: { requestId, route: { teamId } },
  });
}

/** The DLQ page [RELAY-8] builds on: one route, newest first. */
export async function fetchDlqItems(
  teamId: string,
  routeId: string,
  take = 200
): Promise<DlqItem[]> {
  return prisma.dlqItem.findMany({
    where: { routeId, route: { teamId } },
    orderBy: { createdAt: 'desc' },
    take,
  });
}
