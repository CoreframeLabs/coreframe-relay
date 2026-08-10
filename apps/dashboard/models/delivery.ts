import { Prisma } from '@prisma/client';
import type { DeliveryLog, DeliveryStatus } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/errors';

/**
 * DeliveryLog data access. Added in [RELAY-5].
 *
 * EVERY function here takes `teamId`, exactly as `models/route.ts` does and for the same
 * reason: tenant isolation in this application rests entirely on the Prisma query
 * remembering its filter. RLS is enabled but INERT on the app's connection role — the app
 * connects as `postgres`, which has `rolbypassrls=t` ([RELAY-11], measured; [RELAY-39] is
 * the fix). So the `where` clause here is not defence in depth. It is the defence.
 *
 * `DeliveryLog` has no `teamId` column of its own — it hangs off `Route` — so the scope is
 * expressed as `route: { teamId }`, which Prisma compiles to a join-side filter. Same
 * boundary, one level of indirection.
 */

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/**
 * Confirm a (routeId, teamId) pair really belongs together before writing anything
 * against it.
 *
 * The envelope arriving from QStash carries BOTH ids, and it is signed, so it is
 * tamper-evident in transit. That is not the same as trustworthy: it was composed by the
 * proxy, the most exposed component in the system, and a bug there that paired one team's
 * id with another team's route would write cross-tenant rows that look perfectly valid.
 * One indexed lookup closes that.
 */
export async function assertRouteBelongsToTeam(
  teamId: string,
  routeId: string
): Promise<void> {
  const route = await prisma.route.findFirst({
    where: { id: routeId, teamId },
    select: { id: true },
  });
  if (!route) {
    throw new ApiError(404, 'Route not found.');
  }
}

export type DeliveryAttempt = {
  teamId: string;
  routeId: string;
  requestId: string;
  status: DeliveryStatus;
  attemptCount: number;
  responseCode: number | null;
  latencyMs: number | null;
  payloadSizeB: number | null;
  deliveredAt: Date | null;
  /**
   * [RELAY-50] Defaults to false so every call site that does not know about the flag
   * still records a REAL delivery — the bias that makes a forged `isTest: true` view-
   * only, never a billing dodge. The badge reads this field; the usage counter
   * ([RELAY-12] / RELAY-52's north-star filter) reads this field; nothing else does.
   */
  isTest: boolean;
};

/**
 * Record the outcome of one delivery attempt, idempotently on `requestId`.
 *
 * **This function is the idempotency mechanism.** `DeliveryLog.requestId` is `@unique`
 * ([RELAY-2]), and QStash guarantees at-least-once delivery — a message can and will
 * arrive twice, either as a genuine retry or as a replay. The second arrival must update
 * the first row, never create a second one.
 *
 * The unique violation is handled EXPLICITLY rather than being allowed to bubble, because
 * of what happens if it does: an unhandled P2002 becomes a 500, QStash reads a 500 as
 * "retry", the retry collides again, and the message retries until its budget is spent —
 * a delivery that already succeeded, hammering a customer's endpoint.
 *
 * `create`-then-catch rather than `upsert`: `upsert` still races two concurrent QStash
 * attempts of the same message and throws the same P2002, so the catch is required
 * either way, and this form makes the reason it exists visible at the call site.
 */
