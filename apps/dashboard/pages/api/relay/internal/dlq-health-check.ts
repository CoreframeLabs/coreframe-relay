import type { NextApiRequest, NextApiResponse } from 'next';
import * as Sentry from '@sentry/nextjs';

import { timingSafeEqualSecrets } from '@/lib/relay/internalAuth';
import { unscopedPrisma } from '@/lib/prisma';
import {
  collectDlqHealthMetrics,
  evaluateDlqHealth,
  DLQ_GROWTH_ALERT_THRESHOLD,
} from '@/lib/relay/dlqHealthCheck';
import {
  notifyDlqGrowthThreshold,
  getDlqNotifySendFailureCount,
  formatDlqNotifySendFailureAlert,
} from '@/lib/relay/dlqNotify';

/**
 * GET /api/relay/internal/dlq-health-check   — [RELAY-44]
 * Authorization: Bearer {CRON_SECRET}
 *
 * Vercel Cron target (see `vercel.json` → `crons`). Queries DlqItem growth and
 * DeliveryLog failure ratio over the trailing window (`lib/relay/dlqHealthCheck.ts`) and
 * pages via Sentry when either documented threshold is breached — see that file for the
 * full reasoning on thresholds and why `unscopedPrisma` is required here.
 *
 * AUTH: `CRON_SECRET` IS THE VERCEL-MANDATED NAME, NOT `RELAY_API_SECRET`
 * ------------------------------------------------------------------------
 * Per Vercel's own docs (Cron Jobs → "Securing cron jobs"), setting a `CRON_SECRET`
 * project env var makes Vercel automatically attach `Authorization: Bearer
 * {CRON_SECRET}` to every invocation IT makes of a cron path. That auto-attachment is
 * keyed to that exact env var name — using `RELAY_API_SECRET` here instead would mean
 * nothing ever sends the header and every real cron invocation gets 401'd. Comparison
 * reuses `timingSafeEqualSecrets` from `lib/relay/internalAuth.ts` ([RELAY-5]) rather
 * than a fresh compare, for the same constant-time/fail-closed reasoning documented
 * there.
 *
 * MIDDLEWARE ALLOWLIST
 * ---------------------
 * This path is a session-free, machine-invoked endpoint, so it must be listed BY EXACT
 * PATH in `middleware.ts`'s `unAuthenticatedRoutes` — same requirement RELAY-5 documents
 * for `route-lookup` and `qstash`. Without that entry, Vercel's cron request (no NextAuth
 * session) gets 307-redirected to `/auth/login` before this handler — or its bearer
 * check — ever runs, and the cron "succeeds" against an HTML login page every time.
 *
 * CUSTOMER-FACING GROWTH ALERTING PIGGYBACKS ON THIS SAME CRON [RELAY-124]
 * --------------------------------------------------------------------------
 * The founder-only alert above is global (`unscopedPrisma`-wide counts, no team
 * scoping — see dlqHealthCheck.ts's module doc for why). RELAY-124 is the same idea
 * per customer route, so it deliberately reuses this cron's existing schedule rather
 * than registering a second `vercel.json` entry: one more step in the same handler,
 * `notifyDlqGrowthThreshold` per route (`lib/relay/dlqNotify.ts`), which calls the
 * exact same `evaluateDlqHealth` function above — just fed per-route counts instead of
 * global ones. Known limitation, acceptable at current scale: this is one query set
 * per route per invocation (no batching), same N+1 shape RELAY-44 accepted for the
 * global case being turned into N cases here.
 *
 * SWALLOWED DLQ NOTIFICATION SENDS ALSO PAGE HERE [RELAY-164]
 * -------------------------------------------------------------
 * `notifyDlqFallback` and `notifyDlqGrowthThreshold` (`lib/relay/dlqNotify.ts`) both
 * deliberately swallow every send error so a notification failure never turns a
 * successful DLQ write, or this cron's 200, into a retry-triggering failure — see that
 * file's module docs. That correctly-swallowed failure was previously invisible: no
 * metric, no log line, nothing this health check would ever catch. `dlqNotify.ts` now
 * keeps a best-effort, in-process count of those swallows (`getDlqNotifySendFailureCount`
 * — see its doc for why a module-level counter, not a DB query, and its honesty limit on
 * a serverless runtime); this handler reads it and pages, independently of the
 * `result.healthy`/per-route checks above, whenever that count is non-zero for the
 * trailing window. `formatDlqNotifySendFailureAlert` is a pure function purely so the
 * alert TEXT is testable without mocking Prisma/Sentry/this route.
 *
 * SENTRY SEVERITY — FLAGGED, NOT PROVEN
 * ----------------------------------------
 * Both alert paths below pass `level: 'error'` EXPLICITLY (the SDK's default for
 * `captureMessage` is `'info'`, per `sentry.client.config.ts` / `instrumentation.ts`
 * having no level override). This piggybacks on the dashboard's existing Sentry alert
 * rule (id 739692), which emails ActiveMembers on new/existing "high priority" issues.
 * Whether Sentry rule 739692's "high priority" condition actually matches an `'error'`
 * level (vs. e.g. requiring a specific issue-level filter, a tag, or `fatal`) is NOT
 * verified from this worktree — no Sentry MCP/API access here. Needs separate
 * confirmation against the live rule config before this can be trusted to actually page
 * anyone.
 */

