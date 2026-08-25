import { Hono } from 'hono';
import {
  IngestTokenSchema,
  RelayEnvelopeSchema,
  RouteSlugSchema,
  type RelayEnvelope,
} from '@coreframe-relay/types';

import { checkRateLimit } from '../middleware/rateLimit.js';
import { sha256Hex, timingSafeEqualStrings } from '../middleware/relayKey.js';
import { lookupRoute } from '../services/routeLookup.js';
import { publishToQStash } from '../services/qstash.js';
import { resolveAndValidateDestination } from '../services/ssrf.js';
import type { AppEnv } from '../types/bindings.js';

/**
 * POST /in/:teamSlug/:routeSlug/:ingestToken — path credential — [RELAY-57], [RELAY-71].
 *
 * The per-route ingest token is the ONLY credential this endpoint accepts. The legacy
 * two-segment `X-Relay-Key` form was retired by [RELAY-71]: it authenticated ingestion
 * against ANY tenant's route with one global shared secret. The route registration still
 * matches the two-segment form so that a sender using the old URL gets the same opaque
 * 404 as any other unauthenticated caller, rather than a 404-from-routing that behaves
 * differently under load or in logs.
 *
 * The product promise is a sub-10ms acknowledgement, and the shape of this handler is
 * that promise: authenticate, look the route up, validate its destination, queue the
 * payload durably, answer. It NEVER waits on the customer's destination — the moment
 * QStash returns 2xx the payload survives us crashing, which is the only thing a 200
 * here is actually claiming.
 */

/**
 * Body cap. [RELAY-12] owns the full ingestion guardrail (rate limiting, per-plan size
 * limits, the 413 body copy) — this is the floor that keeps an unbounded body out of a
 * 128MB isolate in the meantime. It is enforced by STREAMING and bailing out, not by
 * buffering and then measuring, because measuring after the fact means the memory has
 * already been spent.
 */
export const MAX_BODY_BYTES = 1_048_576; // 1 MiB

/**
 * Headers that must never be replayed to a customer destination.
 *
 * Denylist, not allowlist, and that direction is deliberate: webhook signatures live on
 * vendor-specific headers (`stripe-signature`, `x-hub-signature-256`, `x-shopify-hmac-sha256`
 * …) and an allowlist would silently strip the one header that makes the payload verifiable
 * at the far end. So everything is forwarded EXCEPT what is either hop-by-hop, ours, or
 * an inbound credential.
 */
const STRIPPED_HEADERS = new Set([
  // Our own auth — forwarding it would hand the shared secret to every destination.
  'x-relay-key',
  'authorization',
  'cookie',
  // [RELAY-50] The test-send marker is consumed by the pipeline itself; the
  // customer destination must never see Relay's internal instrumentation headers.
  'x-relay-event',
  // Hop-by-hop: meaningless or actively harmful on a different connection.
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'expect',
  // Recomputed by whoever actually sends the next request.
  'content-length',
]);

/** Prefixes stripped wholesale — edge metadata and client-network detail. */
const STRIPPED_PREFIXES = ['proxy-', 'cf-', 'x-forwarded-', 'x-real-ip', 'sec-fetch-'];

function forwardableHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of req.headers.entries()) {
    const name = rawName.toLowerCase();
    if (STRIPPED_HEADERS.has(name)) continue;
    if (STRIPPED_PREFIXES.some((p) => name.startsWith(p))) continue;
    out[name] = value;
  }
  return out;
}

type BodyRead = { ok: true; body: string } | { ok: false; reason: 'too_large' };

/**
 * Read the body, refusing to hold more than `limit` bytes.
 *
 * `content-length` is checked first as a cheap rejection, but it is a claim, not a fact —
 * a chunked request has none and a lying one is trivial — so the stream is also counted as
 * it arrives and cancelled the moment it exceeds the cap.
 */
