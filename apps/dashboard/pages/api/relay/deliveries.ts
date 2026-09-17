import type { NextApiRequest, NextApiResponse } from 'next';
import type { DeliveryStatus } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { withTeamScope } from '@/lib/db/scope';
import { admitReadTokenUse, lookupReadTokenByHash } from 'models/readToken';
import {
  DELIVERY_READ_SCOPE,
  READ_TOKEN_MIN_INTERVAL_MS,
  bearerTokenFrom,
  isReadTokenLive,
  isWellFormedReadToken,
  readTokenDigestHex,
  readTokenDigestMatches,
} from '@/lib/relay/readToken';

/**
 * GET /api/relay/deliveries?requestId=<id> — [RELAY-119]
 *
 * The delivery-status read an n8n workflow polls after sending through a route, so
 * "did my webhook actually deliver" is answerable without leaving the canvas. The only
 * endpoint in the dashboard authenticated by a `RelayReadToken`.
 *
 * TRUST BOUNDARY — READ BEFORE EDITING
 *   This is NOT under `/api/teams/[slug]/`, on purpose. The `:slug` segment is how the
 *   SESSION flow selects a tenant; here the tenant comes from the token row and from
 *   nowhere else. `lib/db/scope.ts` states the rule ("the value must come from the
 *   session"); for a machine caller the verified token IS the session. No query
 *   parameter, header, or body field on this endpoint may ever name a team or route.
 *
 * ORDER OF CHECKS, AND WHY EACH IS WHERE IT IS
 *   1. Method — 405 for anything but GET.
 *   2. Bearer present, well-formed (`relay_rt_` + 32 base64url chars) — 401 with no
 *      database touched. Keeps a stray session cookie, ingest token or
 *      RELAY_API_SECRET from ever reaching the lookup.
 *   3. `lookupReadTokenByHash(sha256(token))` — the one unscoped read, through the
 *      definer-rights SQL function whose only predicate is that equality. Miss → 401.
 *   4. `readTokenDigestMatches` — constant-time re-compare against the row's hash.
 *      Redundant with the equality in (3) by construction; kept so a refactor of (3)
 *      into anything looser cannot silently authenticate the wrong token.
 *   5. Revoked / expired → 401. Same body as (2) and (3): a caller cannot tell
 *      "unknown" from "known but dead" (decision §1 "uniform response").
 *   6. Scope — 403 if `delivery:read` is absent. Distinct from 401 because by now the
 *      caller HAS proven possession of a real token; this is authorisation, not
 *      authentication.
 *   7. `withTeamScope(token.teamId)` — everything below runs under RLS for the token's
 *      team. `admitReadTokenUse` is the per-token 1 rps floor (atomic conditional
 *      UPDATE on `lastUsedAt`) → 429 + Retry-After.
 *   8. The delivery query filters `requestId = ? AND routeId = token.routeId`. Postgres
 *      RLS on `DeliveryLog` denies the row even if this filter were ever removed —
 *      two independent locks. A requestId from another team OR from another route on
 *      the same team is 404, identical to one that never existed (RELAY-63).
 *
 * WHAT IT RETURNS
 *   A hand-built subset of `models/delivery.ts`'s `feedSelect`, fields listed one at a
 *   time: `sourceIp` is deliberately NOT here (it is the one feed field a competitor
 *   doing volume reconnaissance would want and the n8n node has no use for). `terminal`
 *   is derived so a poller knows when to stop without hard-coding Relay's status
 *   vocabulary.
 *
 *   With NO `requestId`, a valid token gets a 200 introspection (`{ ok, scope, route }`)
 *   — this is what the n8n credential's connection test calls, so "Test credential"
 *   proves a live token against THIS endpoint rather than a bare 2xx from anything.
 *   It reveals the route id/slug the token is pinned to, which the holder already knows
 *   (they hold the route's ingest URL); nothing about any other route or team.
 *
 * `middleware.ts` carries the exact-path allowlist entry that lets this be reached
 * without a NextAuth session. Rollback of the whole feature is removing that entry.
 */

const UNAUTHORIZED = { error: { message: 'Unauthorized' } } as const;

const TERMINAL_STATUSES: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  'DELIVERED',
  'FAILED',
  'DLQ',
]);

/** `requestId` values are UUID-shaped in practice; this bounds the lookup key only. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res
      .status(405)
      .json({ error: { message: `Method ${req.method} Not Allowed` } });
  }

  try {
    const presented = bearerTokenFrom(req.headers.authorization);
    if (!presented || !isWellFormedReadToken(presented)) {
      return res.status(401).json(UNAUTHORIZED);
    }

    const token = await lookupReadTokenByHash(readTokenDigestHex(presented));
    if (!token) {
      return res.status(401).json(UNAUTHORIZED);
    }
    if (!readTokenDigestMatches(presented, token.hashedToken)) {
      return res.status(401).json(UNAUTHORIZED);
    }
    if (!isReadTokenLive(token)) {
      return res.status(401).json(UNAUTHORIZED);
    }

    if (!token.scopes.includes(DELIVERY_READ_SCOPE)) {
      return res.status(403).json({
        error: { message: `Token lacks the ${DELIVERY_READ_SCOPE} scope` },
      });
    }

    const { requestId } = req.query;
    if (requestId !== undefined) {
      if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
        return res
          .status(400)
          .json({ error: { message: 'requestId must be a single string' } });
      }
    }

    // From here on, the tenant is the token's. Never the request's.
    await withTeamScope(token.teamId, async () => {
      const admitted = await admitReadTokenUse(token.teamId, token.id);
      if (!admitted) {
        res.setHeader(
          'Retry-After',
          String(Math.ceil(READ_TOKEN_MIN_INTERVAL_MS / 1000))
        );
        res.status(429).json({
          error: {
            message: `Rate limited: one request per ${READ_TOKEN_MIN_INTERVAL_MS}ms per token`,
          },
        });
        return;
      }

      if (requestId === undefined) {
        const route = await prisma.route.findFirst({
          where: { id: token.routeId, teamId: token.teamId },
          select: { id: true, slug: true, name: true },
        });
        res.status(200).json({
          data: {
            ok: true,
            scope: DELIVERY_READ_SCOPE,
            tokenName: token.name,
            expiresAt: token.expiresAt,
            route,
          },
        });
        return;
      }

      const row = await prisma.deliveryLog.findFirst({
        where: { requestId, routeId: token.routeId },
        select: {
          requestId: true,
          status: true,
          attemptCount: true,
          responseCode: true,
          latencyMs: true,
          payloadSizeB: true,
          isTest: true,
          createdAt: true,
          deliveredAt: true,
          route: { select: { id: true, name: true, slug: true } },
        },
      });

      if (!row) {
        res.status(404).json({ error: { message: 'Delivery not found.' } });
        return;
      }

      res.status(200).json({
        data: {
          requestId: row.requestId,
          status: row.status,
          terminal: TERMINAL_STATUSES.has(row.status),
          attemptCount: row.attemptCount,
          responseCode: row.responseCode,
          latencyMs: row.latencyMs,
          payloadSizeB: row.payloadSizeB,
          isTest: row.isTest,
          createdAt: row.createdAt,
          deliveredAt: row.deliveredAt,
          route: row.route,
        },
      });
    });
    return;
  } catch (error: any) {
    // Never echo the error: this endpoint is reachable without a session, and a raw
    // Prisma message is exactly the kind of thing that leaks table or column names.
    console.error('[relay] deliveries read failed', {
      message: error?.message,
      code: error?.code,
    });
    return res.status(500).json({ error: { message: 'Something went wrong' } });
  }
}
