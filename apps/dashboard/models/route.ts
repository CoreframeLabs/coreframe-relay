import { prisma, unscopedPrisma } from '@/lib/prisma';
import { withTeamScope } from '@/lib/db/scope';
import { ApiError } from '@/lib/errors';
import { generateIngestToken } from '@/lib/relay/ingestToken';
import {
  destinationHeaderNames,
  encryptDestinationHeaders,
} from '@/lib/relay/destinationAuth';
import type { Route, RouteStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';

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

/**
 * The route fields ANY API or page is allowed to see by default. Everything EXCEPT
 * two columns:
 *
 *   - `ingestToken` (RELAY-57) is recoverable only by forming the URL via
 *     `relayUrlFor`, which constructs the path segment on demand and never lets the
 *     token live as a plain fetched value
 *   - `destinationHeadersEncrypted` (RELAY-59) is decryptable only at forward time in
 *     the qstash consumer, and is NEVER travelled over the wire or into a model
 *     caller's object
 *
 * A route that needs those two names them via a dedicated pick, so the compiler makes
 * narrowing an explicit act.
 */
export const PUBLIC_ROUTE_SELECT = {
  id: true,
  teamId: true,
  name: true,
  slug: true,
  destination: true,
  maxRetries: true,
  status: true,
  ingestToken: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** A route as the API/UI sees it. No ciphertext, no destination headers. */
export type PublicRoute = {
  id: string;
  teamId: string;
  name: string;
  slug: string;
  destination: string;
  maxRetries: number;
  status: RouteStatus;
  ingestToken: string;
  createdAt: Date;
  updatedAt: Date;
};

export async function fetchRoutes(teamId: string): Promise<PublicRoute[]> {
  return prisma.route.findMany({
    where: { teamId },
    orderBy: { createdAt: 'desc' },
    select: PUBLIC_ROUTE_SELECT,
  });
}

/** Scoped by teamId on purpose — see the note at the top of this file. */
export async function fetchRoute(
  teamId: string,
  id: string
): Promise<PublicRoute | null> {
  return prisma.route.findFirst({ where: { id, teamId }, select: PUBLIC_ROUTE_SELECT });
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
 *
 * [RELAY-57] `ingestToken` is selected so the PROXY can run its constant-time digest
 * compare against the caller's path segment. Contract rationale lives on the schema in
 * `packages/types/src/internal.ts`; the short version is "dashboard-side compare would
 * put the raw token on an internal wire the proxy controls, so it is compared
 * proxy-side and never re-transmitted".
 */
export async function fetchRouteBySlugs(
  teamSlug: string,
  routeSlug: string
): Promise<Pick<
  Route,
  'id' | 'teamId' | 'destination' | 'maxRetries' | 'status' | 'ingestToken'
> | null> {
  // [RELAY-39 wiring] Under the combined filter, RLS on `Route` applies to the
  // Route-side of the implicit JOIN, so once `DATABASE_URL` points at
  // `relay_app` the old form returned NULL unless the ambient scope happened to
  // match — which here is never. Resolve `Team` by slug first (Team has no RLS
  // policy, so the unscoped client answers honestly), then look the route up
  // inside a `withTeamScope` derived from THAT row — the database, never the
  // request. A bogus slug still 404s because the team does not resolve.
  const team = await unscopedPrisma.team.findUnique({
    where: { slug: teamSlug },
    select: { id: true },
  });
  if (!team) {
    return null;
  }
  return withTeamScope(team.id, () =>
    prisma.route.findFirst({
      where: { slug: routeSlug, teamId: team.id },
      select: {
        id: true,
        teamId: true,
        destination: true,
        maxRetries: true,
        status: true,
        ingestToken: true,
      },
    })
  );
}

/**
 * The QStash consumer's read of the route at forward time. [RELAY-59] This is the ONE
 * place `destinationHeadersEncrypted` legitimately crosses a function boundary: to be
 * decrypted by `lib/relay/destinationAuth.ts` and applied to the outbound request.
 * Not exposed by any API. Scoped by teamId against the envelope the caller is already
 * holding, so a route tampered mid-queue to point at another team's row never yields
 * its headers here.
 */
export async function fetchRouteForDelivery(
  teamId: string,
  routeId: string
): Promise<{
  id: string;
  destination: string;
  destinationHeadersEncrypted: Prisma.JsonValue | null;
} | null> {
  return prisma.route.findFirst({
    where: { id: routeId, teamId },
    select: { id: true, destination: true, destinationHeadersEncrypted: true },
  });
}

export async function createRoute(params: {
  teamId: string;
  name: string;
  destination: string;
  maxRetries: number;
  destinationHeaders?: Record<string, string>;
}): Promise<PublicRoute> {
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
      // [RELAY-57] generated at create, never defaulted by the ORM.
      ingestToken: generateIngestToken(),
      // [RELAY-59] encrypted before it ever reaches a column. `Prisma.InputJsonValue`
      // covers the map of base64 envelopes; an empty map is stored as NULL so a route
      // with no configured auth carries no crypto material at all.
      destinationHeadersEncrypted:
        params.destinationHeaders && Object.keys(params.destinationHeaders).length > 0
          ? (encryptDestinationHeaders(params.destinationHeaders) as Prisma.InputJsonValue)
          : Prisma.DbNull,
    },
    // IMPORTANT: do NOT `{}` the whole record. `Route` now carries
    // `destinationHeadersEncrypted` and nothing outside this module may see it.
    select: PUBLIC_ROUTE_SELECT,
  });
}

