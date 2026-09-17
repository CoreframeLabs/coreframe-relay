import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import {
  DELIVERY_READ_SCOPE,
  READ_TOKEN_MIN_INTERVAL_MS,
  READ_TOKEN_TTL_MS,
  generateReadToken,
  readTokenDigestHex,
  readTokenDisplayParts,
} from '@/lib/relay/readToken';

/**
 * Persistence for [RELAY-119] delivery read tokens. Every function that takes a
 * `teamId` must be called inside `withTeamScope(teamId)` — `RelayReadToken` is in
 * `RLS_PROTECTED_MODELS`, so an unscoped call returns zero rows / refuses the write,
 * never the wrong team's rows. The ONE exception is `lookupReadTokenByHash`, documented
 * on itself.
 *
 * Same "scoped by teamId on purpose" rule `models/route.ts` states at its top: the
 * application filter and the RLS policy are two independent locks on the same door.
 */

/** What a list view or a mint response is allowed to see. The hash is NEVER here. */
export const PUBLIC_READ_TOKEN_SELECT = {
  id: true,
  teamId: true,
  routeId: true,
  name: true,
  prefix: true,
  lastFour: true,
  scopes: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdByUserId: true,
  createdAt: true,
} as const;

export type PublicReadToken = {
  id: string;
  teamId: string;
  routeId: string;
  name: string;
  prefix: string;
  lastFour: string;
  scopes: string[];
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
};

/** The row as `relay_read_token_lookup()` returns it — full columns, hash included. */
export type ReadTokenRow = PublicReadToken & { hashedToken: string };

/**
 * Mint. Returns the plain token alongside the public row; the caller shows the token
 * once and forgets it. `routeId` must already have been resolved via the team-scoped
 * `fetchRoute` (so a cross-team route id 404s before this is reached) — this function
 * trusts its arguments the way every sibling model does, and the FK + RLS `WITH CHECK`
 * are the backstop if it is ever called wrongly.
 */
export async function createReadToken(params: {
  teamId: string;
  routeId: string;
  name: string;
  createdByUserId: string;
}): Promise<{ token: string; row: PublicReadToken }> {
  const token = generateReadToken();
  const { prefix, lastFour } = readTokenDisplayParts(token);

  const row = await prisma.relayReadToken.create({
    data: {
      teamId: params.teamId,
      routeId: params.routeId,
      name: params.name,
      hashedToken: readTokenDigestHex(token),
      prefix,
      lastFour,
      scopes: [DELIVERY_READ_SCOPE],
      expiresAt: new Date(Date.now() + READ_TOKEN_TTL_MS),
      createdByUserId: params.createdByUserId,
    },
    select: PUBLIC_READ_TOKEN_SELECT,
  });

  return { token, row };
}

/** One route's tokens, newest first, revoked ones included (the list is the audit view). */
export async function fetchReadTokensForRoute(
  teamId: string,
  routeId: string
): Promise<PublicReadToken[]> {
  return prisma.relayReadToken.findMany({
    where: { teamId, routeId },
    orderBy: { createdAt: 'desc' },
    select: PUBLIC_READ_TOKEN_SELECT,
  });
}

/**
 * Soft revoke. `updateMany` with the team AND route in the `where` so a token id from
 * another team (or another route on the same team) matches zero rows and the caller
 * 404s — the RELAY-63 convention. Already-revoked tokens are left untouched so
 * `revokedAt` records the FIRST revocation, not the latest click.
 */
export async function revokeReadToken(
  teamId: string,
  routeId: string,
  tokenId: string
): Promise<PublicReadToken | null> {
  await prisma.relayReadToken.updateMany({
    where: { id: tokenId, teamId, routeId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return prisma.relayReadToken.findFirst({
    where: { id: tokenId, teamId, routeId },
    select: PUBLIC_READ_TOKEN_SELECT,
  });
}

/**
 * THE unscoped read. Called by `pages/api/relay/deliveries.ts` before any team is
 * known — the token is what identifies the team. Goes through the definer-rights SQL
 * function `relay_read_token_lookup(hash)` installed by
 * `supabase/migrations/20260917120000_relay_119_read_token_rls.sql`, whose only
 * predicate is an equality on the hash. A `$queryRaw` deliberately: it must NOT run
 * through the model extension (no scope to set), and the SQL is a parameterised
 * function call — the hash is bound, never concatenated.
 *
 * Returns the row whatever its liveness; the handler decides revoked/expired so all
 * dead states share one 401 body.
 */
export async function lookupReadTokenByHash(
  hashedToken: string
): Promise<ReadTokenRow | null> {
  const rows = await prisma.$queryRaw<ReadTokenRow[]>(
    Prisma.sql`SELECT * FROM relay_read_token_lookup(${hashedToken})`
  );
  return rows[0] ?? null;
}

/**
 * The per-token rate floor, as one atomic statement — [decision §1 "Rate limiting"].
 *
 * Writes `lastUsedAt = now` ONLY IF the previous accepted request was at least
 * `READ_TOKEN_MIN_INTERVAL_MS` ago (or there was none). The conditional UPDATE is the
 * lock: two concurrent requests on the same token race for the same row, Postgres
 * serialises them, and exactly one sees `count === 1`. A read-then-write in two
 * statements would let both through. Returns true when the request is admitted.
 *
 * Must run inside `withTeamScope(token.teamId)` — the token is verified by this point,
 * so the team is known and the ordinary policy applies.
 */
export async function admitReadTokenUse(
  teamId: string,
  tokenId: string,
  now: Date = new Date()
): Promise<boolean> {
  const threshold = new Date(now.getTime() - READ_TOKEN_MIN_INTERVAL_MS);
  const { count } = await prisma.relayReadToken.updateMany({
    where: {
      id: tokenId,
      teamId,
      revokedAt: null,
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lte: threshold } }],
    },
    data: { lastUsedAt: now },
  });
  return count === 1;
}