async function readBodyWithLimit(req: Request, limit: number): Promise<BodyRead> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: 'too_large' };

  const stream = req.body;
  if (!stream) return { ok: true, body: '' };

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return { ok: false, reason: 'too_large' };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  return { ok: true, body: text };
}

/** One structured log line per ingestion outcome. Never a secret, never a destination. */
function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

/** Hosts a request can only arrive on when it never left the machine. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const isLoopbackHostname = (hostname: string): boolean =>
  LOOPBACK_HOSTNAMES.has(hostname.replace(/^\[|\]$/g, '').toLowerCase());

/**
 * [RELAY-73] Is the smoke-test SSRF waiver applicable to THIS request?
 *
 * ─── THE FINDING ─────────────────────────────────────────────────────────────────────
 *
 * The waiver used to turn on when `x-relay-event: test` was present and
 * `RELAY_LOCAL_QUEUE_URL` happened to be bound. That makes a REQUEST HEADER the switch on
 * the product's central security control, and it rests the whole guarantee on one
 * environment variable being *unset* in production. "Unset" is not a control — it is the
 * absence of one, and it fails open the first time someone copies a working dev
 * configuration into a deployed environment to debug something. The comment even asserted
 * "this branch cannot exist on a deployed Worker", which is a claim about how we intend to
 * configure things, not a property of the system.
 *
 * ─── THE CONTROL ─────────────────────────────────────────────────────────────────────
 *
 * Arm 1 is the structural one and it depends on no configuration at all: the request must
 * have ARRIVED on a loopback host. A deployed Worker is reached at a workers.dev subdomain
 * or a zone hostname; Cloudflare routes by Host, so a request bearing `Host: localhost`
 * never matches a route and never reaches us. There is no value of any environment
 * variable that makes arm 1 true in production.
 *
 * The remaining arms are defence in depth, each independently sufficient to refuse:
 *   2. `ENVIRONMENT` must be exactly `development` — set from wrangler.toml `[vars]`, and
 *      `production`/`staging` override it in their own env blocks.
 *   3. the local queue stand-in must be the publisher;
 *   4. the request must be test-marked;
 *   5. the destination must be loopback on the SAME protocol and port as the dashboard
 *      the proxy already trusts for route lookup — not arbitrary loopback.
 *
 * All five must hold. Arms 2-5 alone would still be caller-influenced; arm 1 is the one
 * that makes this impossible to reach in a deployed production environment rather than
 * merely improbable.
 */