export async function recordDeliveryAttempt(
  attempt: DeliveryAttempt
): Promise<{ log: DeliveryLog; duplicate: boolean }> {
  await assertRouteBelongsToTeam(attempt.teamId, attempt.routeId);

  const data = {
    routeId: attempt.routeId,
    requestId: attempt.requestId,
    status: attempt.status,
    attemptCount: attempt.attemptCount,
    responseCode: attempt.responseCode,
    latencyMs: attempt.latencyMs,
    payloadSizeB: attempt.payloadSizeB,
    deliveredAt: attempt.deliveredAt,
    isTest: attempt.isTest,
  };

  try {
    const log = await prisma.deliveryLog.create({ data });
    return { log, duplicate: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // updateMany, not update: `update` matches on the primary key alone and would write
    // across tenants. Same reasoning as `updateRoute` in models/route.ts.
    const { count } = await prisma.deliveryLog.updateMany({
      where: {
        requestId: attempt.requestId,
        route: { teamId: attempt.teamId },
      },
      data: {
        status: attempt.status,
        attemptCount: attempt.attemptCount,
        responseCode: attempt.responseCode,
        latencyMs: attempt.latencyMs,
        payloadSizeB: attempt.payloadSizeB,
        deliveredAt: attempt.deliveredAt,
        isTest: attempt.isTest,
      },
    });

    if (count === 0) {
      // The row exists (that is what P2002 means) but not for this team. Either the
      // requestId collided across tenants or someone is replaying another team's message.
      // Refuse, and do not say which.
      throw new ApiError(409, 'Delivery already recorded.');
    }

    const log = await fetchDeliveryByRequestId(
      attempt.teamId,
      attempt.requestId
    );
    if (!log) throw new ApiError(404, 'Delivery not found.');
    return { log, duplicate: true };
  }
}

/** Scoped by teamId on purpose — see the note at the top of this file. */
export async function fetchDeliveryByRequestId(
  teamId: string,
  requestId: string
): Promise<DeliveryLog | null> {
  return prisma.deliveryLog.findFirst({
    where: { requestId, route: { teamId } },
  });
}

/** Newest first, for the delivery feed [RELAY-7] builds on. */
export async function fetchDeliveries(
  teamId: string,
  routeId: string,
  take = 200
): Promise<DeliveryLog[]> {
  return prisma.deliveryLog.findMany({
    where: { routeId, route: { teamId } },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * The live delivery feed. [RELAY-7]
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The hard ceiling on how many rows the feed ever holds, server or client.
 *
 * It is exported rather than written as a literal in three places because it is a
 * contract between the query, the SSE stream's diff window and the client's list — if
 * they disagree, the stream emits rows the list silently drops and a delivery appears to
 * have vanished.
 */
export const DELIVERY_FEED_MAX_ROWS = 200;

/**
 * The feed's response contract, pinned as an explicit `select`.
 *
 * Same reasoning as `fetchRouteBySlugs`: what a query returns is an API surface, and
 * `include: { route: true }` would ship the destination URL, the team id and the retry
 * policy of every route to the browser as a side effect of wanting its name. Adding a
 * column to `DeliveryLog` later must not silently widen what this page sends.
 */
const feedSelect = {
  id: true,
  requestId: true,
  status: true,
  attemptCount: true,
  responseCode: true,
  latencyMs: true,
  payloadSizeB: true,
  sourceIp: true,
  isTest: true,
  createdAt: true,
  deliveredAt: true,
  route: { select: { id: true, name: true, slug: true } },
} as const;

/** One row of the delivery feed, exactly as `feedSelect` returns it. */
export type DeliveryFeedRow = {
  id: string;
  requestId: string;
  status: DeliveryStatus;
  attemptCount: number;
  responseCode: number | null;
  latencyMs: number | null;
  payloadSizeB: number | null;
  sourceIp: string | null;
  isTest: boolean;
  createdAt: Date;
  deliveredAt: Date | null;
  route: { id: string; name: string; slug: string };
};

export type DeliveryFeedFilter = {
  routeId?: string;
  status?: DeliveryStatus;
};

/**
 * The whole team's deliveries across every route, newest first.
 *
 * **The route filter is nested inside the `route` relation deliberately.** Written the
 * obvious way — `where: { routeId, route: { teamId } }` — it is still correct, but this
 * form makes the coupling impossible to separate by accident: a caller cannot narrow to a
 * route without the team predicate travelling with it in the same object. A `routeId`
 * belonging to another team therefore matches nothing rather than leaking a row, which
 * matters because the route filter on the feed comes from a query string.
 *
 * The sort is `(createdAt DESC, id DESC)`, not `createdAt` alone. Ties are real here —
 * `createdAt` is `timestamptz(6)` and a burst of webhooks can share a microsecond — and an
 * unstable sort means the "top 200" window shuffles between polls, which the stream's diff
 * would then report as rows appearing and disappearing.
 */
export async function fetchTeamDeliveryFeed(
  teamId: string,
  filter: DeliveryFeedFilter = {},
  take: number = DELIVERY_FEED_MAX_ROWS
): Promise<DeliveryFeedRow[]> {
  return prisma.deliveryLog.findMany({
    where: {
      route: {
        teamId,
        ...(filter.routeId ? { id: filter.routeId } : {}),
      },
      ...(filter.status ? { status: filter.status } : {}),
    },
    select: feedSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(take, 1), DELIVERY_FEED_MAX_ROWS),
  });
}
