// `Prisma` is a value import, not a type-only one: `Prisma.DbNull` is a runtime sentinel.
// A `Json?` column has two distinct nulls in Postgres — SQL NULL and the JSON value
// `null` — and `DbNull` is the one that means "no payload stored".
import { Prisma } from '@prisma/client';
import type { DlqItem, RouteStatus } from '@prisma/client';
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

/* ────────────────────────────────────────────────────────────────────────────────────
 * [RELAY-8] — the DLQ page and its Retry action.
 *
 * Everything below is additive. Nothing above was restructured.
 * ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * How much of a stored payload the list endpoint will return per row.
 *
 * The cap is on the RESPONSE, not just the rendering. A page showing 200 rows of up-to-64KB
 * payloads would ship ~12MB of JSON to the browser to render maybe forty visible
 * characters of each — and truncating only in React would mean the whole blob still
 * crossed the wire. `payloadBytes` is returned alongside so the UI can state the real size
 * rather than implying the preview is the whole thing.
 */
export const DLQ_PREVIEW_MAX_CHARS = 2_000;

/** The route fields the DLQ page needs. Deliberately not `select: *` — see below. */
export type DlqRouteRef = {
  id: string;
  name: string;
  slug: string;
  destination: string;
  maxRetries: number;
  /**
   * Carried so the retry endpoint can refuse a PAUSED route. Pausing means "stop sending
   * to this destination"; replaying dead webhooks into it would contradict the one
   * instruction the operator gave.
   */
  status: RouteStatus;
};

/** One row as the DLQ page consumes it. This shape IS the API contract. */
export type DlqListRow = {
  id: string;
  requestId: string;
  failReason: string;
  attemptCount: number;
  createdAt: string;
  expiresAt: string;
  retriedAt: string | null;
  /**
   * False when the body was never retained — the over-`MAX_INLINE_PAYLOAD_BYTES` case
   * `retainBody()` above records. Such an item can NEVER be retried, and the UI must say
   * so instead of offering a Retry button that fails.
   */
  payloadRetained: boolean;
  /** Byte length of the retained body, or null when nothing was retained. */
  payloadBytes: number | null;
  /** At most `DLQ_PREVIEW_MAX_CHARS` characters of the body. Never the whole thing. */
  payloadPreview: string | null;
  /** True when `payloadPreview` is shorter than the stored body. */
  payloadTruncated: boolean;
  route: DlqRouteRef;
};

/**
 * Recover the raw request body from a `DlqItem.payload` column.
 *
 * `retainBody()` stores the body as a JSON *string*, not a parsed object, so the exact
 * bytes received are the exact bytes replayed — re-encoding a payload is how a signature
 * the destination would have verified stops verifying. The `typeof` branch is therefore
 * the normal path; the `JSON.stringify` fallback exists only so a row written by some
 * future writer that stored an object does not read back as `[object Object]`.
 *
 * Note both of a `Json?` column's nulls — SQL NULL and JSON `null` — arrive here as JS
 * `null`, and both mean the same thing for our purposes: there is no body.
 */
