import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'node:crypto';

import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { fetchRoute, fetchRouteBySlugs, updateRoute } from 'models/route';
import { generateCatcherToken } from '@/lib/relay/catcherTokens';
import { recordAuditEvent } from '@/lib/audit';
import { withTeamScope } from '@/lib/db/scope';

/**
 * POST /api/teams/:slug/relay/routes/:routeId/test-send — [RELAY-50]
 *
 * Fires one synthetic webhook through the REAL ingest endpoint, using the route's own
 * ingestToken derived server-side, so the button is a true end-to-end probe of the
 * pipeline rather than a mock or a direct DB write. The `x-relay-event: test` header
 * is what turns the proxy's normal path into a recorded test — and it is the ONLY
 * thing the button changes: the queue, the forward, the timeout, the retry counting,
 * and the DeliveryLog row all run exactly as they do for a real webhook. The point
 * of the ticket is that there is no second implementation of delivery for tests.
 *
 * The `?catcher=true` variant is the onboarding unlock the AC names: it mints a
 * catcher inbox, points the route at it for the duration of the one send, and
 * restores the original destination in a finally so a mid-send deploy or a proxy
 * that never answers does not leave the route pointed at an inbox nobody can see.
 */

const TEST_PAYLOAD = JSON.stringify({
  event: 'test',
  note: 'Fired by Relay "Send test webhook"',
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const teamMember = await throwIfNoTeamAccess(req, res);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: { message: 'Method Not Allowed' } });
    }

    // [RELAY-84] Four RLS-protected reads/writes live below: `fetchRoute`,
    // `fetchRouteBySlugs`, the catcher's two `updateRoute` calls, and the
    // `AuditLog` insert. Unscoped under `relay_app` the FIRST of them returns null
    // and the endpoint 404s — so the "Send test webhook" button would report
    // "Route not found" for a route the user is looking at. Worse for the catcher
    // path: if the point-at-catcher `updateRoute` succeeded and the restore in the
    // `finally` did not, a customer's route would be left aimed at a throwaway
    // inbox. Both arms are inside one scope so they cannot disagree.
    //
    // `fetchRouteBySlugs` opens its OWN `withTeamScope` (models/route.ts) from a
    // team it resolves by slug. That nests inside this one; `lib/db/scope.ts`
    // documents nesting as innermost-wins, and here both ids are the same verified
    // team, so the nesting is a no-op rather than a widening.
    await withTeamScope(teamMember.teamId, async () => {
      const user = await getCurrentUserWithTeam(req, res);
      // Sending to a destination the team OWNS is a write-level action.
      throwIfNotAllowed(user, 'team', 'update');

      const { routeId } = req.query;
      if (typeof routeId !== 'string' || routeId.length === 0) {
        res.status(400).json({ error: { message: 'routeId is required' } });
        return;
      }
      const useCatcher =
        req.query.catcher === 'true' ||
        (Array.isArray(req.query.catcher) && req.query.catcher[0] === 'true');

      // Team-scoped id lookup FIRST, so a stale id belongs to no one.
      const route = await fetchRoute(user.team.id, routeId);
      if (!route) {
        res.status(404).json({ error: { message: 'Route not found' } });
        return;
      }
      if (route.status !== 'ACTIVE' && route.status !== 'FAILING') {
        res.status(409).json({ error: { message: 'Route is paused' } });
        return;
      }

      // Read the ingest token through the slugs path so the URL below is the proxy's own
      // view of the route, not a value reconstructed client-side. The RoutesTable's
      // reveal UI is the only other place this field leaves the server, and it follows
      // the same shape.
      const forIngest = await fetchRouteBySlugs(user.team.slug, route.slug);
      if (!forIngest) {
        res.status(404).json({ error: { message: 'Route not found' } });
        return;
      }
      if (forIngest.status !== 'ACTIVE' && forIngest.status !== 'FAILING') {
        res.status(409).json({ error: { message: 'Route is paused' } });
        return;
      }

      const proxyBase = (
        process.env.RELAY_PROXY_URL || 'http://localhost:8787'
      ).replace(/\/+$/, '');
      const ingestUrl = `${proxyBase}/in/${encodeURIComponent(user.team.slug)}/${encodeURIComponent(route.slug)}/${encodeURIComponent(forIngest.ingestToken)}`;

      const requestId = randomUUID();
      const body = JSON.stringify({
        ...(JSON.parse(TEST_PAYLOAD) as Record<string, unknown>),
        at: new Date().toISOString(),
        requestId,
      });

      let originalDestination: string | null = null;
      if (useCatcher) {
        originalDestination = route.destination;
        const token = generateCatcherToken();
        const dashboardBase = (
          process.env.APP_URL ||
          process.env.NEXTAUTH_URL ||
          'http://localhost:4002'
        ).replace(/\/+$/, '');
        const catcherUrl = `${dashboardBase}/api/relay/catcher/${token}`;
        await updateRoute(user.team.id, route.id, { destination: catcherUrl });
      }

      // try/finally so the route's destination is restored even when the proxy never
      // answers — a test that points the route at the catcher and then dies leaves an
      // operator's real webhooks writing to an inbox they never asked for.
      let proxyResponse: Response;
      try {
        proxyResponse = await fetch(ingestUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // RELAY-57's path token IS the credential — no legacy header, no second
            // credential to audit, and the proxy ignores X-Relay-Key when one does
            // arrive alongside.
            'x-relay-event': 'test',
            // Deterministic request id so the UI can poll for the row the consumer writes.
            'relay-request-id': requestId,
          },
          body,
        });
      } finally {
        if (useCatcher && originalDestination !== null) {
          try {
            await updateRoute(user.team.id, route.id, {
              destination: originalDestination,
            });
          } catch (revertError) {
            console.error('[relay] test-send failed to restore destination', {
              routeId: route.id,
              requestId,
              name: revertError instanceof Error ? revertError.name : 'unknown',
            });
          }
        }
      }

      const proxyPayload = (await proxyResponse.json().catch(() => ({}))) as {
        requestId?: string;
        status?: string;
      };

      if (!proxyResponse.ok) {
        // Deliberately no internal detail on the failure body: a 200 from the proxy is
        // enough on success, and on failure the queue is the place that has the truth —
        // not an internal error string echoed to the caller.
        res.status(502).json({
          error: { message: 'Test webhook could not be enqueued' },
          proxyStatus: proxyResponse.status,
        });
        return;
      }

      await recordAuditEvent({
        teamId: user.team.id,
        // `route.test_sent` is in the `AppEvent` union (types/base.ts).
        event: 'route.test_sent',
        actor: user.email,
        target: route.id,
        metadata: {
          name: route.name,
          slug: route.slug,
          requestId,
          usedCatcher: useCatcher,
        },
      });

      // DELIBERATELY no recordMetric here — [RELAY-12]'s usage counter reads
      // DeliveryLog.isTest on the row itself, and double-counting a synthetic event
      // here would defeat that flag's entire purpose.

      res.status(200).json({
        data: {
          requestId: proxyPayload.requestId ?? requestId,
          status: proxyPayload.status ?? 'queued',
        },
      });
    });
    return;
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;
    return res.status(status).json({ error: { message } });
  }
}
