/**
 * DNS-over-HTTPS resolution layer for the SSRF validator — [RELAY-33]'s remaining AC.
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────
 *
 * `./ssrf.ts`'s own header names the gap this file closes: `validateDestination` is a
 * *literal-address* check. A hostname that is clean at the moment it is checked can be
 * repointed — by the customer editing the route, or by an attacker who controls the DNS
 * record — at 169.254.169.254 or an internal address by the time we actually connect to
 * it. That is DNS rebinding, and no amount of tightening the literal-address regex closes
 * it, because the literal check never resolves anything.
 *
 * Cloudflare Workers have no `dns` module and no raw socket, so "resolve on our side"
 * means a DNS-over-HTTPS lookup over plain `fetch`. Cloudflare's own resolver answers both
 * the binary wire format and a JSON form at the SAME endpoint; the JSON form is used here
 * because it needs no wire-format encoder/decoder — RELAY-62 forbids installing a DNS
 * library, and the JSON form makes that unnecessary anyway. Verified directly against the
 * live resolver while building this file (`curl -H 'accept: application/dns-json'
 * 'https://cloudflare-dns.com/dns-query?name=example.com&type=A'`), not assumed from docs.
 *
 * ─── THE REBINDING WINDOW THIS DOES AND DOES NOT CLOSE ──────────────────────────────
 *
 * Resolving once, early — e.g. only at ingest time — and trusting that answer later would
 * just MOVE the TOCTOU gap, not close it: the record can still change between the ingest
 * resolution and the actual outbound request. So this module is deliberately NOT a cache
 * and exposes no TTL-aware memoisation: every call performs a fresh lookup, and the call
 * site that matters most — `forwardToDestination` in
 * `apps/dashboard/lib/relay/forward.ts` — calls this immediately before the outbound
 * `fetch`, which is the narrowest window achievable without controlling the TCP connect
 * ourselves.
 *
 * That narrowest window is still not zero, and this is stated rather than papered over:
 * neither the Workers `fetch` nor Node's `fetch` exposes a hook to pin the outbound
 * connection to the address we just validated — `fetch(url)` re-resolves `url`'s hostname
 * itself, through the runtime's own resolver, at connect time. So a gap remains between
 * "we resolved X via DoH and it was safe" and "the runtime resolves X again, independently,
 * a moment later, to make the TCP connection." Closing that last gap needs a
 * connection-level primitive (a custom `dns.lookup` pinned to the validated address, or
 * dialling the IP directly and setting `Host` by hand) that does not exist in a Workers
 * isolate, so it is out of reach for the ingest path regardless of what the Node-only
 * dashboard path could do — and the two paths share this module precisely so they do not
 * drift into different guarantees. Re-resolving at every use, instead of trusting a TTL
 * cache, is still the correct trade: a cached answer is exactly the stale-but-trusted
 * value rebinding exploits, and re-resolving immediately before use is what keeps the
 * window to "one extra DNS round trip," not "however long the record sat in a cache."
 *
 * ─── FAIL-CLOSED, BY CONSTRUCTION ────────────────────────────────────────────────────
 *
 * Every branch that cannot POSITIVELY confirm every resolved address is safe returns
 * `ok: false`: a DoH network error, a non-200 response, unparseable JSON, a request that
 * times out, and a hostname that resolves to zero addresses of either family all refuse
 * the destination. This matches `ssrf.ts`'s own stated philosophy — "every failure mode
 * denies rather than widens" (also RELAY-39's convention, established elsewhere in this
 * codebase) — and the alternative ("could not check, so allow") would make DoH failure the
 * attacker's easiest bypass: make our resolver time out and walk straight through.
 */

import {
  isBlockedIPv4,
  isBlockedIPv6,
  parseIPv4,
  validateDestination,
  type SsrfCheck,
} from './ssrf';

/** Cloudflare's DoH resolver, JSON form. Reachable via plain `fetch` — no dependency. */
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

/** How long we wait for EACH of the A and AAAA lookups before failing closed. */
const DEFAULT_DOH_TIMEOUT_MS = 3_000;

const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

type DohAnswer = { name: string; type: number; TTL: number; data: string };
/** Shape of Cloudflare's DoH JSON response. `Status` is the DNS RCODE — 0 is NOERROR. */
type DohResponse = { Status: number; Answer?: DohAnswer[] };

/**
 * One DoH lookup for one record type.
 *
 * Returns the resolved address strings, or `null` to mean the LOOKUP ITSELF failed —
 * timeout, network error, non-2xx, malformed JSON. That is deliberately distinct from an
 * empty array, which means the lookup succeeded and found no records of that type (the
 * ordinary case for an AAAA query against an IPv4-only host). Callers fail closed on
 * `null` immediately; an empty array is only a problem if BOTH record types come back
 * empty, which the caller checks after combining them.
 */
