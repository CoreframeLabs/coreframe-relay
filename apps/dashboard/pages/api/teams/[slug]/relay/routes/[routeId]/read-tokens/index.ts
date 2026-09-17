import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { fetchRoute } from 'models/route';
import { createReadToken, fetchReadTokensForRoute } from 'models/readToken';
import { recordAuditEvent } from '@/lib/audit';
import { recordMetric } from '@/lib/metrics';
import { validateWithSchema } from '@/lib/zod';
import { withTeamScope } from '@/lib/db/scope';

/**
 * GET|POST /api/teams/:slug/relay/routes/:routeId/read-tokens — [RELAY-119]
 *
 * Mint (POST) and list (GET) delivery read tokens for ONE route. The decision this
 * implements is `growth/product/relay-119-121-122-decision-2026-09-17.md` §1; the
 * threat model is `relay-119-auth-decision.md` §3 (Option B).
 *
 * WHY IT IS MOUNTED UNDER THE ROUTE, NOT UNDER /relay/read-tokens
 *   The route pin is structural: `fetchRoute(teamId, routeId)` is team-scoped, so a
 *   routeId from another team resolves to null and 404s — the RELAY-63 convention —
 *   before a token can be minted against it. There is no code path that takes a
 *   routeId from the body and has to remember to check it.
 *
 * WHO MAY CALL IT
 *   `throwIfNotAllowed(user, 'team', 'update')` on BOTH methods — ADMIN/OWNER. MEMBER
 *   may not even list: every credential-bearing resource the starter kit ships gates
 *   `read` the same way (`api-keys/index.ts`), and `destination-headers.ts` gates its
 *   GET on `update` for the same reason. ADMIN mints because the contractor building
 *   the n8n workflow is the person who needs it; OWNER can revoke anything ADMIN minted
 *   (same permission, `[tokenId].ts`). No new `Resource` union member — Relay's
 *   convention is to reuse `'team'/'update'` for anything that changes what the team
 *   exposes to the internet (`routes/index.ts` POST).
 *
 * WHAT THE RESPONSE CARRIES
 *   POST returns the plain token EXACTLY ONCE, under `Cache-Control: no-store`, and it
 *   is never stored, logged, or written to audit metadata (`rotate-token.ts` precedent).
 *   GET returns `PUBLIC_READ_TOKEN_SELECT` rows — prefix + lastFour, never the hash.
 *
 * NO DASHBOARD UI IN v1 — this is API-only, by design (decision §1 "Build order": the
 * per-route "mint read token" control hangs off RELAY-122's `canAccess` gate in
 * `RoutesTable.tsx`, which is a follow-up once 122 lands).
 */

const mintReadTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const teamMember = await throwIfNoTeamAccess(req, res);

    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({
        error: { message: `Method ${req.method} Not Allowed` },
      });
    }

    // [RELAY-84] `fetchRoute` and every models/readToken call below read/write
    // RLS-protected tables. Scope comes from the verified membership, never the slug
    // or routeId in the path — same reasoning as every sibling handler.
    await withTeamScope(teamMember.teamId, async () => {
      const user = await getCurrentUserWithTeam(req, res);
      // Listing shows which credentials exist and their last-used time; minting creates
      // one. Both are `update`-level — see the header.
      throwIfNotAllowed(user, 'team', 'update');

      const { routeId } = req.query;
      if (typeof routeId !== 'string' || routeId.length === 0) {
        res.status(400).json({ error: { message: 'routeId is required' } });
        return;
      }

      // Resolve within the team FIRST. A route id from another team is a 404
      // regardless of method or body.
      const route = await fetchRoute(user.team.id, routeId);
      if (!route) {
        res.status(404).json({ error: { message: 'Route not found.' } });
        return;
      }

      if (req.method === 'GET') {
        const tokens = await fetchReadTokensForRoute(user.team.id, route.id);
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ data: tokens });
        return;
      }

      const { name } = validateWithSchema(mintReadTokenSchema, req.body);

      const { token, row } = await createReadToken({
        teamId: user.team.id,
        routeId: route.id,
        name,
        createdByUserId: user.id,
      });

      await recordAuditEvent({
        teamId: user.team.id,
        event: 'relay.read_token.created',
        actor: user.email,
        target: row.id,
        // The token and its hash are deliberately ABSENT — an audit row that carries a
        // live credential is a second credential store with a worse access policy.
        metadata: {
          name: row.name,
          routeId: route.id,
          routeSlug: route.slug,
          lastFour: row.lastFour,
          expiresAt: row.expiresAt,
        },
      });

      recordMetric('relay.read_token.created');

      // The response carries a live credential; nothing downstream may keep it.
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        data: {
          // Hand-built, never `{ ...row }`, so a future column defaults to NOT exposed.
          id: row.id,
          teamId: row.teamId,
          routeId: row.routeId,
          name: row.name,
          prefix: row.prefix,
          lastFour: row.lastFour,
          scopes: row.scopes,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          // Shown once. The n8n `Relay Status API` credential takes this verbatim.
          token,
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
