import SlackNotify from 'slack-notify';

import { fetchRoute, PUBLIC_ROUTE_SELECT } from 'models/route';
import { getTeam, fetchTeamOwnerEmail } from 'models/team';
import { sendDlqFallbackEmail } from '@/lib/email/sendDlqFallbackEmail';
import { unscopedPrisma } from '@/lib/prisma';
import env from '@/lib/env';
import app from '@/lib/app';
import { recordMetric } from '@/lib/metrics';
import {
  evaluateDlqHealth,
  DLQ_HEALTH_WINDOW_MS,
  DLQ_GROWTH_ALERT_THRESHOLD,
  type DlqHealthMetrics,
  type DlqHealthAlertReason,
} from '@/lib/relay/dlqHealthCheck';

/**
 * [RELAY-164] "DLQ fallback email failures are swallowed silently" — this block is the
 * fix. `notifyDlqFallback` and `notifyDlqGrowthThreshold` below both deliberately
 * swallow every send error (see each function's module doc for why: a failed
 * notification must never turn a successful DLQ write, or a healthy cron tick, into a
 * retry-triggering failure). That swallow is correct and UNCHANGED by this ticket — the
 * problem was that it left NO trace anywhere once Resend's free-tier cap is hit: no
 * metric, no log line the founder alert would catch, no way to tell "notifications are
 * fine" from "notifications have been silently failing for a day." This helper is called
 * from every swallow site, right before the error is discarded, to leave that trace.
 *
 * WHY A MODULE-LEVEL COUNTER, NOT JUST `recordMetric`
 * -----------------------------------------------------
 * `recordMetric` (lib/metrics.ts) only emits to the OTEL collector when
 * `OTEL_EXPORTER_OTLP_METRICS_*` env vars are configured, and even when it is, nothing
 * in this codebase queries back OUT of that exporter — `dlq-health-check.ts`'s cron
 * handler has no OTLP query client and this ticket does not add one. There is also no
 * new table to add: RELAY-164's AC asks the founder health check to "count swallowed
 * sends in its window," not to ship a migration. A module-level counter, read back via
 * `getDlqNotifySendFailureCount` below, is the smallest honest thing that satisfies that
 * AC without inventing infrastructure this ticket doesn't own.
 *
 * Its honesty limit, stated plainly rather than hidden: on Vercel, the hot delivery path
 * that calls `notifyDlqFallback` and the once-a-day `dlq-health-check` cron
 * (`notifyDlqGrowthThreshold`'s caller) are not guaranteed to share a warm Lambda
 * instance, so a failure recorded in one invocation's memory can be gone (process
 * recycled) before the health check ever reads it. That gap is real and NOT swept under
 * the rug here. The durable, queryable record of every failure is the `recordMetric` +
 * structured `console.error` line emitted at the same call site — this counter is a
 * best-effort supplementary signal for the founder alert, not the source of truth.
 */
const dlqNotifySendFailureTimestamps: number[] = [];

/**
 * Records one swallowed send: the in-process counter (for the founder alert, see above)
 * plus the durable metric + structured log line the RELAY-164 AC actually requires.
 * Wrapped so that observing a swallow can never itself become a reason the swallow turns
 * into a throw — this function exists to make failures visible, not to add a new way for
 * this already-defensive code path to blow up.
 */
function recordSwallowedDlqNotifySend(params: {
  teamId: string;
  channel: 'email' | 'slack';
  reason: string;
}): void {
  try {
    dlqNotifySendFailureTimestamps.push(Date.now());
    recordMetric('relay.dlq_notify.send_failed');
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'relay.dlq_notify_send_failed',
        teamId: params.teamId,
        channel: params.channel,
        reason: params.reason,
      })
    );
  } catch {
    // Deliberately empty — see the function doc above. Never let the act of recording
    // a swallowed failure produce a second, unswallowed one.
  }
}

/**
 * Read side of the counter above. Prunes entries older than `windowMs` (default: the
 * same trailing window `dlqHealthCheck.ts` already uses) so the array can't grow
 * unbounded across a long-lived process, then returns how many failures remain in
 * that window. Exported for `dlq-health-check.ts` (RELAY-44's founder alert) and for
 * direct, DB-independent testing.
 */