async function dohLookup(
  hostname: string,
  type: 'A' | 'AAAA',
  timeoutMs: number
): Promise<string[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
    const res = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const body = (await res.json()) as DohResponse;
    // Status 0 = NOERROR. Anything else (NXDOMAIN=3, SERVFAIL=2, …) is a real DNS
    // outcome rather than a transport failure, but it still leaves us with nothing to
    // vouch for — folded into "no records" below alongside a clean empty Answer array,
    // and the caller fails closed if NEITHER record type produced anything at all.
    if (body.Status !== 0) return [];

    const wantType = type === 'A' ? DNS_TYPE_A : DNS_TYPE_AAAA;
    return (body.Answer ?? [])
      .filter((a) => a.type === wantType)
      .map((a) => a.data);
  } catch {
    // AbortError (our own timeout), TypeError (network failure), or a JSON parse
    // failure all land here. Treated identically: we could not confirm safety.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is this URL hostname ALREADY a literal IP address?
 *
 * If so, `validateDestination` has already range-checked it directly — DNS resolution of
 * an IP literal is not meaningful (there is nothing to resolve) and would just spend a
 * network round trip re-discovering the address we already have.
 */
function isLiteralAddress(hostname: string): boolean {
  // `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`), and a colon can never
  // appear in a real DNS hostname, so this alone distinguishes the two.
  if (hostname.includes(':')) return true;
  return parseIPv4(hostname) !== null;
}

export type ResolveOptions = {
  /** Per-lookup timeout override, for tests. Production default is 3000ms. */
  timeoutMs?: number;
};

/**
 * The full destination check: literal-address validation (`validateDestination`), THEN —
 * for a hostname, never for an IP literal — DNS-over-HTTPS resolution of both A and AAAA
 * records, with every resolved address re-checked against the EXACT SAME range logic
 * `validateDestination` already applies (`isBlockedIPv4`/`isBlockedIPv6`, imported and
 * reused here rather than copied).
 *
 * This is the function that closes RELAY-33's remaining AC. Call it as close to the
 * actual outbound request as the runtime allows — see the file header on why "resolve
 * once, early" does not close the rebinding window the way "resolve immediately before
 * use" does, and on the residual gap that remains even then.
 */
export async function resolveAndValidateDestination(
  raw: string,
  opts: ResolveOptions = {}
): Promise<SsrfCheck> {
  const literal = validateDestination(raw);
  if (!literal.ok) return literal;

  const host = literal.url.hostname.toLowerCase();
  if (isLiteralAddress(host)) {
    // Already an IP literal, already range-checked. Nothing to resolve.
    return literal;
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_DOH_TIMEOUT_MS;
  // Strip IPv6 brackets defensively; `isLiteralAddress` already routed real IPv6
  // literals out above, so this only ever fires for a genuine hostname, but a hostname
  // can never legally contain brackets either way, so this is a no-op in that case.
  const bareHost = host.replace(/^\[|\]$/g, '');

  const [aRecords, aaaaRecords] = await Promise.all([
    dohLookup(bareHost, 'A', timeoutMs),
    dohLookup(bareHost, 'AAAA', timeoutMs),
  ]);

  // `null` from EITHER lookup means that lookup itself failed — fail closed rather than
  // proceed on half an answer. A destination we could only partially verify is a
  // destination we have not verified.
  if (aRecords === null || aaaaRecords === null) {
    return {
      ok: false,
      code: 'dns_resolution_failed',
      reason: `Could not resolve "${host}" to verify its address is safe.`,
    };
  }

  const resolved = [...aRecords, ...aaaaRecords];
  if (resolved.length === 0) {
    // A hostname with no A or AAAA records cannot be vouched for. A genuinely
    // legitimate destination in this state would fail at the outbound fetch a moment
    // later anyway (nothing to connect to), so refusing here costs nothing real and
    // closes off "make the name unresolvable" as a way to skip validation.
    return {
      ok: false,
      code: 'dns_resolution_failed',
      reason: `"${host}" has no A or AAAA records — nothing to validate.`,
    };
  }

  for (const ip of resolved) {
    if (isBlockedIPv4(ip) || isBlockedIPv6(ip)) {
      return {
        ok: false,
        code: 'blocked_resolved_ip',
        reason: `"${host}" resolves to an address in a reserved or private range.`,
      };
    }
  }

  return literal;
}
