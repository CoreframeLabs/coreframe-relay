import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { isAuthorizedInternalRequest } from '@/lib/relay/internalAuth';
import { fetchRouteBySlugs } from 'models/route';
import { RouteLookupResponseSchema } from '@coreframe-relay/types/internal';

/**
 * GET /api/relay/internal/route-lookup?teamSlug=…&routeSlug=…   — [RELAY-5]
 * Authorization: Bearer {RELAY_API_SECRET}
 *
 * The machine-to-machine half of the contract pinned in
 * `packages/types/src/internal.ts`. The proxy runs on Cloudflare Workers with no database
 * connection — deliberately, because an internet-facing edge Worker holding a Postgres
 * credential would put the whole tenant table one bug away from the open internet — so it
 * asks here for the single route it needs to accept and queue a webhook.
 *
 * Three properties this endpoint is built around:
 *
 * 1. **It is not session-authenticated and must never fall through to a route that is.**
 *    `middleware.ts` matches every path except a short allowlist and redirects anything
 *    without a NextAuth token to `/auth/login`. An unauthenticated proxy call would
 *    therefore get a 307 to an HTML login page rather than a 401, which is unparseable
 *    garbage to a Worker. This exact path is listed in that allowlist, and the bearer
 *    check below is then the ONLY thing standing in front of the data.
 *
 * 2. **The error bodies are fixed strings and carry no detail.** "Team exists but route
 *    does not" is a tenant-enumeration oracle for anyone holding the secret, and this
 *    endpoint answers before any customer auth has happened. A missing team, a missing
 *    route and a typo in either are all `404 {"error":"not_found"}`.
 *
 * 3. **The response is shaped by the schema, not by the ORM.** `RouteLookupResponseSchema`
 *    is parsed on the way out; Zod strips every key it does not declare, so adding a
 *    column to `Route` later cannot silently start leaking it to the proxy.
 */

const querySchema = z.object({
  teamSlug: z.string().min(1).max(255),
  routeSlug: z.string().min(1).max(64),
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Method check first: an endpoint that only reads should not accept a write verb, and
  // rejecting it before the secret comparison keeps the auth path to a single shape.
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'bad_request' });
  }

  if (!isAuthorizedInternalRequest(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const query = querySchema.safeParse({
    teamSlug: req.query.teamSlug,
    routeSlug: req.query.routeSlug,
  });
  if (!query.success) {
    // 400 rather than 404: this is the caller sending a malformed request, which is a
    // proxy bug worth surfacing, and it reveals nothing about what does or does not exist.
    return res.status(400).json({ error: 'bad_request' });
  }

  try {
    const route = await fetchRouteBySlugs(
      query.data.teamSlug,
      query.data.routeSlug
    );

    if (!route) {
      return res.status(404).json({ error: 'not_found' });
    }

    // NOTE: the contract's 404 case also names "route is ARCHIVED", but the `RouteStatus`
    // enum landed in [RELAY-2] has only ACTIVE / PAUSED / FAILING — there is no ARCHIVED
    // state to filter on. Nothing is silently dropped here: `status` is returned and the
    // proxy decides what to do with a PAUSED route. If ARCHIVED is ever added to the enum
    // it must be filtered out HERE, or an archived route keeps accepting traffic.
    const body = RouteLookupResponseSchema.parse({
      routeId: route.id,
      teamId: route.teamId,
      destination: route.destination,
      maxRetries: route.maxRetries,
      status: route.status,
    });

    // Caching is the proxy's business (ROUTE_LOOKUP_CACHE_TTL_SECONDS), but this response
    // is tenant data and must never sit in a shared or intermediary cache.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(body);
  } catch (error) {
    // Never echo the thrown message: it can carry a destination URL or a connection
    // string, and the correct amount of that for a caller to see is none.
    console.error('[relay] route-lookup failed', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    return res.status(500).json({ error: 'internal_error' });
  }
}