/**
 * Issue a fresh ingest token for a route, revoking the old one — [RELAY-57].
 *
 * updateMany on `{ id, teamId }` for the same IDOR reason as `updateRoute`. There is no
 * grace period: a token rotates because someone believes it is compromised, and a
 * "keep the old one working" window is precisely the window the compromise exploits.
 * Senders gripping the old URL start failing with the next request — by design.
 */
export async function rotateIngestToken(
  teamId: string,
  id: string
): Promise<PublicRoute> {
  const { count } = await prisma.route.updateMany({
    where: { id, teamId },
    data: { ingestToken: generateIngestToken() },
  });
  if (count === 0) throw new ApiError(404, 'Route not found.');

  const route = await fetchRoute(teamId, id);
  if (!route) throw new ApiError(404, 'Route not found.');
  return route;
}

export async function updateRoute(
  teamId: string,
  id: string,
  data: Prisma.RouteUpdateInput & { status?: RouteStatus }
): Promise<PublicRoute> {
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

/* ────────────────────────────────────────────────────────────────────────────────────
 * [RELAY-59] Destination auth headers
 * ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * What a route's destination-headers state looks like to a CLIENT. Values never leave
 * the server — this is deliberately just the names, sorted, plus a resolvable boolean.
 * The ciphertext itself is not a client value either: a dashboard that sent the
 * envelope down would be one XSS away from handing an attacker ciphertext, and it has
 * no need of it.
 */
export type DestinationHeadersClientView = {
  names: string[];
  hasAny: boolean;
};

/**
 * Given a route row from the ORM, derive the client-visible view of its destination
 * headers. PURE and name-only: never decrypts, never imports anything that could.
 * Exported so any handler that already has a route can expose the same view without
 * a dedicated query.
 */
export function destinationHeadersClientView(
  destinationHeadersEncrypted: Prisma.JsonValue | null
): DestinationHeadersClientView {
  const names = destinationHeaderNames(destinationHeadersEncrypted);
  return { names, hasAny: names.length > 0 };
}

/**
 * Set the destination auth headers for a route. Values are encrypted per name before
 * the row is touched; this function NEVER returns the ciphertext or any decrypted form,
 * only the masked view above.
 *
 * ALL-OR-NOTHING on validation thrown by `encryptDestinationHeaders`: a bad entry
 * rejects the whole set, never writes half a route's auth.
 */
export async function setRouteDestinationHeaders(
  teamId: string,
  id: string,
  headers: Record<string, string>
): Promise<DestinationHeadersClientView> {
  const encrypted =
    headers && Object.keys(headers).length > 0
      ? (encryptDestinationHeaders(headers) as Prisma.InputJsonValue)
      : Prisma.DbNull;

  const { count } = await prisma.route.updateMany({
    where: { id, teamId },
    data: { destinationHeadersEncrypted: encrypted },
  });
  if (count === 0) throw new ApiError(404, 'Route not found.');

  return destinationHeadersClientView(encrypted === Prisma.DbNull ? null : (encrypted as Prisma.JsonValue));
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
 *
 * [RELAY-57] The path carries the route's ingest token; the URL is the whole credential
 * a sender needs. Derived here, server-side, from the record — never reconstructed
 * client-side from parts, and never echoed in a log line.
 */
export function relayUrlFor(
  teamSlug: string,
  routeSlug: string,
  ingestToken: string
): string {
  const base = (process.env.RELAY_PROXY_URL || 'http://localhost:8787').replace(
    /\/+$/,
    ''
  );
  return `${base}/in/${teamSlug}/${routeSlug}/${ingestToken}`;
}
