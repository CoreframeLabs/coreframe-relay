import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { fetchTeamDeliveryFeed, DELIVERY_FEED_MAX_ROWS } from 'models/delivery';
import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { validateWithSchema } from '@/lib/zod';
import { withTeamScope } from '@/lib/db/scope';

const querySchema = z.object({
  slug: z.string(),
  routeId: z.string().uuid().optional(),
  status: z.string().optional(),
  take: z.string().optional(),
});

/**
 * GET /api/teams/:slug/relay/log — snapshot of the delivery feed, used by the
 * "Send test webhook" button to wait for the row its own send just wrote.
 *
 * Shares the same query path as the SSE feed but answers ONCE, so a button that
 * only needs one row did not come with a socket that outlives the click. The shape
 * mirrors `fetchTeamDeliveryFeed`'s output but with `isTest` exposed — that column
 * is how the button can tell the user's row apart from the rest of the feed without
 * trusting the requestId alone.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: { message: 'Method Not Allowed' } });
    }

    const teamMember = await throwIfNoTeamAccess(req, res);

    // [RELAY-84] `fetchTeamDeliveryFeed` reads `DeliveryLog`, whose policy is
    // `EXISTS (SELECT 1 FROM "Route" r WHERE r.id = "routeId" AND r."teamId" =
    // current_setting('app.current_team_id', true))`. Unscoped that predicate is
    // never true, so under `relay_app` this endpoint answers `{ data: [] }` with a
    // 200 — the "Send test webhook" button would wait forever for a row that is
    // there. The scope id comes from the verified membership, never from the slug.
    await withTeamScope(teamMember.teamId, async () => {
      const user = await getCurrentUserWithTeam(req, res);
      throwIfNotAllowed(user, 'team', 'read');

      const query = validateWithSchema(querySchema, req.query);
      const take = Math.min(
        Math.max(Number(query.take ?? 25) || 25, 1),
        DELIVERY_FEED_MAX_ROWS
      );
      const filter = query.routeId ? { routeId: query.routeId } : {};

      const rows = await fetchTeamDeliveryFeed(user.team.id, filter, take);
      res.status(200).json({ data: rows });
    });
    return;
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;
    return res.status(status).json({ error: { message } });
  }
}