export function readStoredBody(
  payload: Prisma.JsonValue | null
): string | null {
  if (payload === null || payload === undefined) return null;
  return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

function toListRow(item: DlqItem & { route: DlqRouteRef }): DlqListRow {
  const body = readStoredBody(item.payload);
  const preview = body === null ? null : body.slice(0, DLQ_PREVIEW_MAX_CHARS);

  return {
    id: item.id,
    requestId: item.requestId,
    failReason: item.failReason,
    attemptCount: item.attemptCount,
    createdAt: item.createdAt.toISOString(),
    expiresAt: item.expiresAt.toISOString(),
    retriedAt: item.retriedAt ? item.retriedAt.toISOString() : null,
    payloadRetained: body !== null,
    payloadBytes: body === null ? null : Buffer.byteLength(body, 'utf8'),
    payloadPreview: preview,
    payloadTruncated: body !== null && body.length > DLQ_PREVIEW_MAX_CHARS,
    route: item.route,
  };
}

/**
 * Every DLQ item for a team, newest first, across all of its routes.
 *
 * `fetchDlqItems` above is per-route; the page's acceptance criterion is "displays all
 * `DlqItem` rows", which is team-wide. Same `route: { teamId }` scope, same reasoning.
 *
 * The `select` on `route` is the response contract, not an optimisation: a DLQ row is
 * rendered in a browser, and `include: { route: true }` would ship the route's whole
 * record — currently including nothing secret, but that is a property of today's schema
 * rather than a decision anyone made.
 */
export async function fetchDlqItemsForTeam(
  teamId: string,
  take = 200
): Promise<DlqListRow[]> {
  const items = await prisma.dlqItem.findMany({
    where: { route: { teamId } },
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      route: {
        select: {
          id: true,
          name: true,
          slug: true,
          destination: true,
          maxRetries: true,
          status: true,
        },
      },
    },
  });

  return items.map(toListRow);
}

/**
 * One DLQ item by id, scoped to a team.
 *
 * Takes `teamId` for the reason stated at the top of this file: a `DlqItem` id is a UUID a
 * user can hold from another team, so `findUnique({ where: { id } })` is an IDOR. This is
 * the first thing the retry endpoint calls, before it looks at a destination and long
 * before it publishes anything.
 */
export async function fetchDlqItemForTeam(
  teamId: string,
  id: string
): Promise<(DlqItem & { route: DlqRouteRef }) | null> {
  return prisma.dlqItem.findFirst({
    where: { id, route: { teamId } },
    include: {
      route: {
        select: {
          id: true,
          name: true,
          slug: true,
          destination: true,
          maxRetries: true,
          status: true,
        },
      },
    },
  });
}

/**
 * Claim an item for retry, atomically. Returns the claim timestamp, or null if it was
 * already claimed.
 *
 * **This is the idempotency guard, and its shape matters more than its existence.** The
 * obvious implementation — read `retriedAt`, see null, then write — has a window between
 * the read and the write in which a second request reads the same null. Two operators
 * clicking Retry at the same moment, or one operator double-clicking, then both publish,
 * and the customer's endpoint receives the payload twice. Re-delivering a webhook that a
 * customer has already processed is exactly the failure this product exists to prevent.
 *
 * `updateMany` with `retriedAt: null` in the WHERE compiles to a single
 * `UPDATE … WHERE "retriedAt" IS NULL`, so the database — not this process — decides who
 * wins. The loser gets `count: 0` and publishes nothing.
 *
 * `route: { teamId }` stays in the WHERE even though the caller has already verified
 * ownership: `updateMany` matching on the primary key alone would write across tenants,
 * which is the same reasoning `models/route.ts` records for `updateRoute`/`deleteRoute`.
 */
export async function claimDlqRetry(
  teamId: string,
  id: string
): Promise<Date | null> {
  const claimedAt = new Date();

  const { count } = await prisma.dlqItem.updateMany({
    where: { id, retriedAt: null, route: { teamId } },
    data: { retriedAt: claimedAt },
  });

  return count === 1 ? claimedAt : null;
}

/**
 * Give a claim back, but only when the publish was DEFINITIVELY rejected.
 *
 * The `retriedAt: claimedAt` term is load-bearing: it releases only the exact claim this
 * request made. Without it a release could clear a claim some other request had since
 * taken, and the item would be retryable twice.
 *
 * The caller must not use this for an ambiguous failure — a timeout or a socket error
 * against QStash may mean the publish landed and the response was lost. Releasing there
 * would risk a double delivery, which is the one outcome worse than an item stuck in a
 * retried state that an operator can see and reason about.
 */
export async function releaseDlqRetryClaim(
  teamId: string,
  id: string,
  claimedAt: Date
): Promise<void> {
  await prisma.dlqItem.updateMany({
    where: { id, retriedAt: claimedAt, route: { teamId } },
    data: { retriedAt: null },
  });
}
