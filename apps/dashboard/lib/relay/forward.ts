// ⚠ [RELAY-33]: `resolveAndValidateDestination` is the DNS-RESOLVING check — literal
// address validation plus DoH resolution of the hostname, with every resolved record
// re-checked. Read `lib/relay/ssrfGap.ts` before touching this import.
import { resolveAndValidateDestination } from '@/lib/relay/ssrfGap';
import { DESTINATION_HEADER_ALLOWED_NAMES } from '@/lib/relay/destinationAuth';

/**
 * Forwarding a buffered webhook to the customer's destination. [RELAY-5]
 *
 * This is the only place in the product that makes an outbound request to an address a
 * customer chose, which makes it the confused-deputy surface: the attacker supplies the
 * URL, we supply the network position. Three controls sit here.
 */

/**
 * Default forward timeout. Overridable per environment; see the note on the timeout below.
 *
 * [RELAY-111] Was 10_000. That number undercut the destination type this product is
 * actively sold against: `docs/integrations/n8n.md` tells buyers n8n Cloud enforces its
 * own hard 100-second Cloudflare timeout on webhook responses, meaning n8n workflows
 * legitimately run for tens of seconds. At 10s, Relay aborted and recorded FAILED/DLQ on
 * a workflow n8n itself would have let finish — the product's own core promise
 * (durable, retried delivery) actively working against the exact buyer it targets.
 *
 * 110_000 (110s) is chosen deliberately just past n8n's documented 100s ceiling, not
 * arbitrarily longer:
 *   - Long enough that a legitimate n8n workflow finishing anywhere up to 100s gets a
 *     real answer instead of an aborted one.
 *   - Short enough that if n8n's OWN Cloudflare timeout has already fired (its 524),
 *     Relay's fetch receives that 524 as an honest non-2xx response shortly after 100s,
 *     rather than raced by our own synthetic AbortError first — a real response beats a
 *     manufactured timeout for whoever reads `failReason` later.
 *   - Not "as long as possible": every second held open here is a held serverless
 *     invocation, and this value is a deliberate ceiling, not a default nobody chose.
 *
 * This is safe against BOTH platform ceilings that could otherwise kill the request out
 * from under this timeout:
 *   - Vercel: this project runs pages/api routes as Node.js Functions under Fluid
 *     compute (default since 2025-04-23, and this project postdates that). Fluid
 *     compute's Hobby-plan default AND max duration is 300s — see the explicit
 *     `maxDuration` set in `pages/api/relay/qstash.ts`, which pins this in code rather
 *     than trusting an account-level default that could change. 110s forward + DB
 *     writes fits comfortably inside 300s.
 *   - QStash: "Max HTTP Response Duration" is 15 minutes even on the free plan — the
 *     consumer invocation is never killed by QStash before Vercel's own ceiling would
 *     apply first.
 *
 * `RELAY_FORWARD_TIMEOUT_MS` can still override this per environment; keep any override
 * under `maxDuration` in `pages/api/relay/qstash.ts` (see the note there) or the
 * invocation is killed before the failure can be written to `DeliveryLog`.
 */
const DEFAULT_TIMEOUT_MS = 110_000;

/**
 * Headers that must never reach a customer destination.
 *
 * A DENY-list, not an allow-list, and that is a deliberate trade. Webhook receivers verify
 * signatures from headers whose names we cannot enumerate in advance — `stripe-signature`,
 * `x-hub-signature-256`, `x-shopify-hmac-sha256`, and one per vendor after that. An
 * allow-list would silently break signature verification at the destination, which is the
 * one thing a relay must not do. So: everything passes except what is listed here, and
 * `RelayEnvelopeSchema.headers` is treated as untrusted regardless of the proxy having
 * filtered it once already.
 *
 * Two groups:
 *  - hop-by-hop headers (RFC 9110 §7.6.1), which describe a single connection and are
 *    meaningless-to-harmful when replayed onto a new one;
 *  - anything carrying credentials or routing context of OUR infrastructure — forwarding
 *    an `authorization` header to a third party is a credential leak, and forwarding
 *    `cookie` is worse.
 */
