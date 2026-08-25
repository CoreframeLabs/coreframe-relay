import type { PrismaClient } from '@prisma/client';

/**
 * [RELAY-44] "Silent-loss" detector — the last open AC on that ticket.
 *
 * WHY THIS EXISTS
 * ----------------
 * `/api/health` (pages/api/health.ts) only proves the process is up and can reach
 * Postgres (`SELECT 1`). A proxy that is running fine, healthy on every existing check,
 * but has quietly stopped forwarding payloads — a bad deploy, a flipped destination
 * config, QStash silently failing — looks identical to a healthy one on that endpoint.
 * This module is the thing that would actually notice: it counts how DlqItem and
 * DeliveryLog are trending over a trailing window and flags it when the shape looks like
 * silent loss rather than normal traffic.
 *
 * WHY `unscopedPrisma`, NOT THE TEAM-SCOPED `prisma` EXPORT
 * -----------------------------------------------------------
 * `DlqItem` and `DeliveryLog` are two of the six RLS-protected models
 * (`lib/db/scope.ts` → `RLS_PROTECTED_MODELS`). The team-scoped `prisma` export
 * (`lib/prisma.ts`) only sets `app.current_team_id` when `currentTeamId()` is defined —
 * i.e. inside a `withTeamScope` call tied to an authenticated session. This module runs
 * from a cron invocation with no session and needs a GLOBAL, cross-tenant count, so it
 * deliberately never calls `withTeamScope`. Using the scoped `prisma` client here would
 * NOT throw and would NOT error — Postgres RLS (`FORCE ROW LEVEL SECURITY`, role
 * `relay_app`, no bypass) would just silently return zero rows for every query, forever,
 * because `current_setting('app.current_team_id', true)` is NULL outside any scope. That
 * would make this health check permanently "healthy" by construction — the exact silent
 * failure it exists to catch, self-inflicted. `unscopedPrisma` is required, not a
 * convenience.
 *
 * SCOPE: GLOBAL, NOT PER-TEAM
 * ----------------------------
 * The ticket's threshold logic (below) is a proxy-wide floor, not a per-tenant SLO —
 * "a silently-stopped-delivering proxy looks healthy on every existing check" is a
 * statement about the whole system, not one customer's traffic. Neither DlqItem nor
 * DeliveryLog carries `teamId` directly (it lives on `Route`, joined via `routeId`), and
 * a global count needs no join through Route at all — confirmed against
 * `prisma/schema.prisma` (Route:284, DeliveryLog:332, DlqItem:365, DeliveryStatus
 * enum:274-280). A per-team breakdown would need that join and is out of scope for this
 * AC; noted here as the natural follow-up if per-tenant alerting is ever wanted.
 */

/** Trailing window the check evaluates. Exported so the API route and tests share one value. */
export const DLQ_HEALTH_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Silent-loss floor: new DLQ rows in the window, independent of traffic volume. Chosen
 * over a percentage-of-DLQ-alone metric because DLQ growth has no natural denominator of
 * its own (unlike delivery failure ratio, which has "of what") — an absolute floor is the
 * simplest thing that still catches "DLQ is filling up" during near-zero traffic, which a
 * ratio-only rule would miss entirely (0/0 or 1/1 tells you nothing).
 */
export const DLQ_GROWTH_ALERT_THRESHOLD = 20;

/**
 * Delivery failure ratio (FAILED + DLQ statuses / all DeliveryLog rows in the window)
 * above which the proxy is failing enough of its traffic to page. 15% is well above
 * ordinary destination flakiness (a single flaky customer endpoint should not page
 * Relay's own on-call) but far below "basically everything is failing", which is the
 * silent-total-outage shape this AC is protecting against.
 */
export const DELIVERY_FAILURE_RATIO_ALERT_THRESHOLD = 0.15;

/**
 * Minimum DeliveryLog rows in the window before the ratio branch is allowed to fire.
 * Below this, one or two real failures against near-zero traffic would swing the ratio
 * past 15% on pure noise (1 failure / 2 attempts = 50%) — this guard is what keeps the
 * ratio check from false-positiving overnight or on a quiet weekend.
 */
export const DELIVERY_FAILURE_MIN_ATTEMPTS_FOR_RATIO = 20;

export interface DlqHealthMetrics {
  /** DlqItem rows created within the window. */
  newDlqCount: number;
  /** DeliveryLog rows created within the window, any status. */
  totalDeliveryAttempts: number;
  /** Of those, rows with status FAILED or DLQ. */
  failedOrDlqDeliveryCount: number;
}

export type DlqHealthAlertReason =
  | 'dlq_growth_exceeded'
  | 'delivery_failure_ratio_exceeded';

export interface DlqHealthResult {
  healthy: boolean;
  reasons: DlqHealthAlertReason[];
  /** null when the ratio guard suppressed evaluation (not enough traffic yet). */
  failureRatio: number | null;
  metrics: DlqHealthMetrics;
}

/**
 * Pure threshold evaluation — no I/O, so it is exercised directly by
 * `__tests__/relay/relay-44.test.ts` without touching a database.
 */
export function evaluateDlqHealth(metrics: DlqHealthMetrics): DlqHealthResult {
  const reasons: DlqHealthAlertReason[] = [];

  if (metrics.newDlqCount > DLQ_GROWTH_ALERT_THRESHOLD) {
    reasons.push('dlq_growth_exceeded');
  }

  const enoughTrafficForRatio =
    metrics.totalDeliveryAttempts >= DELIVERY_FAILURE_MIN_ATTEMPTS_FOR_RATIO;

  const failureRatio = enoughTrafficForRatio
    ? metrics.failedOrDlqDeliveryCount / metrics.totalDeliveryAttempts
    : null;

  if (
    enoughTrafficForRatio &&
    failureRatio !== null &&
    failureRatio > DELIVERY_FAILURE_RATIO_ALERT_THRESHOLD
  ) {
    reasons.push('delivery_failure_ratio_exceeded');
  }

  return {
    healthy: reasons.length === 0,
    reasons,
    failureRatio,
    metrics,
  };
}

/**
 * Queries the trailing window from Postgres via `unscopedPrisma` (see module doc for why)
 * and returns the raw counts. Kept separate from `evaluateDlqHealth` so the threshold
 * logic can be unit tested with seeded numbers, no live database required.
 */
export async function collectDlqHealthMetrics(
  prisma: PrismaClient,
  windowMs: number = DLQ_HEALTH_WINDOW_MS
): Promise<DlqHealthMetrics> {
  const since = new Date(Date.now() - windowMs);

  const [newDlqCount, totalDeliveryAttempts, failedOrDlqDeliveryCount] =
    await Promise.all([
      prisma.dlqItem.count({ where: { createdAt: { gte: since } } }),
      prisma.deliveryLog.count({ where: { createdAt: { gte: since } } }),
      prisma.deliveryLog.count({
        where: {
          createdAt: { gte: since },
          status: { in: ['FAILED', 'DLQ'] },
        },
      }),
    ]);

  return { newDlqCount, totalDeliveryAttempts, failedOrDlqDeliveryCount };
}