function isAuthorizedCronRequest(req: NextApiRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error(
      '[relay] CRON_SECRET is not set — dlq-health-check is refusing every request.'
    );
    return false;
  }

  const header = req.headers.authorization;
  const match = /^Bearer\s+(.+)$/i.exec((header ?? '').trim());
  const provided = match?.[1]?.trim() ?? '';
  if (!provided) return false;

  return timingSafeEqualSecrets(provided, expected);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'bad_request' });
  }

  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const metrics = await collectDlqHealthMetrics(unscopedPrisma);
    const result = evaluateDlqHealth(metrics);

    if (!result.healthy) {
      if (result.reasons.includes('dlq_growth_exceeded')) {
        // Traffic-independent hard floor breach — treated as the more severe case per
        // an explicit Error so Sentry groups/traces it as an exception, not a log line.
        Sentry.captureException(
          new Error(
            `[RELAY-44] DLQ growth exceeded threshold: ${metrics.newDlqCount} new ` +
              `DlqItem rows in the last hour (threshold ${DLQ_GROWTH_ALERT_THRESHOLD}).`
          ),
          { level: 'error' }
        );
      }

      if (result.reasons.includes('delivery_failure_ratio_exceeded')) {
        Sentry.captureMessage(
          `[RELAY-44] Delivery failure ratio exceeded threshold: ` +
            `${((result.failureRatio ?? 0) * 100).toFixed(1)}% of ` +
            `${metrics.totalDeliveryAttempts} deliveries FAILED or DLQ'd in the last hour.`,
          { level: 'error' }
        );
      }
    }

    // [RELAY-124] Customer-facing per-route growth alerting — see module doc above.
    // Independent of the global `result` above: a route can cross its own growth
    // threshold while the deployment-wide counts still look healthy, and vice versa.
    const routes = await unscopedPrisma.route.findMany({
      select: { id: true, teamId: true },
    });

    const growthNotifications = await Promise.allSettled(
      routes.map((route) =>
        notifyDlqGrowthThreshold({ teamId: route.teamId, routeId: route.id })
      )
    );
    const routesNotified = growthNotifications.filter(
      (settled) => settled.status === 'fulfilled' && settled.value.notified
    ).length;

    // [RELAY-164] See module doc above — independent of `result.healthy`, since a
    // burst of swallowed notification sends (e.g. Resend's cap hit) is worth paging
    // on even when DLQ growth and delivery failure ratio both look fine.
    const swallowedSendFailureCount = getDlqNotifySendFailureCount();
    const swallowedSendFailureAlert = formatDlqNotifySendFailureAlert(
      swallowedSendFailureCount
    );
    if (swallowedSendFailureAlert) {
      Sentry.captureMessage(swallowedSendFailureAlert, { level: 'error' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      healthy: result.healthy,
      reasons: result.reasons,
      metrics: result.metrics,
      failureRatio: result.failureRatio,
      routesChecked: routes.length,
      routesNotified,
      swallowedSendFailureCount,
    });
  } catch (error) {
    console.error('[relay] dlq-health-check failed', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    return res.status(500).json({ error: 'internal_error' });
  }
}
