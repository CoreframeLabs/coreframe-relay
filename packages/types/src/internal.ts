import { z } from 'zod';

import { IngestTokenSchema, RouteStatusSchema } from './route';

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
 * [RELAY-57] note: the 200 body now carries `ingestToken`. This endpoint answers BEFORE
 * the proxy has validated the path credential, so the response must never write the
 * token to a log line, and the dashboard's own logger must redact it. The failure
 * bodies stay fixed strings for the same reason they were at RELAY-5.

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
   * [RELAY-57] The per-route ingest token. COMPARED PROXY-SIDE: this contract sends it
   * to the proxy and `routes/ingest.ts` runs RELAY-4's digest compare against the path
   * credential. Dashboard-side comparison was the alternative and was rejected — it
   * would require the proxy to FORWARD the raw token to an internal endpoint, which is
   * exactly the "credential on the wire and in a log line" failure mode this field
   * exists to close.
   *
   * This is the one place the token legitimately crosses a process boundary, and it is
   * only ever secret-to-secret, TLS-only, Bearer-authenticated, scope-of-the-route.
   */
  ingestToken: IngestTokenSchema,
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
