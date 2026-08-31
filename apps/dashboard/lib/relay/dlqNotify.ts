import { fetchRoute } from 'models/route';
import { getTeam, fetchTeamOwnerEmail } from 'models/team';
import { sendDlqFallbackEmail } from '@/lib/email/sendDlqFallbackEmail';

export type DlqFallbackParams = {
  teamId: string;
  routeId: string;
  requestId: string;
  failReason: string;
};

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

    // Host only, never the full URL (query strings can carry values a customer
    // considers sensitive) and never `destinationHeadersEncrypted` — this function
    // never even fetches that column. Falls back to the raw string only if `destination`
    // somehow is not a parseable URL, which `DestinationUrlSchema` should have already
    // ruled out at create time.
    let destinationHost = route.destination;
    try {
      destinationHost = new URL(route.destination).host;
    } catch {
      // Leave destinationHost as the raw string.
    }

    await sendDlqFallbackEmail({
      to: ownerEmail,
      teamSlug: team.slug,
      teamName: team.name,
      routeName: route.name,
      destinationHost,
      failReason,
    });
  } catch (error) {
    console.error('[relay] dlqNotify: failed to send DLQ fallback email', {
      requestId,
      name: error instanceof Error ? error.name : 'unknown',
    });
  }
}
