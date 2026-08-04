import { Hono } from 'hono';
import { RelayEnvelopeSchema, RouteSlugSchema, type RelayEnvelope } from '@coreframe-relay/types';

import { relayKey } from '../middleware/relayKey.js';
import { lookupRoute } from '../services/routeLookup.js';
import { publishToQStash } from '../services/qstash.js';
import { validateDestination } from '../services/ssrf.js';
import type { AppEnv } from '../types/bindings.js';

/**
 * POST /in/:teamSlug/:routeSlug — webhook ingestion — [RELAY-4].
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

export const ingest = new Hono<AppEnv>()
  // Auth first: an unauthenticated caller must not be able to make us do a route lookup,
  // which is a subrequest to the dashboard and therefore free work at our expense.
  .use('*', relayKey)
  .post('/:teamSlug/:routeSlug', async (c) => {
    const started = Date.now();
    const requestId = c.get('requestId');
    const teamSlug = c.req.param('teamSlug');
    const routeSlug = c.req.param('routeSlug');

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
