import type { NextApiRequest, NextApiResponse } from 'next';

import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { relayUrlFor, rotateIngestToken } from 'models/route';
import { recordAuditEvent } from '@/lib/audit';
import { recordMetric } from '@/lib/metrics';

/**
 * POST /api/teams/:slug/relay/routes/:routeId/rotate-token — [RELAY-57]
 *
 * Issues a fresh `ingestToken` for the route. Revocation is IMMEDIATE: the proxy
 * compares the path segment against the stored token, and `updateMany` makes the old
 * value unreadable in the same statement that writes the new one. There is no overlap
 * window; a token is rotated because it may be compromised, and a grace period is
 * precisely the window that matters.
 *
 * The raw token is returned exactly once, embedded in the new `relayUrl`, and is never
 * echoed to a log line, an audit metadata field, or an error body.
 */

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    await throwIfNoTeamAccess(req, res);

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({
        error: { message: `Method ${req.method} Not Allowed` },
      });
    }

    const user = await getCurrentUserWithTeam(req, res);
    // Rotating a credential is a write, not a read — same gate as creating the route.
    throwIfNotAllowed(user, 'team', 'update');

    const { routeId } = req.query;
    if (typeof routeId !== 'string' || routeId.length === 0) {
      return res.status(400).json({ error: { message: 'routeId is required' } });
    }

    const route = await rotateIngestToken(user.team.id, routeId);

    await recordAuditEvent({
      teamId: user.team.id,
      event: 'route.token_rotated',
      actor: user.email,
      target: route.id,
      // The new token is deliberately ABSENT. An audit row that carries a live
      // credential stops being an audit trail and starts being a second credential
      // store with a worse access policy.
      metadata: { name: route.name, slug: route.slug },
    });

    recordMetric('route.token_rotated');

    // Cache headers: the response carries a live credential, so nothing downstream may
    // keep it. `no-store` beats `no-cache`: an intermediary holding the old URL keeps
    // a revoked secret, an intermediary holding the new one is the leak.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      data: {
        ...route,
        relayUrl: relayUrlFor(user.team.slug, route.slug, route.ingestToken),
      },
    });
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;
    return res.status(status).json({ error: { message } });
  }
}
