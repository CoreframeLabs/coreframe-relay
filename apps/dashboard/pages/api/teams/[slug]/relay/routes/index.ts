import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { createRoute, fetchRoutes, relayUrlFor } from 'models/route';
import { recordAuditEvent } from '@/lib/audit';
import { recordMetric } from '@/lib/metrics';
import { validateWithSchema } from '@/lib/zod';
import { DestinationUrlSchema } from '@coreframe-relay/types';

/**
 * GET  /api/teams/:slug/relay/routes — list routes for the team
 * POST /api/teams/:slug/relay/routes — create one
 *
 * Follows BoxyHQ's existing handler shape (throwIfNoTeamAccess → throwIfNotAllowed →
 * per-method handler) so authorization behaves identically to every other team resource.
 * `throwIfNoTeamAccess` is what scopes the request to a team the caller belongs to;
 * everything below it uses that team's id and never one from the request body.
 */

const createRouteSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(64),
  destination: DestinationUrlSchema,
  // Bounded by QStash's retry budget, not an arbitrary number.
  maxRetries: z.number().int().min(1).max(10).default(7),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    await throwIfNoTeamAccess(req, res);

    switch (req.method) {
      case 'GET':
        await handleGET(req, res);
        break;
      case 'POST':
        await handlePOST(req, res);
        break;
      default:
        res.setHeader('Allow', 'GET, POST');
        res.status(405).json({
          error: { message: `Method ${req.method} Not Allowed` },
        });
    }
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;
    res.status(status).json({ error: { message } });
  }
}

const handleGET = async (req: NextApiRequest, res: NextApiResponse) => {
  const user = await getCurrentUserWithTeam(req, res);
  throwIfNotAllowed(user, 'team', 'read');

  const routes = await fetchRoutes(user.team.id);

  recordMetric('route.fetched');

  res.status(200).json({
    data: routes.map((route) => ({
      ...route,
      relayUrl: relayUrlFor(user.team.slug, route.slug),
    })),
  });
};

const handlePOST = async (req: NextApiRequest, res: NextApiResponse) => {
  const user = await getCurrentUserWithTeam(req, res);
  // Creating an ingestion endpoint changes what the team accepts from the internet, so it
  // is an update-level permission, not a read.
  throwIfNotAllowed(user, 'team', 'update');

  const { name, destination, maxRetries } = validateWithSchema(createRouteSchema, req.body);

  const route = await createRoute({
    teamId: user.team.id,
    name,
    destination,
    maxRetries,
  });

  await recordAuditEvent({
    teamId: user.team.id,
    event: 'route.created',
    actor: user.email,
    target: route.id,
    // Destination is recorded deliberately: "where did our webhooks start going, and who
    // pointed them there" is the question an audit trail exists to answer.
    metadata: { name: route.name, slug: route.slug, destination: route.destination },
  });

  recordMetric('route.created');

  res.status(201).json({
    data: { ...route, relayUrl: relayUrlFor(user.team.slug, route.slug) },
  });
};
