import { Hono } from 'hono';
import {
  IngestTokenSchema,
  RelayEnvelopeSchema,
  RouteSlugSchema,
  type RelayEnvelope,
} from '@coreframe-relay/types';

import { timingSafeEqualStrings, verifyRelayKey } from '../middleware/relayKey.js';
import { lookupRoute } from '../services/routeLookup.js';
import { publishToQStash } from '../services/qstash.js';
import { validateDestination } from '../services/ssrf.js';
import type { AppEnv } from '../types/bindings.js';

/**
 * POST /in/:teamSlug/:routeSlug — legacy path, `X-Relay-Key` required — [RELAY-4].
 * POST /in/:teamSlug/:routeSlug/:ingestToken — path credential, no header — [RELAY-57].
 *
 * Both are the same handler; the `ingestToken` path segment is optional. Auth is decided
 * per-request: a valid path token OR a valid `X-Relay-Key` satisfies it, which is what
 * "keep `X-Relay-Key` during the migration" means. Rotation revokes the old token
 * without touching the shared header.
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
     * [RELAY-57] Authentication, per request, in the arms the decision specified.
     *
     * Order matters deliberately.
     *
     *  1. If a path token was presented and a header was presented too, the header is
     *     IGNORED: a request that can carry a URL credential carries no second one to
     *     audit. Two valid credentials on one request is a misconfigured sender, and
     *     answering based on whichever is checked first is a policy no one wrote down.
     *  2. A presented path token is constant-time compared (SHA-256 digests,
     *     `timingSafeEqualStrings`, RELAY-4). No early exit; the compare runs whether or
     *     not the header is also valid.
     *  3. Only when NO path token was presented does the legacy `X-Relay-Key` header run,
     *     and it runs unchanged: same shared secret, same 401 shape, same timing.
     *
     * Failure is 404, never 401. A 401 tells a brute-forcer "the route EXISTS, come back
     * with a better token"; a 404 tells them nothing. That asymmetry is the entire
     * reason ingest-token auth lives here instead of in the `relayKey` middleware, which
     * answers 401 and must not change during the migration.
     */
    if (presentedToken !== undefined) {
      // A path-credentialed request never consults the header. The shared secret is not
      // a fallback here — the token IS the credential.
      const presentedValid =
        IngestTokenSchema.safeParse(presentedToken).success &&
        (await timingSafeEqualStrings(presentedToken, route.ingestToken));

      if (!presentedValid) {
        // One log line, never the token, never the presented segment. The routeId is
        // present: the lookup already returned it and an internal log line is what an
        // operator reaches for when a customer says "I rotated the token and it broke".
        log('proxy.ingest.invalid_token', { requestId, routeId: route.routeId });
        return c.json({ error: 'not found', requestId }, 404);
      }
    } else {
      // ── Legacy path: X-Relay-Key, exactly as RELAY-4 specified it. ────────────
      // This is the same middleware logic, inline rather than mounted, because the
      // middleware cannot know which of the two arms the request arrived by. When the
      // migration window ends, delete this branch and the route `.post()` above keeps
      // working unchanged.
      const auth = await verifyRelayKey(c.env, c.req.raw);
      if (!auth.ok) {
        if (auth.code === 'misconfigured') {
          return c.json({ error: 'proxy not configured', requestId }, 503);
        }
        return c.json({ error: 'unauthorized', requestId }, 401);
      }
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
     * SSRF check on the stored destination, at ingestion time.
     *
     * The consumer re-checks before it actually sends ([RELAY-5]) — the destination is
     * editable between these two moments — but checking here means a route pointed at
     * 169.254.169.254 never gets a message queued against it in the first place.
     *
     * The reason string is logged, never returned: it names the host, and the host is the
     * customer's private infrastructure.
     */
    const destination = validateDestination(route.destination);
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
