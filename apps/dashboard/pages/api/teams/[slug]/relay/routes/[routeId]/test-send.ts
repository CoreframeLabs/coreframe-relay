import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'node:crypto';

import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { fetchRoute, fetchRouteBySlugs } from 'models/route';
import { recordAuditEvent } from '@/lib/audit';
import type { AppEvent } from 'types';

/**
 * POST /api/teams/:slug/relay/routes/:routeId/test-send — [RELAY-50]
 *
 * Fires one synthetic webhook through the REAL ingest endpoint, using the same
 * `ingestToken` the route UI already exposes (`relayUrlFor`), so the button is a
 * true end-to-end probe of the pipeline rather than a mock or a direct DB write.
 *
 * The route is looked up THREE ways on purpose:
 *
 *   1. `fetchRoute` by id (team-scoped) — proves the id the caller named belongs
 *      to the team the session resolves to, before any credential is assembled.
 *   2. `fetchRouteBySlugs` by slugs — proves the slugs the URL will contain are the
 *      route the team actually owns, so the membership check cannot be fooled by a
 *      routeId that matches but a team slug that does not.
 *   3. Read the ingestToken ONLY from step 2's row — never from step 1's — because
 *      a token is a very long string and two routes inside one team can share a name.
 *
 * The envelope header `x-relay-event: test` is what turns the proxy's normal path
 * into a recorded test, so the DeliveryLog row (and the UI's badge, and the billing
 * exclusion) all read the same field. See `apps/proxy/src/routes/ingest.ts`.
 */

const TEST_PAYLOAD = JSON.stringify({
  event: 'test',
  note: 'Fired by Relay "Send test webhook"',
  at: () => new Date().toISOString(), // placeholder, filled below
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

    // Team-scoped id lookup FIRST, so a stale id belongs to no one.
    const route = await fetchRoute(user.team.id, routeId);
    if (!route) {
      return res.status(404).json({ error: { message: 'Route not found' } });
    }
    if (route.status !== 'ACTIVE' && route.status !== 'FAILING') {
      return res.status(409).json({ error: { message: 'Route is paused' } });
    }

    // Read the token through the slugs path so the URL below is the proxy's own view
    // of the route, not a value reconstructed client-side.
    const forIngest = await fetchRouteBySlugs(user.team.slug, route.slug);
    if (!forIngest) {
      return res.status(404).json({ error: { message: 'Route not found' } });
    }
    if (forIngest.status !== 'ACTIVE' && forIngest.status !== 'FAILING') {
      return res.status(409).json({ error: { message: 'Route is paused' } });
    }

    // The Bearer header is the secret the proxy's route-lookup requires; it is not
    // a credential this endpoint exchanges with the browser, so it never leaves
    // the server.
    const relayApiSecret = process.env.RELAY_API_SECRET;
    if (!relayApiSecret) {
      return res.status(500).json({ error: { message: 'Relay not configured' } });
    }

    const proxyBase = (process.env.RELAY_PROXY_URL || 'http://localhost:8787').replace(
      /\/+$/,
      ''
    );
    const ingestUrl = `${proxyBase}/in/${encodeURIComponent(user.team.slug)}/${encodeURIComponent(route.slug)}/${encodeURIComponent(forIngest.ingestToken)}`;

    const requestId = randomUUID();
    const nowIso = new Date().toISOString();
    const body = JSON.stringify({ ...JSON.parse(TEST_PAYLOAD), at: nowIso, requestId });

    // The test marker is set as a HEADER — the proxy reads it and stamps
    // `isTest: true` onto the envelope the queue publishes. Keeping the flag on the
    // envelope rather than in the body means it can be honored even if the caller's
    // payload is a valid non-JSON blob, and it is what the schema (`isTest.default
    // (false)`) expects.
    const proxyResponse = await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // RELAY-57's legacy header remains accepted during the migration window; a
        // test-send must work with the same auth paths a real sender can use.
        'x-relay-key': relayApiSecret,
        'x-relay-event': 'test',
        // Deterministic request id so the UI can poll for the row the consumer writes.
        'relay-request-id': requestId,
      },
      body,
    });

    const proxyPayload = (await proxyResponse.json().catch(() => ({}))) as {
      requestId?: string;
      status?: string;
    };

    if (!proxyResponse.ok) {
      // Deliberately no ingress-status detail in the success path: a 200 from the
      // proxy is enough, and on failure the caller should look at the queue and log,
      // not at an internal error body.
      return res.status(502).json({
        error: { message: 'Test webhook could not be enqueued' },
        proxyStatus: proxyResponse.status,
      });
    }

    await recordAuditEvent({
      teamId: user.team.id,
      // `AppEvent` is a closed union in types/base.ts and has no
      // `route.test_sent` member yet; the AuditLog.event column is a plain
      // string by design (see lib/audit.ts), so the row written is correct.
      // Tracked for the union fix in the dev log.
      event: 'route.test_sent' as unknown as AppEvent,
      actor: user.email,
      target: route.id,
      metadata: { name: route.name, slug: route.slug, requestId },
    });

    // Intentionally NOT counted: [RELAY-12]'s usage counter will read
    // DeliveryLog.isTest — counting here too would double-tick a synthetic event.

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
