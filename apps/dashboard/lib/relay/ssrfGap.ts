import { DestinationUrlSchema } from '@coreframe-relay/types';

/**
 * ⚠ KNOWN SECURITY GAP — the consumer does NOT run the real SSRF validator. [RELAY-5]
 *
 * THE GAP, stated plainly so nobody reads this file as protection it is not:
 *
 * The real validator — literal-address blocking for RFC-1918, loopback, link-local
 * (169.254.169.254), blocked hostnames, blocked ports and embedded credentials — was
 * built in [RELAY-4] and lives at `apps/proxy/src/services/ssrf.ts`. It is inside the
 * Cloudflare Worker package. This consumer runs in the Next.js dashboard and CANNOT
 * import across that boundary today, and copy-pasting the validator here would create a
 * second copy of security-critical logic that drifts silently from the first — which is
 * strictly worse than one honest gap, because both copies would then look correct.
 *
 * **[RELAY-33] is the ticket that fixes this** by extracting the validator to a shared
 * package. Its acceptance criteria already require "a test proves both paths import the
 * SAME function — not two copies". When it lands, the fix here is ONE line: change the
 * import in `lib/relay/forward.ts` from this module to the shared package. The type and
 * signature below are matched to `validateDestination(raw: string): SsrfCheck` in
 * `apps/proxy/src/services/ssrf.ts` on purpose so nothing else has to change.
 *
 * WHAT THIS MEANS OPERATIONALLY UNTIL THEN:
 *
 *   - The destination IS validated at ingestion time by the proxy, which does run the
 *     real validator. So a route pointing at 169.254.169.254 is rejected before anything
 *     is ever queued.
 *   - It is NOT re-validated here, at forward time. The window this leaves open is a
 *     destination edited to an internal address AFTER a payload was queued but BEFORE it
 *     is delivered — plus every DLQ replay, which starts from a stored envelope.
 *   - The check below is shape-only (`DestinationUrlSchema`: absolute http(s) URL). It
 *     stops a `file://` or `gopher://` destination and nothing else. It is not the
 *     control; it is the seam the control plugs into.
 */

/** Mirrors `SsrfCheck` in `apps/proxy/src/services/ssrf.ts` — errors as values, not throws. */
export type SsrfCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string; code: SsrfReason };

/** Mirrors `SsrfReason` in `apps/proxy/src/services/ssrf.ts`. */
export type SsrfReason =
  | 'invalid_url'
  | 'bad_scheme'
  | 'embedded_credentials'
  | 'blocked_host'
  | 'blocked_ip'
  | 'bad_port';

/**
 * Shape-only stand-in for the real validator. See the gap notice above before relying on
 * this for anything.
 */
export function validateDestination(raw: string): SsrfCheck {
  const parsed = DestinationUrlSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'destination is not an absolute http(s) URL',
      code: 'bad_scheme',
    };
  }

  try {
    return { ok: true, url: new URL(parsed.data) };
  } catch {
    return {
      ok: false,
      reason: 'destination is not a parseable URL',
      code: 'invalid_url',
    };
  }
}