function smokeWaiverApplies(
  requestUrl: string,
  env: AppEnv['Bindings'],
  isTestSend: boolean
): boolean {
  if (!isTestSend) return false;
  if (env.ENVIRONMENT !== 'development') return false;
  if (!env.RELAY_LOCAL_QUEUE_URL) return false;

  try {
    // Arm 1 — structural. Unreachable on any deployed Worker.
    return isLoopbackHostname(new URL(requestUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The two forms share one handler.
 *
 * `:ingestToken?` is Hono's optional-segment syntax: the same registration matches
 * `/in/:teamSlug/:routeSlug` (legacy, header-authenticated) and
 * `/in/:teamSlug/:routeSlug/:ingestToken` (path credential). Matching both here keeps
 * every later check — routed status, SSRF, queue — in one place, and the 404 body is
 * identical across all four failure modes, which is the property the response surface
 * is built around.
 */
export const ingest = new Hono<AppEnv>()
  .post('/:teamSlug/:routeSlug/:ingestToken?', async (c) => {
    const started = Date.now();
    const requestId = c.get('requestId');
    const teamSlug = c.req.param('teamSlug');
    const routeSlug = c.req.param('routeSlug');
    // Raw segment; validated only AFTER the route row is known, because a malformed one
    // answers 404 without a lookup and the string is never interpolated anywhere.
    const presentedToken = c.req.param('ingestToken');

    // Shape-check both segments before spending a subrequest on them. A malformed slug
    // cannot match a real route, and it answers 404 rather than 400 for the same reason a
    // paused route does: this endpoint tells the internet nothing about what exists.
    if (!RouteSlugSchema.safeParse(teamSlug).success || !RouteSlugSchema.safeParse(routeSlug).success) {
      return c.json({ error: 'not found', requestId }, 404);
    }

    const lookup = await lookupRoute(c.env, teamSlug, routeSlug);
    if (!lookup.ok) {
      if (lookup.code === 'not_found') {
        return c.json({ error: 'not found', requestId }, 404);
      }
      // Everything else is OUR fault — a missing binding, a rejected bearer token, a
      // dashboard that is down. The caller is told to retry and told nothing else.
      log('proxy.ingest.lookup_failed', { requestId, teamSlug, routeSlug, code: lookup.code });
      return c.json({ error: 'service unavailable', requestId }, 503);
    }

    const route = lookup.route;

    /**
     * [RELAY-57] Authentication. [RELAY-71] retired the second arm.
     *
     * THE PATH TOKEN IS NOW THE ONLY INGEST CREDENTIAL. The legacy `X-Relay-Key` branch
     * accepted the global `RELAY_API_SECRET` on this PUBLIC endpoint, which meant one
     * shared secret authorised ingestion into every tenant's route — precisely the
     * failure `Route.ingestToken` was introduced to remove, still live on a second arm.
     * It is deleted rather than deprecated: `relayUrlFor()` has been handing users the
     * token URL since RELAY-57, so there is nothing left to migrate, and a fallback
     * credential that nobody needs is a credential nobody rotates.
     *
     * `verifyRelayKey` itself is NOT deleted — it still authenticates non-ingest proxy
     * routes, where a single operator-held secret is the correct model. What changed is
     * that it no longer stands in front of tenant data.
     *
     * The compare: the lookup response now carries `ingestTokenSha256`, not the token
     * ([RELAY-71]), so the PRESENTED token is hashed and the digests are compared with
     * `timingSafeEqualStrings`. That function hashed both sides internally anyway, so the
     * strength is identical — there is simply one less live credential on the wire and in
     * the KV cache.
     *
     * Failure is 404, never 401. A 401 tells a brute-forcer "the route EXISTS, come back
     * with a better token"; a 404 tells them nothing. A request with no token at all gets
     * the same 404 as a wrong one, so the two arms are indistinguishable.
     */
    if (presentedToken === undefined) {
      log('proxy.ingest.no_token', { requestId, routeId: route.routeId });
      return c.json({ error: 'not found', requestId }, 404);
    }

    const presentedValid =
      IngestTokenSchema.safeParse(presentedToken).success &&
      (await timingSafeEqualStrings(
        await sha256Hex(presentedToken),
        route.ingestTokenSha256
      ));

    if (!presentedValid) {
      // One log line, never the token, never the presented segment. The routeId is
      // present: the lookup already returned it and an internal log line is what an
      // operator reaches for when a customer says "I rotated the token and it broke".
      log('proxy.ingest.invalid_token', { requestId, routeId: route.routeId });
      return c.json({ error: 'not found', requestId }, 404);
    }

    /**
     * A PAUSED route answers 404, not 403.
     *
     * 403 would confirm the route exists, which is exactly what pausing is supposed to
     * stop: a customer who pauses a route because it is being abused should not have the
     * endpoint keep announcing itself to whoever was abusing it. ARCHIVED never reaches
     * here — the dashboard already answers 404 for it per the internal contract — but the
     * check is written as an allow-list so a status added later fails closed.
     */
    if (route.status !== 'ACTIVE' && route.status !== 'FAILING') {
      log('proxy.ingest.route_not_accepting', { requestId, routeId: route.routeId, status: route.status });
      return c.json({ error: 'not found', requestId }, 404);
    }

    /**
     * [RELAY-13] Per-team rate limit.
     *
     * Position is the security property here, and it is bracketed on both sides:
     *
     *   - It runs AFTER the token check. A limiter in front of authentication lets anyone
     *     who guesses a `teamSlug`/`routeSlug` pair — both of which are semi-public, they
     *     are in the URL a customer pastes into Stripe — burn that team's whole budget
     *     with garbage tokens and take their webhooks offline. That turns the control
     *     into a DoS amplifier pointed at the customer it protects.
     *   - It runs BEFORE `readBodyWithLimit`. Throttling after a megabyte has been
     *     buffered has already spent the resource the limit exists to protect.
     *
     * Keyed on `route.teamId` — never an IP. Cloudflare rotates client addresses, so an
     * IP key throttles one legitimate sender's egress pool while an attacker on
     * residential proxies never lands in the same bucket twice.
     *
     * 429 carries `Retry-After`, which is the half of the answer that makes it actionable:
     * Stripe, GitHub and Shopify all honour it, so a throttled webhook becomes a delayed
     * delivery rather than a lost one.
     */
    const limit = await checkRateLimit(c.env, route.teamId);
    if (!limit.ok) {
      if (limit.code === 'not_configured') {
        // Deployed with no limiter bound. Refusing is the point: a control that quietly
        // does nothing when its binding is absent cannot be told from a working one.
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'proxy.misconfigured',
            requestId,
            reason: 'RELAY_RATE_LIMITER is not bound',
          })
        );
        return c.json({ error: 'proxy not configured', requestId }, 503);
      }

      log('proxy.ingest.rate_limited', {
        requestId,
        routeId: route.routeId,
        teamId: route.teamId,
      });
      return c.json(
        { error: 'too many requests', requestId },
        429,
        { 'retry-after': String(limit.retryAfterSeconds) }
      );
    }

    /**
     * SSRF check on the stored destination, at ingestion time — [RELAY-33] runs the
     * DNS-RESOLVING check here, not just the literal-address one.
     *
     * The consumer re-checks before it actually sends ([RELAY-5]) — the destination is
     * editable between these two moments — but checking here means a route pointed at
     * 169.254.169.254, OR at a hostname that resolves there, never gets a message queued
     * against it in the first place. `resolveAndValidateDestination` runs the literal
     * check first (unchanged) and then, for a hostname (never for an IP literal), a
     * DNS-over-HTTPS lookup with every resolved A/AAAA record re-checked against the same
     * range logic — see `ssrf-dns.ts` for why this alone is not the LAST line of defence:
     * the record can still change between this check and the actual send, which is why
     * `forward.ts` on the dashboard re-resolves again immediately before its own fetch.
     *
     * The reason string is logged, never returned: it names the host, and the host is the
     * customer's private infrastructure.
     *
     * ONE waiver exists — [RELAY-66]'s launch smoke test must deliver into
     * `/api/relay/smoke-destination` on the local dashboard, which the literal-address
     * validator correctly rejects as loopback. [RELAY-73] rebuilt the gate on it:
     * `smokeWaiverApplies` above requires the request to have ARRIVED on a loopback host,
     * which no deployed Worker can satisfy at any setting of any environment variable.
     * Read the comment on that function before touching this branch — the previous gate
     * was a request header plus one unset binding, which is a switch the caller holds.
     *
     * The envelope still records isTest=true, so the row the smoke asserts on is marked
     * as what it is rather than impersonating production truth.
     */
    const isTestSend = c.req.header('x-relay-event') === 'test';
    let destination = await resolveAndValidateDestination(route.destination);
    if (
      !destination.ok &&
      c.env.RELAY_DASHBOARD_URL &&
      smokeWaiverApplies(c.req.url, c.env, isTestSend)
    ) {
      try {
        const destUrl = new URL(route.destination);
        const dashUrl = new URL(c.env.RELAY_DASHBOARD_URL);
        const loopback =
          destUrl.hostname === 'localhost' ||
          destUrl.hostname === '127.0.0.1' ||
          destUrl.hostname === '::1' ||
          destUrl.hostname === '[::1]';
        const dashPort = dashUrl.port || (dashUrl.protocol === 'https:' ? '443' : '80');
        const destPort = destUrl.port || (destUrl.protocol === 'https:' ? '443' : '80');
        if (loopback && destUrl.protocol === dashUrl.protocol && destPort === dashPort) {
          destination = { ok: true, url: destUrl };
        }
      } catch {
        // Fall through with the original rejection — the waiver never widens a failure
        // into an acceptance by accident; a URL that cannot even parse stays rejected.
      }
    }
    if (!destination.ok) {
      log('proxy.ingest.destination_rejected', {
        requestId,
        routeId: route.routeId,
        teamId: route.teamId,
        code: destination.code,
      });
      return c.json({ error: 'route destination is not permitted', requestId }, 502);
    }

    /**
     * [RELAY-50] The "Send test webhook" button fires a structurally real webhook
     * through this same endpoint. What marks it is a single header —
     * `x-relay-event: test` — which is stripped from the forwardable headers (it is
     * our instrumentation, not the sender's) and re-emitted as an envelope field the
     * consumer persists onto the `DeliveryLog` row. The badge and the billing
     * exclusion both read that field; nothing here behaves differently for a test
     * webhook, because making the test path a shortcut is precisely what this ticket
     * exists to disprove.
     *
     * Security-relevant: the flag is SELF-ATTESTED. An external caller can set it to
     * dodge usage counters. The guard for that lives in RELAY-52's north-star filter,
     * and the send is server-side authenticated — this header never reaches the
     * browser in any form a user can smuggle a forged `isTest` through.
     */
    const relayEvent = c.req.header('x-relay-event')?.trim().toLowerCase();
    const isTest = relayEvent === 'test';

    const read = await readBodyWithLimit(c.req.raw, MAX_BODY_BYTES);
    if (!read.ok) {
      log('proxy.ingest.body_too_large', { requestId, routeId: route.routeId, limit: MAX_BODY_BYTES });
      return c.json({ error: 'payload too large', requestId, maxBytes: MAX_BODY_BYTES }, 413);
    }

    const candidate: RelayEnvelope = {
      requestId,
      routeId: route.routeId,
      teamId: route.teamId,
      destination: route.destination,
      maxRetries: route.maxRetries,
      receivedAt: new Date().toISOString(),
      headers: forwardableHeaders(c.req.raw),
      // Raw body exactly as received. Re-encoding it would invalidate every HMAC
      // signature the sender computed over these bytes.
      body: read.body,
      isTest,
    };

    // Validated against the shared schema before it leaves: the consumer parses with the
    // same schema, and a shape mismatch is far cheaper to find here than as a poison
    // message being retried seven times.
    const envelope = RelayEnvelopeSchema.safeParse(candidate);
    if (!envelope.success) {
      log('proxy.ingest.envelope_invalid', { requestId, routeId: route.routeId });
      return c.json({ error: 'internal error', requestId }, 500);
    }

    const published = await publishToQStash(c.env, envelope.data);
    if (!published.ok) {
      log('proxy.ingest.publish_failed', {
        requestId,
        routeId: route.routeId,
        code: published.code,
        status: published.status,
      });
      // 503, deliberately. Stripe, GitHub and Shopify all retry on 5xx, so a queue we
      // could not reach becomes their retry rather than a silently dropped webhook.
      return c.json({ error: 'service unavailable', requestId }, 503);
    }

    log('proxy.ingest.queued', {
      requestId,
      routeId: route.routeId,
      teamId: route.teamId,
      lookupSource: lookup.source,
      bytes: read.body.length,
      messageId: published.messageId,
      ms: Date.now() - started,
    });

    // 200, not 202. Semantically 202 is the better answer, but a meaningful number of
    // webhook senders in the wild test for exactly 200 and treat anything else as failed.
    return c.json({ status: 'queued', requestId }, 200);
  });
