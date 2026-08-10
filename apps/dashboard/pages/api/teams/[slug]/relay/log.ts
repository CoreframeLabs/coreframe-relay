import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import {
  fetchTeamDeliveryFeed,
  DELIVERY_FEED_MAX_ROWS,
} from 'models/delivery';
import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { validateWithSchema } from '@/lib/zod';

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

    await throwIfNoTeamAccess(req, res);
    const user = await getCurrentUserWithTeam(req, res);
    throwIfNotAllowed(user, 'team', 'read');

    const query = validateWithSchema(querySchema, req.query);
    const take = Math.min(
      Math.max(Number(query.take ?? 25) || 25, 1),
      DELIVERY_FEED_MAX_ROWS
    );
    const filter = query.routeId ? { routeId: query.routeId } : {};

    const rows = await fetchTeamDeliveryFeed(user.team.id, filter, take);
    return res.status(200).json({ data: rows });
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;
    return res.status(status).json({ error: { message } });
  }
}