export function getDlqNotifySendFailureCount(
  windowMs: number = DLQ_HEALTH_WINDOW_MS
): number {
  const since = Date.now() - windowMs;
  while (
    dlqNotifySendFailureTimestamps.length > 0 &&
    dlqNotifySendFailureTimestamps[0] < since
  ) {
    dlqNotifySendFailureTimestamps.shift();
  }
  return dlqNotifySendFailureTimestamps.length;
}

/**
 * Pure formatting for the founder alert text — kept separate from the Sentry call in
 * `dlq-health-check.ts` so "does the alert text mention the count" is testable without
 * mocking Prisma, Sentry, or the API route, the same split `evaluateDlqHealth` uses in
 * `dlqHealthCheck.ts`. Returns null when there is nothing to say.
 */
export function formatDlqNotifySendFailureAlert(count: number): string | null {
  if (count <= 0) return null;
  return (
    `[RELAY-164] ${count} DLQ notification send(s) failed and were swallowed in the ` +
    `last hour. See 'relay.dlq_notify_send_failed' log lines for the team, channel, ` +
    `and reason of each.`
  );
}

export type DlqFallbackParams = {
  teamId: string;
  routeId: string;
  requestId: string;
  failReason: string;
};

/**
 * Reduces a destination URL to its host only — the same redaction
 * `notifyDlqFallback` applies below, factored out so `notifyDlqGrowthThreshold`
 * (RELAY-124) gets it for free instead of re-deriving it. A query string can carry a
 * value the customer considers sensitive, so it must never reach an email or Slack
 * message; falls back to the raw string only if `destination` is not a parseable URL.
 */
function hostOnly(destination: string): string {
  try {
    return new URL(destination).host;
  } catch {
    return destination;
  }
}

/**
 * [RELAY-48] DLQ email fallback — AC: "fires when a route has no Slack webhook
 * configured."
 *
 * There is exactly one Slack integration surface in this codebase today
 * (`lib/slack.ts` / `env.slackWebhookUrl`), and it is Coreframe's own internal ops
 * channel — global to the deployment, fired on new signups and account lockouts, with
 * no per-team scoping. It is never read here for that reason: gating a CUSTOMER's DLQ
 * notification on Coreframe's OWN internal alert config would mean a customer's dead
 * letter posts into Coreframe's internal Slack, or worse, never fires at all once that
 * one env var happens to be set for unrelated reasons.
 *
 * `Team.slackWebhookUrl` (this ticket) is the actual per-team column the AC means, and
 * no settings UI writes it yet — see its schema comment. That makes this function's
 * current, correct behavior "email every team", not a bug to fix later.
 *
 * Called fire-and-forget from `consumeEnvelope` right after a DLQ row is written.
 * Deliberately swallows every error itself: a failed notification must never turn a
 * successful DLQ write into a 500 back to QStash, which would just cause needless
 * retries against a destination that has already been given up on.
 */