const BLOCKED_HEADERS = new Set([
  // Hop-by-hop.
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
  // Recomputed by fetch for the request we actually make. Passing them through produces a
  // request whose framing headers describe a different body than the one being sent.
  'content-length',
  'host',
  // Credentials and inbound auth material.
  'authorization',
  'cookie',
  'set-cookie',
  'www-authenticate',
  'x-api-key',
  'x-relay-key',
  // Our own transport metadata. `upstash-*` in particular carries the QStash signature —
  // handing a customer destination our message signature is gratuitous.
  'expect',
]);

/**
 * Prefixes stripped wholesale. Vendor-prefixed families where enumerating members would
 * go stale — the point is that none of them describe the request we are about to make.
 */
const BLOCKED_HEADER_PREFIXES = [
  'upstash-',
  'x-forwarded-',
  'x-vercel-',
  'cf-', // Cloudflare's client-attribution headers, added by the proxy's own edge.
  'sec-',
  'proxy-',
];

/** Identifies Relay to the destination. A receiver should be able to tell who called it. */
const USER_AGENT = 'Coreframe-Relay/1.0 (+https://www.coreframe-labs.dev)';

/**
 * How much of `destinationHeaders` is allowed to land on the wire. RELAY-59's whole
 * point is EXPLICIT and narrow: these headers are customer-configured credentials,
 * they arrived encrypted, and by the time this function runs they have already been
 * decrypted and named.
 *
 * Two separable rule sets, in two directions:
 *
 *   - `DESTINATION_HEADER_ALLOWED_NAMES` is the WRITE-TIME allowlist: which header
 *     names a customer is permitted to set at all. An attempt to set anything else
 *      is rejected BEFORE the column is written.
 *
 *   - `BLOCKED_HEADERS` / `BLOCKED_HEADER_PREFIXES` are the FORWARD-TIME denylists:
 *     they are what stops an INBOUND `Authorization` (or `Cookie`, `X-Relay-Key`, …)
 *     from being replayed out the far side. They are not meant to answer "may a
 *     customer configure this one" — only "must we NOT replay what arrived".
 *
 * The two sets CAN overlap legitimately. `x-api-key`, `authorization` are names a
 * customer may SET, and names we must not REPLAY from a sender. The rule this
 * function encodes captures the ONLY interpretation that does not either
 * (a) quietly allow inbound auth headers through, or
 * (b) silently no-op the whole feature:
 *
 *   - Names on the WRITE ALLOWLIST pass through.
 *   - Names on the inbound DENY lists ALSO pass through here — because their reach
 *     is the inbound set, and this function only ever sees the decrypted customer-set
 *     set. `filterForwardHeaders(params.headers)` is what applies them.
 *
 * The result: a destination can be configured with `Authorization: Bearer x` and
 * that SINGLE controlled value crosses; an inbound `Authorization: Bearer evil` from
 * a sender cannot arrive here, because that header is dropped from `params.headers`
 * before this function is called.
 */
