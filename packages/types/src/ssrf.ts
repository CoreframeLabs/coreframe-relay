/**
 * SSRF destination validator — [RELAY-4], relocated to this package by [RELAY-33].
 *
 * ─── WHY IT LIVES HERE ───────────────────────────────────────────────────────────────
 *
 * It was written in `apps/proxy/src/services/ssrf.ts` and ran on the INGEST path only.
 * The forward path — `apps/dashboard/lib/relay/forward.ts` and the DLQ retry — could not
 * import across the app boundary, so it ran `lib/relay/ssrfGap.ts`, a Zod shape check that
 * accepts `http://169.254.169.254/latest/meta-data/` because it is a syntactically valid
 * absolute http URL. That left the window RELAY-33 names: a destination edited to an
 * internal address AFTER a payload is queued but BEFORE it is delivered, plus every DLQ
 * replay, which starts from a stored envelope.
 *
 * `@coreframe-relay/types` was already a dependency of BOTH apps, so relocating here
 * needed no new package and no `pnpm add` (RELAY-62 forbids installs). Both call sites
 * now re-export this module rather than wrapping it, so `validateDestination` is one
 * function object with one identity — asserted by reference equality in
 * `apps/proxy/test/ssrf.test.ts`, which is the AC's "a test proves both paths import the
 * SAME function — not two copies".
 *
 * This file has no runtime dependency beyond the global `URL`, which is why it is safe in
 * a Cloudflare Worker isolate as well as in Node.
 *
 * ─── WHAT IT DOES ────────────────────────────────────────────────────────────────────
 *
 * Blocks attack scenarios 1 and 2 from relay-security-testing-plan.md Part 6: SSRF to
 * cloud metadata (169.254.169.254) and SSRF to internal network (RFC-1918).
 *
 * THE THREAT: a customer configures a route whose destination points inward — at cloud
 * metadata, at a private range, at localhost. Relay then makes that request FROM OUR
 * INFRASTRUCTURE, with our network position. That turns Relay into a confused deputy: the
 * attacker supplies a URL, we supply the privileges.
 *
 * WHAT THIS FILE DOES NOT DO, AND WHY IT MATTERS:
 *
 * This is a *literal-address* validator. It rejects a destination whose host is already an
 * IP in a blocked range, and rejects obvious non-http schemes and credential-embedding.
 * It CANNOT stop DNS rebinding, because it does not resolve.
 *
 * The security plan's Part 8 checklist explicitly requires "DNS resolution performed on
 * our side (not just regex on input URL)". Cloudflare Workers cannot resolve DNS directly
 * — there is no `dns` module and no raw socket. Resolution has to happen through a DNS-
 * over-HTTPS lookup (Cloudflare's own resolver is reachable via fetch), and even then a
 * TOCTOU gap remains between our resolution and the runtime's own connect-time lookup —
 * see `ssrf-dns.ts` for exactly how narrow that residual gap is and why it cannot be
 * closed further from inside a fetch-only runtime.
 *
 * So this validator is layer one of two, and it is deliberately marked as such rather than
 * quietly presented as complete. **Layer two now exists: `./ssrf-dns.ts`'s
 * `resolveAndValidateDestination` — DoH resolution of every A/AAAA record plus
 * re-validation of each one through `isBlockedIPv4`/`isBlockedIPv6` below.** Redirect-chain
 * validation is handled separately, at each call site, via `redirect: 'manual'` on the
 * outbound fetch (see `apps/dashboard/lib/relay/forward.ts`). Treating THIS file alone as
 * sufficient would still mean shipping a control that reads as "SSRF protected" while a
 * DNS name resolving to 169.254.169.254 sails straight through — that is exactly why every
 * call site is required to call `resolveAndValidateDestination`, not this file's
 * `validateDestination` directly, wherever the result gates an actual outbound request.
 */

/** Result type per relay-engineering-standards.md §5.3 — errors are values, not throws. */
export type SsrfCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string; code: SsrfReason };

export type SsrfReason =
  | 'invalid_url'
  | 'bad_scheme'
  | 'embedded_credentials'
  | 'blocked_host'
  | 'blocked_ip'
  | 'bad_port'
  // ─── [RELAY-33] DNS-resolution layer, added by ./ssrf-dns.ts ──────────────────────
  // Never produced by `validateDestination` in this file — only by
  // `resolveAndValidateDestination`, which calls this file's checks first and only adds
  // these two outcomes for what DNS resolution itself discovers.
  /** DoH lookup failed, timed out, or returned zero A/AAAA records. Fails closed. */
  | 'dns_resolution_failed'
  /** The literal address passed, but a RESOLVED A/AAAA record is in a blocked range. */
  | 'blocked_resolved_ip';

/** Hostnames that resolve inward regardless of the network we run on. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  // AWS/GCP/Azure/DO metadata aliases. The bare IP is caught by the range check below,
  // but these names are what actually appears in payloads.
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** Suffixes that are internal by definition. */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa'];

