import type { NextApiRequest, NextApiResponse } from 'next';

import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { fetchRoute } from 'models/route';
import { revokeReadToken } from 'models/readToken';
import { recordAuditEvent } from '@/lib/audit';
import { recordMetric } from '@/lib/metrics';
import { withTeamScope } from '@/lib/db/scope';

/**
 * DELETE /api/teams/:slug/relay/routes/:routeId/read-tokens/:tokenId — [RELAY-119]
 *
 * Soft-revokes one delivery read token (`revokedAt = now`). The row stays, so the list
 * view keeps the audit trail of what existed and when it was killed, and
 * `lastUsedAt` on a revoked token still tells an operator whether a leaked credential
 * was actually exercised before they caught it.
 *
 * Revocation is immediate on the read path: `pages/api/relay/deliveries.ts` checks
 * `revokedAt` on every request. There is deliberately NO grace window here — a token
 * is revoked because it may be compromised. Rotation without downtime is the
 * OPERATOR's sequence, not this endpoint's: mint the new one (`index.ts` POST), update
 * n8n, then revoke the old one. Two tokens may coexist for as long as that takes, which
 * is the one intended difference from `rotate-token.ts`'s hard cutover — this credential
 * lives in a store a human edits by hand.
 *
 * Same guard chain as every sibling: `throwIfNoTeamAccess` → `withTeamScope` →
 * `throwIfNotAllowed(user, 'team', 'update')` → team-scoped `fetchRoute` (cross-team
 * routeId → 404) → team-and-route-scoped `revokeReadToken` (cross-team or wrong-route
 * tokenId → 404, RELAY-63 convention).
 */

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const teamMember = await throwIfNoTeamAccess(req, res);

    if (req.method !== 'DELETE') {
      res.setHeader('Allow', 'DELETE');
      return res.status(405).json({
        error: { message: `Method ${req.method} Not Allowed` },
      });
    }

    await withTeamScope(teamMember.teamId, async () => {
      const user = await getCurrentUserWithTeam(req, res);
      // Killing a credential is a write — same gate as minting it.
      throwIfNotAllowed(user, 'team', 'update');

      const { routeId, tokenId } = req.query;
      if (typeof routeId !== 'string' || routeId.length === 0) {
        res.status(400).json({ error: { message: 'routeId is required' } });
        return;
      }
      if (typeof tokenId !== 'string' || tokenId.length === 0) {
        res.status(400).json({ error: { message: 'tokenId is required' } });
        return;
      }

      const route = await fetchRoute(user.team.id, routeId);
      if (!route) {
        res.status(404).json({ error: { message: 'Route not found.' } });
        return;
      }

      const row = await revokeReadToken(user.team.id, route.id, tokenId);
      if (!row) {
        res.status(404).json({ error: { message: 'Read token not found.' } });
        return;
      }

      await recordAuditEvent({
        teamId: user.team.id,
        event: 'relay.read_token.revoked',
        actor: user.email,
        target: row.id,
        metadata: {
          name: row.name,
          routeId: route.id,
          routeSlug: route.slug,
          lastFour: row.lastFour,
          lastUsedAt: row.lastUsedAt,
          revokedAt: row.revokedAt,
        },
      });

      recordMetric('relay.read_token.revoked');

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        data: {
          id: row.id,
          routeId: row.routeId,
          name: row.name,
          prefix: row.prefix,
          lastFour: row.lastFour,
          revokedAt: row.revokedAt,
          lastUsedAt: row.lastUsedAt,
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