export function destinationHeadersToSend(
  configured: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(configured)) {
    const name = rawName.toLowerCase().trim();
    // Only allow-listed names reach the wire, no matter what was stored.
    if (!DESTINATION_HEADER_ALLOWED_NAMES.includes(name)) continue;
    // The values are customer-supplied — a CRLF inside one is an injection attempt
    // against the destination itself.
    if (/[\r\n]/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * [RELAY-111] Duck-typed on purpose, NOT `error instanceof Error` /
 * `error instanceof DOMException`.
 *
 * A `fetch` abort throws a `DOMException` named `AbortError`. `instanceof` checks that
 * value against the constructor visible in the CALLING module's realm, and a fetch
 * implementation is not guaranteed to construct its error in that same realm — this is
 * exactly the case observed writing RELAY-111's own test suite: Jest's per-test-file VM
 * sandboxing gives `forward.ts` its own `Error`, while Node's global `fetch` throws a
 * `DOMException` constructed in the outer realm. The two are the same kind of object by
 * every property that matters and fail `instanceof` anyway, which silently turned every
 * timeout's `failReason` into `request failed (unknown)` instead of the honest
 * `destination timed out after Xms` — undermining the one signal an operator (or a
 * future alert) would use to tell "destination genuinely slow" from "connection
 * refused". Checking `.name` is realm-agnostic and is what fetch/abort consumers rely on
 * in practice.
 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** Same realm-agnostic reasoning as `isAbortError` above, for the generic fallback case. */
function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name) return name;
  }
  return 'unknown';
}

export type ForwardOutcome = {
  /** True only for a 2xx. A 3xx is NOT success: nothing followed the redirect. */
  ok: boolean;
  /** Null when no HTTP response was received at all (timeout, DNS failure, refused). */
  responseCode: number | null;
  /** Always real and always measured, including on the timeout path. */
  latencyMs: number;
  /** Short, safe-to-store reason. Never contains response bodies. */
  failReason: string | null;
};

/**
 * Filter inbound headers down to what may safely cross to a customer destination.
 * Exported for [RELAY-9]'s security suite — this is a rule worth asserting directly.
 */
export function filterForwardHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase().trim();

    if (!name || BLOCKED_HEADERS.has(name)) continue;
    if (BLOCKED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix)))
      continue;
    // Header injection guard: a newline in a value can split the request. Node would
    // throw on this, but dropping it here means one malformed header cannot fail a whole
    // delivery.
    if (/[\r\n]/.test(value)) continue;

    out[name] = value;
  }

  return out;
}

/**
 * Deliver one payload to its destination.
 *
 * Never throws: every failure mode — bad URL, timeout, DNS failure, connection refused,
 * non-2xx — comes back as a `ForwardOutcome` with a measured `latencyMs`. A throw here
 * would surface as a 500 from the consumer, and QStash treats a 500 as "retry", so an
 * unhandled exception is indistinguishable from a genuine transient failure.
 */
