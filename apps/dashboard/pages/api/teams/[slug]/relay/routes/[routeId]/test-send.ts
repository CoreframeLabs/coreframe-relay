import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'node:crypto';

import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { fetchRoute, fetchRouteBySlugs, updateRoute } from 'models/route';
import { generateCatcherToken } from '@/lib/relay/catcherTokens';
import { recordAuditEvent } from '@/lib/audit';

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
    await throwIfNoTeamAccess(req, res);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: { message: 'Method Not Allowed' } });
    }

    const user = await getCurrentUserWithTeam(req, res);
    // Sending to a destination the team OWNS is a write-level action.
    throwIfNotAllowed(user, 'team', 'update');

    const { routeId } = req.query;
    if (typeof routeId !== 'string' || routeId.length === 0) {
      return res.status(400).json({ error: { message: 'routeId is required' } });
    }
    const useCatcher =
      req.query.catcher === 'true' ||
      (Array.isArray(req.query.catcher) && req.query.catcher[0] === 'true');

    // Team-scoped id lookup FIRST, so a stale id belongs to no one.
    const route = await fetchRoute(user.team.id, routeId);
    if (!route) {
      return res.status(404).json({ error: { message: 'Route not found' } });
    }
    if (route.status !== 'ACTIVE' && route.status !== 'FAILING') {
      return res.status(409).json({ error: { message: 'Route is paused' } });
    }

    // Read the ingest token through the slugs path so the URL below is the proxy's own
    // view of the route, not a value reconstructed client-side. The RoutesTable's
    // reveal UI is the only other place this field leaves the server, and it follows
    // the same shape.
    const forIngest = await fetchRouteBySlugs(user.team.slug, route.slug);
    if (!forIngest) {
      return res.status(404).json({ error: { message: 'Route not found' } });
    }
    if (forIngest.status !== 'ACTIVE' && forIngest.status !== 'FAILING') {
      return res.status(409).json({ error: { message: 'Route is paused' } });
    }

    const proxyBase = (process.env.RELAY_PROXY_URL || 'http://localhost:8787').replace(
      /\/+$/,
      ''
    );
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
      return res.status(502).json({
        error: { message: 'Test webhook could not be enqueued' },
        proxyStatus: proxyResponse.status,
      });
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

    return res.status(200).json({
      data: {
        requestId: proxyPayload.requestId ?? requestId,
        status: proxyPayload.status ?? 'queued',
      },
    });
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;
    return res.status(status).json({ error: { message } });
  }
}
