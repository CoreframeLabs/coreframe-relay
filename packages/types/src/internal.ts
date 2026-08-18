import { z } from 'zod';

import { RouteStatusSchema } from './route';

/**
 * The proxy ↔ dashboard internal contract.
 *
 * The proxy runs on Cloudflare Workers and has no database connection: it cannot read
 * Prisma, and giving a public, internet-facing edge Worker a Postgres credential would
 * hand every ingestion request the ability to read the whole tenant table. So the proxy
 * asks the dashboard, over a shared-secret-authenticated internal endpoint, for the one
 * route it needs.
 *
 * This file is written BEFORE either side is implemented, deliberately. [RELAY-4] (proxy)
 * and [RELAY-5] (dashboard) are built in parallel by different agents; without a pinned
 * contract each one invents its own and they meet in the middle at a 500.
 *
 * ─── The contract ────────────────────────────────────────────────────────────────────
 *
 *   GET  {RELAY_DASHBOARD_URL}/api/relay/internal/route-lookup?teamSlug=…&routeSlug=…
 *   Authorization: Bearer {RELAY_API_SECRET}
 *
 *   200 → RouteLookupResponse
 *   404 → { error: 'not_found' }        — no such team/route, or route is ARCHIVED
 *   401 → { error: 'unauthorized' }     — bad or missing bearer secret
 *
 * [RELAY-71] note: the 200 body carries `ingestTokenSha256`, NOT the token. This endpoint
 * is authenticated by one global secret and accepts arbitrary slugs, so any credential in
 * its response is a credential that one leaked secret reads for every tenant. It answers
 * BEFORE the proxy has validated the path credential, which is precisely why nothing in
 * the response may be usable as one. The failure bodies stay fixed strings for the same
 * reason they were at RELAY-5.

 * The 401 and 404 bodies are fixed strings on purpose. An internal endpoint that says
 * "team exists but route does not" is a tenant-enumeration oracle for anyone who gets
 * hold of the secret, and this endpoint answers before any customer auth has happened.
 */

/**
 * What the proxy needs to accept and queue a webhook, and nothing else.
 *
 * Note what is ABSENT: team name, member list, plan, every other route. The proxy is the
 * least-trusted component in the system — it is the only one exposed to the raw internet —
 * so the response is scoped to exactly the fields ingestion uses.
 */
export const RouteLookupResponseSchema = z.object({
  routeId: z.string().uuid(),
  teamId: z.string().uuid(),
  /** Where the payload is ultimately forwarded. Re-validated against SSRF at forward time. */
  destination: z.string().url(),
  maxRetries: z.number().int().min(1).max(10),
  status: RouteStatusSchema,
  /**
   * [RELAY-71] SHA-256 of the per-route ingest token, lower-case hex. NOT the token.
   *
   * This field used to be the raw `ingestToken`, defended as "the one place the token
   * legitimately crosses a process boundary — secret-to-secret, TLS-only,
   * Bearer-authenticated, scope-of-the-route". Three of those four are true. The fourth
   * is not: the lookup endpoint is authenticated by ONE GLOBAL `RELAY_API_SECRET` and
   * accepts ARBITRARY `teamSlug`/`routeSlug`, so a single leaked secret read every
   * tenant's live ingest credential — the exact shared-secret failure `Route.ingestToken`
   * was introduced to remove, reappearing one layer down.
   *
   * Sending the digest instead removes the credential from the response entirely while
   * keeping every property the proxy needs:
   *
   *  - The proxy still compares LOCALLY, so the raw token is never forwarded to an
   *    internal endpoint and never appears in a dashboard log line. The alternative —
   *    dashboard-side comparison — was rejected at RELAY-57 for exactly that reason, and
   *    it stays rejected.
   *  - The comparison is unchanged in strength: `timingSafeEqualStrings` already hashed
   *    both sides to SHA-256 before comparing, so the proxy now hashes the PRESENTED
   *    token and compares digests. Same operation, one less secret on the wire.
   *  - The KV route cache keeps working. A per-request verification call to the dashboard
   *    would have removed the cache and put a synchronous cross-cloud hop on the hot
   *    ingest path.
   *
   * Tokens are 24 random bytes (192-bit) per `generateIngestToken()`, so the digest is not
   * a meaningful attack surface: there is nothing to brute-force back. What a leaked
   * `RELAY_API_SECRET` still exposes is tenant METADATA (destination, status, ids) for any
   * slug pair — real, and tracked, but no longer a credential handout.
   */
  ingestTokenSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'lower-case hex SHA-256 digest'),
});
export type RouteLookupResponse = z.infer<typeof RouteLookupResponseSchema>;

/** Fixed error bodies. Deliberately indistinguishable beyond the status code. */
export const InternalErrorSchema = z.object({
  error: z.enum(['unauthorized', 'not_found', 'bad_request', 'internal_error']),
});
export type InternalError = z.infer<typeof InternalErrorSchema>;

/**
 * Header the proxy sets and the dashboard consumer reads to correlate one webhook across
 * both apps and QStash. Lower-case: Workers normalises header names, Node does not, and a
 * mismatched case is a header that silently reads as absent.
 */
export const RELAY_REQUEST_ID_HEADER = 'relay-request-id' as const;

/**
 * How long the proxy may cache a successful lookup.
 *
 * Short on purpose. This is the window in which a route paused or re-pointed in the
 * dashboard keeps receiving traffic at its old destination — the failure mode is
 * "customer disabled a route and it kept delivering", which is worse than an extra
 * subrequest per 30 seconds.
 */
export const ROUTE_LOOKUP_CACHE_TTL_SECONDS = 30;