export async function forwardToDestination(params: {
  destination: string;
  headers: Record<string, string>;
  body: string;
  requestId: string;
  timeoutMs?: number;
  /**
   * [RELAY-59] Decrypted customer-configured destination auth headers. These are NOT
   * passed through `filterForwardHeaders`' wide-open path — they go through
   * `destinationHeadersToSend`, the explicit narrow filter. An inbound `Authorization`
   * the sender set CANNOT arrive here; what can is a value the customer stored against
   * their route.
   */
  destinationHeaders?: Record<string, string>;
  /**
   * [RELAY-66] True only when the envelope was test-marked (`x-relay-event: test` at
   * ingest, or RELAY-50's test-send). Enables the narrow loopback waiver documented
   * below; a forged marker cannot reach here as true because consumeEnvelope defaults
   * an unparsed envelope's `isTest` to false — REAL, never TEST.
   */
  isTest?: boolean;
}): Promise<ForwardOutcome> {
  const startedAt = Date.now();

  /**
   * Forward-time SSRF re-check — the destination is editable between ingest and send.
   *
   * [RELAY-33] This calls `resolveAndValidateDestination`, not the literal-only
   * `validateDestination` — DNS resolved on OUR side, right here, and the RESOLVED
   * A/AAAA addresses re-checked, closing the rebinding gap `ssrf.ts`'s own header names.
   * Position matters: this call sits IMMEDIATELY before the `fetch` below, deliberately
   * not earlier (not at ingest, not cached from a prior check) — a hostname's record can
   * change between any earlier check and this moment, and re-resolving here, right before
   * the connect, is what actually closes that window rather than just moving it. See
   * `ssrf-dns.ts` for the residual gap that remains even so (the runtime's own `fetch`
   * re-resolves the hostname again at connect time, and nothing in a fetch-only runtime
   * lets us pin that second resolution to the address we just validated).
   *
   * ONE waiver, mirroring the one in apps/proxy/src/routes/ingest.ts and narrower here:
   * [RELAY-66]'s smoke test delivers into /api/relay/smoke-destination on the local
   * dashboard, which the literal-address validator correctly rejects as loopback. The
   * waiver fires only when (a) the envelope is test-marked (a real webhook can never
   * take this path — `isTest` defaults to REAL on an unparsed envelope) and (b) the
   * destination's host is loopback with port exactly equal to the default Next.js dev
   * port (4002) — i.e. the smoke destination, not arbitrary loopback. Everything else
   * stays rejected, now and in production. The waiver constructs the URL directly and
   * never goes through DNS resolution — loopback by name is a literal-check rejection,
   * not a hostname that needs resolving.
   */
  let check = await resolveAndValidateDestination(params.destination);
  if (!check.ok && params.isTest) {
    try {
      const destUrl = new URL(params.destination);
      const loopback =
        destUrl.hostname === 'localhost' ||
        destUrl.hostname === '127.0.0.1' ||
        destUrl.hostname === '::1' ||
        destUrl.hostname === '[::1]';
      if (loopback && (destUrl.port || '80') === '4002') {
        check = { ok: true, url: destUrl };
      }
    } catch {
      // Fall through with the original rejection — the waiver never widens a failure.
    }
  }
  if (!check.ok) {
    return {
      ok: false,
      responseCode: null,
      latencyMs: Date.now() - startedAt,
      failReason: `destination rejected: ${check.code}`,
    };
  }

  // Parenthesised deliberately: an unset or non-numeric env var yields NaN, and NaN must
  // fall through to the default rather than becoming a timeout that fires immediately.
  const timeoutMs =
    params.timeoutMs ??
    (Number(process.env.RELAY_FORWARD_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

  // A destination that accepts the connection and then never responds must not hold this
  // function open — on a serverless platform that burns the whole invocation budget and
  // the delivery is recorded as nothing at all. The abort makes a hang a measured failure.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(check.url.toString(), {
      method: 'POST',
      headers: {
        ...filterForwardHeaders(params.headers),
        // RELAY-59: customer-auth headers go on AFTER the inbound set, and after a
        // narrow allowlist — a value the customer stored can therefore SET
        // `authorization` on the outbound request, and an inbound `authorization`
        // header cannot survive into this point because `filterForwardHeaders` dropped
        // it and nothing re-adds it from `params.headers`.
        ...destinationHeadersToSend(params.destinationHeaders ?? {}),
        'user-agent': USER_AGENT,
        // Lower-case on purpose — see RELAY_REQUEST_ID_HEADER's note in the contract.
        'relay-request-id': params.requestId,
      },
      body: params.body,
      signal: controller.signal,
      // Do NOT follow redirects. A 302 to an internal address is SSRF that walks straight
      // past a destination check performed on the original URL, and this is precisely the
      // path where the real validator is not running yet (see ssrfGap.ts).
      redirect: 'manual',
    });

    const latencyMs = Date.now() - startedAt;
    const ok = response.status >= 200 && response.status < 300;

    return {
      ok,
      responseCode: response.status,
      latencyMs,
      // Status code only. Response bodies from a customer's destination can contain their
      // own secrets, and this string is stored in our database and shown in our UI.
      failReason: ok ? null : `destination responded ${response.status}`,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const aborted = isAbortError(error);

    return {
      ok: false,
      responseCode: null,
      latencyMs,
      failReason: aborted
        ? `destination timed out after ${timeoutMs}ms`
        : // Error *name* only, never the message: a fetch error message can carry the
          // full destination URL, which may itself embed a token in a query string.
          `request failed (${errorName(error)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}