/**
 * Ports that are never a legitimate webhook destination but are attractive pivot targets.
 * This is a deny-list on purpose: an allow-list of {80, 443} would break the many
 * customers running webhook receivers on 8080/3000, and pushing them to disable the check
 * is worse than a narrow deny-list.
 */
const BLOCKED_PORTS = new Set([
  22,    // ssh
  23,    // telnet
  25,    // smtp — open relay pivot
  445,   // smb
  3306,  // mysql
  5432,  // postgres
  6379,  // redis
  9200,  // elasticsearch
  11211, // memcached
  27017, // mongodb
]);

const isDigits = (s: string) => s.length > 0 && /^[0-9]+$/.test(s);

/**
 * Parse a dotted-quad into four octets, or null if it is not one.
 *
 * Exported for `./ssrf-dns.ts`, which needs to tell "this hostname is already a literal
 * IPv4 address, and `validateDestination` already range-checked it" apart from "this is a
 * real hostname that needs DNS resolution" — reusing this rather than a second regex.
 */
export function parseIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!isDigits(p) || (p.length > 1 && p.startsWith('0'))) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

/**
 * Is this IPv4 address in a range we must never send traffic to?
 * Ranges per RFC 1918, RFC 6890, and the cloud metadata link-local address.
 */
export function isBlockedIPv4(host: string): boolean {
  const ip = parseIPv4(host);
  if (!ip) return false;
  const [a, b] = ip;

  if (a === 0) return true;                          // 0.0.0.0/8 "this network"
  if (a === 10) return true;                         // 10.0.0.0/8 private
  if (a === 127) return true;                        // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local — METADATA
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16 private
  if (a === 192 && b === 0) return true;             // 192.0.0.0/24 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 carrier-grade NAT
  if (a >= 224) return true;                         // multicast + reserved + broadcast
  return false;
}

/** IPv6 forms that reach the host or the local network. */
export function isBlockedIPv6(host: string): boolean {
  // URL.hostname keeps the brackets for IPv6 literals.
  const raw = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!raw.includes(':')) return false;

  if (raw === '::' || raw === '::1') return true;              // unspecified, loopback
  if (raw.startsWith('fe80')) return true;                     // link-local
  if (raw.startsWith('fc') || raw.startsWith('fd')) return true; // unique local (fc00::/7)
  if (raw.startsWith('ff')) return true;                       // multicast

  // IPv4-mapped and IPv4-compatible forms tunnel the whole IPv4 problem through an IPv6
  // literal, so the embedded address has to be re-checked.
  //
  // CAUTION, and the reason this is not a one-line regex: the WHATWG URL parser
  // NORMALISES the dotted form. `new URL('http://[::ffff:169.254.169.254]/').hostname`
  // comes back as `[::ffff:a9fe:a9fe]` — hex, not dotted. A check that only looks for
  // `\d+\.\d+\.\d+\.\d+` therefore misses every mapped address that arrived through a URL,
  // which is all of them. A test caught exactly that bypass.
  const dotted = raw.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted?.[1] && isBlockedIPv4(dotted[1])) return true;

  const hexMapped = raw.match(/^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped?.[1] && hexMapped[2]) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    const asIPv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isBlockedIPv4(asIPv4)) return true;
  }

  return false;
}

/**
 * Validate a destination URL before we are willing to send anything to it.
 *
 * Rejects on the side of caution: an unparseable or unusual destination is refused rather
 * than normalised into something that might resolve inward.
 */
export function validateDestination(raw: string): SsrfCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid_url', reason: 'Destination is not a valid URL.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file:, gopher:, dict: and friends are classic SSRF escalation schemes.
    return { ok: false, code: 'bad_scheme', reason: `Scheme "${url.protocol}" is not allowed; use http or https.` };
  }

  if (url.username || url.password) {
    // Credentials in a destination URL would be forwarded by us and logged by us.
    return { ok: false, code: 'embedded_credentials', reason: 'Destination must not embed credentials.' };
  }

  const host = url.hostname.toLowerCase();
  if (!host) {
    return { ok: false, code: 'invalid_url', reason: 'Destination has no host.' };
  }

  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, code: 'bad_port', reason: 'Destination port is not valid.' };
    }
    if (BLOCKED_PORTS.has(port)) {
      return { ok: false, code: 'bad_port', reason: `Port ${port} is not a permitted webhook destination.` };
    }
  }

  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, code: 'blocked_host', reason: `Host "${host}" resolves to an internal network.` };
  }

  if (isBlockedIPv4(host) || isBlockedIPv6(host)) {
    return { ok: false, code: 'blocked_ip', reason: `Address "${host}" is in a reserved or private range.` };
  }

  // Decimal, octal and hex integer forms of an IPv4 address (2130706433 === 127.0.0.1)
  // bypass a dotted-quad check entirely, so refuse any all-numeric host outright rather
  // than trying to normalise every encoding.
  if (isDigits(host) || /^0x[0-9a-f]+$/i.test(host)) {
    return { ok: false, code: 'blocked_ip', reason: 'Numeric host encodings are not accepted.' };
  }

  return { ok: true, url };
}