export async function notifyDlqFallback(
  params: DlqFallbackParams
): Promise<void> {
  const { teamId, routeId, requestId, failReason } = params;

  try {
    const team = await getTeam({ id: teamId });

    if (team.slackWebhookUrl) {
      return;
    }

    const [route, ownerEmail] = await Promise.all([
      fetchRoute(teamId, routeId),
      fetchTeamOwnerEmail(teamId),
    ]);

    if (!route || !ownerEmail) {
      console.error(
        '[relay] dlqNotify: cannot send DLQ fallback email — route or owner email missing',
        { requestId, hasRoute: !!route, hasOwnerEmail: !!ownerEmail }
      );
      return;
    }

    // Host only, never the full URL, and never `destinationHeadersEncrypted` — this
    // function never even fetches that column. `DestinationUrlSchema` should already
    // rule out an unparseable value at create time; `hostOnly` falls back to the raw
    // string in that case rather than throwing.
    try {
      await sendDlqFallbackEmail({
        to: ownerEmail,
        teamSlug: team.slug,
        teamName: team.name,
        routeName: route.name,
        destinationHost: hostOnly(route.destination),
        failReason,
      });
    } catch (error) {
      // [RELAY-164] Record the swallow BEFORE it's swallowed, then rethrow so the
      // outer catch below still does exactly what it did before this ticket — this
      // block adds visibility, it does not change the swallow itself.
      recordSwallowedDlqNotifySend({
        teamId,
        channel: 'email',
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw error;
    }
  } catch (error) {
    console.error('[relay] dlqNotify: failed to send DLQ fallback email', {
      requestId,
      name: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * [RELAY-124] Customer-visible DLQ *growth* alerting — extends the RELAY-48 mechanism
 * above (same `dlqNotify.ts`, same `Team.slackWebhookUrl` column) to fire on a route's
 * DLQ growth crossing a threshold, not just DLQ *existence*. `notifyDlqFallback` above
 * fires once per dead-lettered item, from the hot delivery path; this fires from the
 * scheduled RELAY-44 health-check cron (see `pages/api/relay/internal/dlq-health-check`),
 * once per route per invocation, and answers a different question: "has this route's
 * DLQ been growing too fast lately," not "did this one item just fail."
 *
 * THRESHOLD LOGIC IS REUSED, NOT REIMPLEMENTED
 * ---------------------------------------------
 * `evaluateDlqHealth` (imported from `dlqHealthCheck.ts`, untouched by this ticket) is
 * the exact function RELAY-44 already uses for the founder-only global check. It is a
 * pure function over counts — `{ newDlqCount, totalDeliveryAttempts,
 * failedOrDlqDeliveryCount } -> verdict` — with no idea whether those counts came from
 * the whole deployment or one route. That is what makes reuse possible here: only the
 * counting changes (per-route instead of global), the threshold math does not.
 *
 * `collectRouteDlqHealthMetrics` below is this ticket's one new piece of collection
 * logic, deliberately as small as `collectDlqHealthMetrics` in dlqHealthCheck.ts — same
 * `unscopedPrisma` requirement and the same reason: this runs from the same
 * session-free cron invocation, filtered to one route's rows via its `routeId` column
 * (DlqItem/DeliveryLog both carry it directly, no join through Route required for a
 * per-route filter — see the model comments in prisma/schema.prisma).
 *
 * WHICH CHANNEL FIRES
 * --------------------
 * Same gate as `notifyDlqFallback`: `Team.slackWebhookUrl` set -> a real Slack message
 * via that team's own webhook (the `slack-notify` package already used for Coreframe's
 * own internal ops channel in `lib/slack.ts`, instantiated here against the per-team
 * URL instead — no new notification library). Not set -> the existing email fallback,
 * reusing `sendDlqFallbackEmail` verbatim with a growth-specific `failReason` string
 * rather than adding a second email template for what is, to the recipient, the same
 * "something is wrong with your DLQ" message.
 *
 * Deliberately swallows every error, same as `notifyDlqFallback`: a failed notification
 * must never turn the health-check cron's 200 into a 500.
 */
export type DlqGrowthNotificationChannel = 'slack' | 'email' | null;

export interface DlqGrowthNotificationResult {
  notified: boolean;
  channel: DlqGrowthNotificationChannel;
  reasons: DlqHealthAlertReason[];
}

/**
 * Per-route counterpart of `collectDlqHealthMetrics` (dlqHealthCheck.ts). Same
 * `unscopedPrisma` requirement (session-free cron invocation, see that file's module
 * doc), same trailing window, filtered to one route via the `routeId` column both
 * tables carry directly.
 */
export async function collectRouteDlqHealthMetrics(
  routeId: string,
  windowMs: number = DLQ_HEALTH_WINDOW_MS
): Promise<DlqHealthMetrics> {
  const since = new Date(Date.now() - windowMs);

  const [newDlqCount, totalDeliveryAttempts, failedOrDlqDeliveryCount] =
    await Promise.all([
      unscopedPrisma.dlqItem.count({
        where: { routeId, createdAt: { gte: since } },
      }),
      unscopedPrisma.deliveryLog.count({
        where: { routeId, createdAt: { gte: since } },
      }),
      unscopedPrisma.deliveryLog.count({
        where: {
          routeId,
          createdAt: { gte: since },
          status: { in: ['FAILED', 'DLQ'] },
        },
      }),
    ]);

  return { newDlqCount, totalDeliveryAttempts, failedOrDlqDeliveryCount };
}

export async function notifyDlqGrowthThreshold(params: {
  teamId: string;
  routeId: string;
}): Promise<DlqGrowthNotificationResult> {
  const { teamId, routeId } = params;

  try {
    const metrics = await collectRouteDlqHealthMetrics(routeId);
    // The actual RELAY-44 function — not a copy, not a reimplementation.
    const result = evaluateDlqHealth(metrics);

    if (!result.reasons.includes('dlq_growth_exceeded')) {
      return { notified: false, channel: null, reasons: result.reasons };
    }

    // NOT `fetchRoute` (models/route.ts): that helper queries through the
    // team-scoped `prisma` export, which relies on `withTeamScope` having set
    // `app.current_team_id` for this async call chain. This function is invoked from
    // the session-free health-check cron (no `withTeamScope` anywhere in that path,
    // deliberately — see dlqHealthCheck.ts's module doc), so under RLS enforcement
    // (`relay_app`, not a bypass-RLS role) `fetchRoute` would silently return null
    // here every time — the exact silent-failure shape dlqHealthCheck.ts's own doc
    // warns about, just one hop further downstream. `unscopedPrisma` + an explicit
    // `teamId` filter gets the tenant boundary back without needing a session.
    const [team, route] = await Promise.all([
      getTeam({ id: teamId }),
      unscopedPrisma.route.findFirst({
        where: { id: routeId, teamId },
        select: PUBLIC_ROUTE_SELECT,
      }),
    ]);

    if (!route) {
      console.error(
        '[relay] dlqNotify: cannot send DLQ growth alert — route missing',
        { teamId, routeId }
      );
      return { notified: false, channel: null, reasons: result.reasons };
    }

    const dlqLink = `${env.appUrl}/teams/${team.slug}/relay/buffer/dlq`;

    if (team.slackWebhookUrl) {
      const slack = SlackNotify(team.slackWebhookUrl);
      try {
        await slack.alert({
          text: `${app.name}: DLQ growth threshold crossed on "${route.name}"`,
          fields: {
            Team: team.name,
            Route: route.name,
            'New DLQ items (last hour)': String(metrics.newDlqCount),
            Threshold: String(DLQ_GROWTH_ALERT_THRESHOLD),
            Link: dlqLink,
          },
        });
      } catch (error) {
        // [RELAY-164] Same record-then-rethrow shape as `notifyDlqFallback` above —
        // the outer catch still swallows this exactly as it did before.
        recordSwallowedDlqNotifySend({
          teamId,
          channel: 'slack',
          reason: error instanceof Error ? error.message : 'unknown',
        });
        throw error;
      }
      return { notified: true, channel: 'slack', reasons: result.reasons };
    }

    const ownerEmail = await fetchTeamOwnerEmail(teamId);
    if (!ownerEmail) {
      console.error(
        '[relay] dlqNotify: cannot send DLQ growth alert email — no owner email',
        { teamId, routeId }
      );
      return { notified: false, channel: null, reasons: result.reasons };
    }

    try {
      await sendDlqFallbackEmail({
        to: ownerEmail,
        teamSlug: team.slug,
        teamName: team.name,
        routeName: route.name,
        destinationHost: hostOnly(route.destination),
        failReason:
          `DLQ growth exceeded threshold: ${metrics.newDlqCount} new dead-lettered ` +
          `items in the last hour (threshold ${DLQ_GROWTH_ALERT_THRESHOLD}).`,
      });
    } catch (error) {
      // [RELAY-164] Same record-then-rethrow shape as `notifyDlqFallback` above — the
      // outer catch still swallows this exactly as it did before.
      recordSwallowedDlqNotifySend({
        teamId,
        channel: 'email',
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw error;
    }

    return { notified: true, channel: 'email', reasons: result.reasons };
  } catch (error) {
    console.error(
      '[relay] dlqNotify: failed to send DLQ growth threshold notification',
      {
        teamId,
        routeId,
        name: error instanceof Error ? error.name : 'unknown',
      }
    );
    return { notified: false, channel: null, reasons: [] };
  }
}
