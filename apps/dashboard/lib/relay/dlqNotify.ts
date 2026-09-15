import SlackNotify from 'slack-notify';

import { fetchRoute, PUBLIC_ROUTE_SELECT } from 'models/route';
import { getTeam, fetchTeamOwnerEmail } from 'models/team';
import { sendDlqFallbackEmail } from '@/lib/email/sendDlqFallbackEmail';
import { unscopedPrisma } from '@/lib/prisma';
import env from '@/lib/env';
import app from '@/lib/app';
import {
  evaluateDlqHealth,
  DLQ_HEALTH_WINDOW_MS,
  DLQ_GROWTH_ALERT_THRESHOLD,
  type DlqHealthMetrics,
  type DlqHealthAlertReason,
} from '@/lib/relay/dlqHealthCheck';

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
    await sendDlqFallbackEmail({
      to: ownerEmail,
      teamSlug: team.slug,
      teamName: team.name,
      routeName: route.name,
      destinationHost: hostOnly(route.destination),
      failReason,
    });
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
