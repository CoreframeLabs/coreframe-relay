/**
 * Route lookup client — [RELAY-4].
 *
 * The Worker has no database. Giving a public, internet-facing edge Worker a Postgres
 * credential would hand every ingestion request the ability to read the whole tenant
 * table, so instead it asks the dashboard for the single route it needs, over the
 * shared-secret contract pinned in `packages/types/src/internal.ts`.
 *
 * ⚠ IMPORT PATH. `internal.ts` is not re-exported from `@coreframe-relay/types`'s
 * `index.ts`, and the package's `exports` map exposes only `"."`, so a subpath import of
 * it does not resolve. It is imported by relative path here. The one-line fix is
 * `export * from './internal';` in `packages/types/src/index.ts` — that file is outside
 * this ticket's boundary and is owned by another agent, so it is reported, not edited.
 */
import {
  ROUTE_LOOKUP_CACHE_TTL_SECONDS,
  RouteLookupResponseSchema,
  type RouteLookupResponse,
} from '../../../../packages/types/src/internal';
import type { Bindings } from '../types/bindings.js';

export type RouteLookupResult =
  | { ok: true; route: RouteLookupResponse; source: 'cache' | 'origin' }
  | { ok: false; code: RouteLookupFailure };

export type RouteLookupFailure =
  /** No such team/route, or the dashboard considers it archived. Caller must render 404. */
  | 'not_found'
  /** Our own bearer secret was rejected. A configuration fault, never the caller's. */
  | 'unauthorized'
  /** Dashboard unreachable, timed out, or answered 5xx. */
  | 'unavailable'
  /** Dashboard answered 200 with a body that does not match the contract. */
  | 'bad_response'
  /** `RELAY_DASHBOARD_URL` is not set on this Worker. */
  | 'not_configured';

/**
 * How long to wait on the dashboard before giving up.
 *
 * The product promise is a sub-10ms acknowledgement, and this subrequest is the one thing
 * standing between a webhook and that promise. This ceiling was originally 2000ms on the
 * assumption a warm cached lookup would make this call rare — but `RELAY_KV` has never
 * been bound (see the block below), so today EVERY request pays this cost uncached. Found
 * 2026-08-25 via live production testing: warm round trips already ran 2000-2500ms end to
 * end, and a cold Vercel function (cross-region: Vercel defaults to `iad1`/US-East, Supabase
 * is `eu-west-2`/London) blew straight through 2000ms, producing a real, reproducible
 * `503 service unavailable` on the first request after any idle period — confirmed live,
 * 1 of 5 rapid requests failed this way, the rest succeeded around 2-2.5s each. Raised to a
 * ceiling that actually absorbs cold-start + cross-region latency rather than one tuned for
 * a caching layer that does not exist yet. Revisit downward once RELAY_KV is bound.
 */
const LOOKUP_TIMEOUT_MS = 6_000;

/**
 * Cloudflare KV refuses an `expirationTtl` below 60 seconds — the write throws, it does
 * not round up. The contract's TTL is 30, so the KV entry is written with the 60-second
 * floor and the 30-second freshness window is enforced on READ against a stored timestamp.
 * Doing it the other way round would either throw on every write or silently double the
 * window in which a paused route keeps delivering.
 */
const KV_MIN_EXPIRATION_TTL_SECONDS = 60;

const cacheKey = (teamSlug: string, routeSlug: string) =>
  `route-lookup:v1:${teamSlug}:${routeSlug}`;

type CacheEntry = { cachedAt: number; route: RouteLookupResponse };

/**
 * Read a cached lookup.
 *
 * Every failure here — unbound namespace, malformed JSON, a shape that no longer matches
 * the contract after a deploy — falls through to `null` and costs one origin call. A cache
 * is never allowed to be the reason a webhook is dropped.
 */
async function readCache(
  kv: KVNamespace | undefined,
  teamSlug: string,
  routeSlug: string
): Promise<RouteLookupResponse | null> {
  if (!kv) return null;

  try {
    const raw = await kv.get(cacheKey(teamSlug, routeSlug), 'json');
    if (!raw) return null;

    const entry = raw as CacheEntry;
    const ageSeconds = (Date.now() - entry.cachedAt) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds > ROUTE_LOOKUP_CACHE_TTL_SECONDS) return null;

    const parsed = RouteLookupResponseSchema.safeParse(entry.route);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeCache(
  kv: KVNamespace | undefined,
  teamSlug: string,
  routeSlug: string,
  route: RouteLookupResponse
): Promise<void> {
  if (!kv) return;
  try {
    const entry: CacheEntry = { cachedAt: Date.now(), route };
    await kv.put(cacheKey(teamSlug, routeSlug), JSON.stringify(entry), {
      expirationTtl: Math.max(ROUTE_LOOKUP_CACHE_TTL_SECONDS, KV_MIN_EXPIRATION_TTL_SECONDS),
    });
  } catch {
    // Deliberately swallowed. A failed cache write is a performance event, not an error.
  }
}

/**
 * Look up one route.
 *
 * Only 200s are cached. A 404 is never negatively cached: the failure mode would be
 * "customer creates a route and it 404s for the next 30 seconds", which reads as the
 * product being broken at exactly the moment a new user first tries it.
 */
export async function lookupRoute(
  env: Bindings,
  teamSlug: string,
  routeSlug: string
): Promise<RouteLookupResult> {
  const cached = await readCache(env.RELAY_KV, teamSlug, routeSlug);
  if (cached) return { ok: true, route: cached, source: 'cache' };

  const base = env.RELAY_DASHBOARD_URL;
  if (!base) return { ok: false, code: 'not_configured' };
  if (!env.RELAY_API_SECRET) return { ok: false, code: 'not_configured' };

  const url = new URL('/api/relay/internal/route-lookup', base);
  url.searchParams.set('teamSlug', teamSlug);
  url.searchParams.set('routeSlug', routeSlug);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${env.RELAY_API_SECRET}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'unavailable' };
  }

  if (res.status === 404) return { ok: false, code: 'not_found' };
  if (res.status === 401 || res.status === 403) return { ok: false, code: 'unauthorized' };
  if (!res.ok) return { ok: false, code: 'unavailable' };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, code: 'bad_response' };
  }

  const parsed = RouteLookupResponseSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'bad_response' };

  await writeCache(env.RELAY_KV, teamSlug, routeSlug, parsed.data);
  return { ok: true, route: parsed.data, source: 'origin' };
}
