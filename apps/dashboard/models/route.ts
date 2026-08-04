import { prisma } from '@/lib/prisma';
import { ApiError } from '@/lib/errors';
import type { Prisma, Route, RouteStatus } from '@prisma/client';

/**
 * Route data access. Added in [RELAY-6].
 *
 * EVERY function here takes `teamId` and filters on it. That is not defensive style, it
 * is the tenant boundary: a route id is a UUID a user can hold from one team while
 * authenticated to another, and a lookup by id alone would be an IDOR. [RELAY-9] tests
 * exactly this ("Team A cannot access Team B routes"), so the constraint is expressed
 * here where it cannot be forgotten at a call site.
 */

/** Reserved because they would collide with real or future proxy paths. */
const RESERVED_SLUGS = new Set([
  'health',
  'in',
  'api',
  'gate',
  'admin',
  'new',
  'edit',
]);

/**
 * Derive a URL-safe slug from a human name. Deliberately lossy and then validated —
 * this value becomes a public path segment.
 */
export function slugifyRouteName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

export async function fetchRoutes(teamId: string): Promise<Route[]> {
  return prisma.route.findMany({
    where: { teamId },
    orderBy: { createdAt: 'desc' },
  });
}

/** Scoped by teamId on purpose — see the note at the top of this file. */
export async function fetchRoute(
  teamId: string,
  id: string
): Promise<Route | null> {
  return prisma.route.findFirst({ where: { id, teamId } });
}

/**
 * Lookup by the two PUBLIC slugs, for the internal proxy endpoint only. Added in
 * [RELAY-5].
 *
 * This is the one function in this file that does not take a `teamId`, and the exception
 * is deliberate rather than an oversight: the caller is the proxy, which is handling a
 * request from the open internet and knows nothing except the two path segments
 * `/in/:teamSlug/:routeSlug`. The team slug IS the tenant scope here, and it is matched
 * as a join condition rather than looked up separately, so a route can never be returned
 * against a team it does not belong to.
 *
 * The `select` is the response contract, not a convenience. The proxy is the least
 * trusted component in the system, so it receives the five fields ingestion needs and no
 * team name, plan, or sibling route.
 */
export async function fetchRouteBySlugs(
  teamSlug: string,
  routeSlug: string
): Promise<Pick<
  Route,
  'id' | 'teamId' | 'destination' | 'maxRetries' | 'status'
> | null> {
  return prisma.route.findFirst({
    where: { slug: routeSlug, team: { slug: teamSlug } },
    select: {
      id: true,
      teamId: true,
      destination: true,
      maxRetries: true,
      status: true,
    },
  });
}

export async function createRoute(params: {
  teamId: string;
  name: string;
  destination: string;
  maxRetries: number;
}): Promise<Route> {
  const base = slugifyRouteName(params.name);
  if (!base) {
    throw new ApiError(
      422,
      'Route name must contain at least one letter or digit.'
    );
  }
  if (RESERVED_SLUGS.has(base)) {
    throw new ApiError(
      422,
      `"${base}" is reserved. Please choose another name.`
    );
  }

  // Slug is unique per team, so a second "Stripe" gets "stripe-2". Suffixing beats
  // rejecting: the name is the user's label, and forcing them to invent a unique one is
  // friction with no benefit.
  const taken = new Set(
    (
      await prisma.route.findMany({
        where: { teamId: params.teamId, slug: { startsWith: base } },
        select: { slug: true },
      })
    ).map((r) => r.slug)
  );

  let slug = base;
  for (let n = 2; taken.has(slug); n++) {
    slug = `${base}-${n}`;
    if (n > 999) throw new ApiError(422, 'Too many routes share that name.');
  }

  return prisma.route.create({
    data: {
      teamId: params.teamId,
      name: params.name,
      slug,
      destination: params.destination,
      maxRetries: params.maxRetries,
    },
  });
}

export async function updateRoute(
  teamId: string,
  id: string,
  data: Prisma.RouteUpdateInput & { status?: RouteStatus }
): Promise<Route> {
  // updateMany, not update: `update` matches on the primary key alone and would happily
  // write across tenants. This form makes teamId part of the WHERE.
  const { count } = await prisma.route.updateMany({
    where: { id, teamId },
    data,
  });
  if (count === 0) throw new ApiError(404, 'Route not found.');

  const route = await fetchRoute(teamId, id);
  if (!route) throw new ApiError(404, 'Route not found.');
  return route;
}

export async function deleteRoute(teamId: string, id: string): Promise<void> {
  const { count } = await prisma.route.deleteMany({ where: { id, teamId } });
  if (count === 0) throw new ApiError(404, 'Route not found.');
}

/**
 * The public ingestion URL for a route.
 *
 * Built from an env var rather than the request host: the proxy is a different origin
 * from the dashboard, and deriving it from `req.headers.host` would emit a dashboard URL
 * that accepts no webhooks.
 */
export function relayUrlFor(teamSlug: string, routeSlug: string): string {
  const base = (process.env.RELAY_PROXY_URL || 'http://localhost:8787').replace(
    /\/+$/,
    ''
  );
  return `${base}/in/${teamSlug}/${routeSlug}`;
}
