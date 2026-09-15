import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { getCurrentUserWithTeam, throwIfNoTeamAccess } from 'models/team';
import { throwIfNotAllowed } from 'models/user';
import { fetchRoute, relayUrlFor, updateRoute } from 'models/route';
// [RELAY-33] The DNS-RESOLVING check — see lib/relay/ssrfGap.ts before touching this
// import. `forward.ts` uses the same re-export for the same reason: a literal-only
// check would let a hostname that resolves to a blocked address straight through.
import { resolveAndValidateDestination } from '@/lib/relay/ssrfGap';
import { recordAuditEvent } from '@/lib/audit';
import { recordMetric } from '@/lib/metrics';
import { validateWithSchema } from '@/lib/zod';
import { withTeamScope } from '@/lib/db/scope';
import { DestinationUrlSchema } from '@coreframe-relay/types';

/**
 * PATCH /api/teams/:slug/relay/routes/:routeId — [RELAY-123]
 *
 * The gap this closes, verbatim from RELAY-66's own tracker entry: "the product has no
 * API to change a route's `destination` after creation." Before this file, the only
 * caller of `models/route.ts`'s `updateRoute` with an arbitrary destination was
 * test-send.ts's own catcher round-trip (points a route at a throwaway inbox for one
 * test send, then restores the original destination in a `finally`) — there was no
 * customer-facing way to do this on purpose and keep it.
 *
 * SCOPE, DELIBERATELY NARROW (see the ticket's own Problem Statement):
 *   - Session-cookie (NextAuth) authenticated ONLY, via the same
 *     `throwIfNoTeamAccess`/`withTeamScope`/`throwIfNotAllowed(user, 'team', 'update')`
 *     chain every other Relay write endpoint in this directory uses. A bearer-token/M2M
 *     surface is a separate, not-yet-decided ticket (RELAY-119) and is not touched here
 *     — mixing the two trust boundaries in one endpoint is exactly what the ticket warns
 *     against.
 *   - Three fields only: `destination`, `maxRetries`, `status`. `status` is restricted
 *     to `ACTIVE`/`PAUSED` (pause/resume) — `FAILING` is a system-observed state
 *     (apps/proxy's ingest.ts and this app's own delivery path set it from real
 *     delivery outcomes), not something a customer PATCHes into existence.
 *   - `name` is NOT accepted here, even though `models/route.ts`'s `updateRoute` and
 *     `@coreframe-relay/types`' `UpdateRouteSchema` both support it — the ticket names
 *     exactly three fields, and this handler defines its own narrower schema rather
 *     than reusing `UpdateRouteSchema` so that scope is enforced by the type the
 *     request is validated against, not by a comment asking a future editor not to
 *     widen it.
 *
 * [RELAY-63] A `routeId` that exists but belongs to another team 404s, the same
 * anti-enumeration convention `destination-headers.ts` and `rotate-token.ts` already
 * use: `fetchRoute` is teamId-scoped, so a cross-team id simply does not resolve and the
 * response is identical to a routeId that never existed at all.
 *
 * [RELAY-33] Any PATCH that changes `destination` re-validates the NEW value through
 * `resolveAndValidateDestination` — the same DNS-resolving check `forward.ts` runs
 * immediately before every outbound send — before it is ever persisted. This is
 * deliberately in ADDITION to, not instead of, forward.ts's own re-check at send time
 * (a hostname's record can change again between this PATCH and the next delivery, and
 * only a check performed immediately before the connect actually closes that window).
 * Rejecting here turns "a bad destination silently fails on the next delivery attempt"
 * into an immediate, explicit 422 the caller sees synchronously — but even if this
 * check were somehow bypassed, forward.ts's own gate is what actually stops the
 * outbound request, so this is defence in depth, not the only lock on the door.
 */

const patchRouteSchema = z
  .object({
    destination: DestinationUrlSchema.optional(),
    maxRetries: z.number().int().min(1).max(10).optional(),
    status: z.enum(['ACTIVE', 'PAUSED']).optional(),
  })
  .refine(
    (body) =>
      body.destination !== undefined ||
      body.maxRetries !== undefined ||
      body.status !== undefined,
    { message: 'At least one of destination, maxRetries, or status is required.' }
  );

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const teamMember = await throwIfNoTeamAccess(req, res);

    if (req.method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH');
      return res.status(405).json({
        error: { message: `Method ${req.method} Not Allowed` },
      });
    }

    // [RELAY-84] `fetchRoute`/`updateRoute` both read/write the RLS-protected `Route`
    // table. Scope comes from the verified membership, never the slug or routeId in
    // the path — same reasoning as every sibling handler in this directory.
    await withTeamScope(teamMember.teamId, async () => {
      const user = await getCurrentUserWithTeam(req, res);
      // Editing a route's destination, retry budget, or pause state changes what the
      // team accepts from / forwards to the internet — an update-level permission,
      // same gate routes/index.ts's POST and rotate-token.ts use.
      throwIfNotAllowed(user, 'team', 'update');

      const { routeId } = req.query;
      if (typeof routeId !== 'string' || routeId.length === 0) {
        res.status(400).json({ error: { message: 'routeId is required' } });
        return;
      }

      // Resolve within the team FIRST, before touching the body. A route id from
      // another team is a 404 regardless of what the PATCH body contains.
      const existing = await fetchRoute(user.team.id, routeId);
      if (!existing) {
        res.status(404).json({ error: { message: 'Route not found.' } });
        return;
      }

      const { destination, maxRetries, status } = validateWithSchema(
        patchRouteSchema,
        req.body
      );

      const data: {
        destination?: string;
        maxRetries?: number;
        status?: 'ACTIVE' | 'PAUSED';
      } = {};

      if (destination !== undefined) {
        const check = await resolveAndValidateDestination(destination);
        if (!check.ok) {
          res.status(422).json({
            error: { message: `destination rejected: ${check.reason}` },
          });
          return;
        }
        data.destination = destination;
      }
      if (maxRetries !== undefined) data.maxRetries = maxRetries;
      if (status !== undefined) data.status = status;

      const route = await updateRoute(user.team.id, routeId, data);

      await recordAuditEvent({
        teamId: user.team.id,
        event: 'route.updated',
        actor: user.email,
        target: route.id,
        // What changed, and the NEW values only — same shape as route.created's own
        // audit event, which records destination for the same "where did our webhooks
        // start going, and who pointed them there" reason.
        metadata: {
          name: route.name,
          slug: route.slug,
          changed: Object.keys(data),
          ...(data.destination !== undefined
            ? { destination: route.destination }
            : {}),
          ...(data.maxRetries !== undefined
            ? { maxRetries: route.maxRetries }
            : {}),
          ...(data.status !== undefined ? { status: route.status } : {}),
        },
      });

      recordMetric('route.updated');
      if (data.status === 'PAUSED') recordMetric('route.paused');
      if (data.status === 'ACTIVE') recordMetric('route.resumed');

      // Cache headers: the response echoes the route's live configuration, including
      // its relayUrl (which embeds the ingest token) — same reasoning rotate-token.ts
      // documents for the identical field.
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        data: {
          id: route.id,
          teamId: route.teamId,
          name: route.name,
          slug: route.slug,
          destination: route.destination,
          maxRetries: route.maxRetries,
          status: route.status,
          createdAt: route.createdAt,
          updatedAt: route.updatedAt,
          relayUrl: relayUrlFor(user.team.slug, route.slug, route.ingestToken),
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
