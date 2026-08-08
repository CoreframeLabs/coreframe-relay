import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import {
  destinationHeaderNames,
} from '@/lib/relay/destinationAuth';
import { recordAuditEvent } from '@/lib/audit';
import { validateWithSchema } from '@/lib/zod';
import { prisma } from '@/lib/prisma';
import {
  fetchRoute,
  setRouteDestinationHeaders,
} from 'models/route';

/**
 * /api/teams/:slug/relay/routes/:routeId/destination-headers — [RELAY-59]
 *
 *   GET  → 200 { data: { names: string[] } }  — the names ONLY, sorted. Values are
 *                                                NEVER returned; "what auth do I have
 *                                                configured" is a masked list.
 *   PUT  → 200 { data: { names: string[] } }  — REPLACES the entire set. The body is
 *                                                the full map the route should carry.
 *   DELETE → 200 { data: { names: [] } }       — clears every header at once.
 *
 * Three rules this endpoint is built around:
 *
 * 1. **Values NEVER leave the server.** A successful PUT returns the same masked list
 *    a GET would, not the values it just stored. An audit row, a network response and
 *    a log line are equally places a customer's CRM token must not appear — and only
 *    this function's return type enforces that, not any caller's discipline.
 *
 * 2. **Replace, not patch.** A partial-update API is how an operator believes they
 *    changed one header and silently leaves every OTHER stale. Requiring the full map
 *    makes the response the same shape as the request: what you set is what you have.
 *    Removal is therefore "PUT the map without that name".
 *
 * 3. **Audit names the header NAMES, never the values.** The metadata a future
 *    auditor needs is "Bearer replaced at 14:02 by operator X", not the bearer itself.
 */

const putSchema = z.object({
  headers: z
    .record(z.string(), z.string())
    .refine((m) => Object.keys(m).length <= 8, 'at most 8 destination headers'),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    await throwIfNoTeamAccess(req, res);

    const user = await getCurrentUserWithTeam(req, res);
    const { routeId } = req.query;
    if (typeof routeId !== 'string' || routeId.length === 0) {
      return res.status(400).json({ error: { message: 'routeId is required' } });
    }

    switch (req.method) {
      case 'GET':
      case 'DELETE':
        throwIfNotAllowed(user, 'team', 'update');
        break;
      case 'PUT':
        throwIfNotAllowed(user, 'team', 'update');
        break;
      default:
        res.setHeader('Allow', 'GET, PUT, DELETE');
        return res.status(405).json({
          error: { message: `Method ${req.method} Not Allowed` },
        });
    }

    // Resolve the route within the team. `fetchRoute` already scopes by teamId, so a
    // route id from another team is a 404, not a forbidden write.
    const route = await fetchRoute(user.team.id, routeId);
    if (!route) {
      return res.status(404).json({ error: { message: 'Route not found.' } });
    }

    if (req.method === 'GET') {
      // Names only. Values are unreadable by design.
      const names = destinationHeaderNames(
        // The API `Route` type does not carry the encrypted column — it is
        // deliberately stripped in PUBLIC_ROUTE_SELECT. Re-read the raw value through a
        // dedicated select so this shape is a compiler error if the select ever widens.
        await routeWithHeadersCiphertext(user.team.id, routeId)
      );
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ data: { names } });
    }

    if (req.method === 'PUT') {
      const { headers } = validateWithSchema(putSchema, req.body);
      const view = await setRouteDestinationHeaders(user.team.id, routeId, headers);

      await recordAuditEvent({
        teamId: user.team.id,
        event: 'route.destination_headers_set',
        actor: user.email,
        target: route.id,
        metadata: {
          name: route.name,
          slug: route.slug,
          // NAMES ONLY. The values never appear in an audit row.
          headerNames: view.names,
        },
      });

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ data: view });
    }

    // DELETE
    const view = await setRouteDestinationHeaders(user.team.id, routeId, {});
    await recordAuditEvent({
      teamId: user.team.id,
      event: 'route.destination_headers_cleared',
      actor: user.email,
      target: route.id,
      metadata: { name: route.name, slug: route.slug },
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ data: view });
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;
    return res.status(status).json({ error: { message } });
  }
}

/**
 * Fetch ONLY the encrypted column, for the GET path above. Done as a tiny dedicated
 * select rather than widening `PUBLIC_ROUTE_SELECT`, because the moment the public
 * route shape carried ciphertext, an unrelated list endpoint would start shipping
 * encrypted-but-still-sensitive state to every browser.
 */
async function routeWithHeadersCiphertext(
  teamId: string,
  routeId: string
) {
  const row = await prisma.route.findFirst({
    where: { id: routeId, teamId },
    select: { destinationHeadersEncrypted: true },
  });
  return row?.destinationHeadersEncrypted ?? null;
}
