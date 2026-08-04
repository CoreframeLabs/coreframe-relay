// ⚠ The SSRF import below is the ONE line [RELAY-33] swaps for the shared package.
// Read `lib/relay/ssrfGap.ts` before assuming this path is SSRF-protected — it is not.
import { validateDestination } from '@/lib/relay/ssrfGap';

/**
 * Forwarding a buffered webhook to the customer's destination. [RELAY-5]
 *
 * This is the only place in the product that makes an outbound request to an address a
 * customer chose, which makes it the confused-deputy surface: the attacker supplies the
 * URL, we supply the network position. Three controls sit here.
 */

/** Default forward timeout. Overridable per environment; see the note on the timeout below. */
const DEFAULT_TIMEOUT_MS = 10_000;

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
}): Promise<ForwardOutcome> {
  const startedAt = Date.now();

  const check = validateDestination(params.destination);
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
    const aborted = error instanceof Error && error.name === 'AbortError';

    return {
      ok: false,
      responseCode: null,
      latencyMs,
      failReason: aborted
        ? `destination timed out after ${timeoutMs}ms`
        : // Error *name* only, never the message: a fetch error message can carry the
          // full destination URL, which may itself embed a token in a query string.
          `request failed (${error instanceof Error ? error.name : 'unknown'})`,
    };
  } finally {
    clearTimeout(timer);
  }
}
