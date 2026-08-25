/**
 * SSRF destination validator on the FORWARD path — re-export seam. [RELAY-33].
 *
 * ─── THE GAP THIS FILE USED TO BE, AND IS NOT ANY MORE ───────────────────────────────
 *
 * Until RELAY-33 this module was a Zod shape check and nothing else. `validateDestination`
 * ran `DestinationUrlSchema` — "is this an absolute http(s) URL?" — which
 * `http://169.254.169.254/latest/meta-data/` passes, because it IS one. The real validator
 * (literal-address blocking for RFC-1918, loopback, link-local, blocked hostnames, blocked
 * ports, embedded credentials, numeric host encodings) was built in RELAY-4 and lived
 * inside the Cloudflare Worker package, where the Next.js consumer could not import it.
 *
 * So the destination was validated at INGEST time and not at FORWARD time, and the window
 * that left open was precisely the one an attacker wants: edit a route's destination to an
 * internal address after a payload is queued but before it is delivered. Every DLQ replay
 * had the same shape, because a replay starts from a stored envelope.
 *
 * The original author deliberately did NOT copy the validator here — two copies of
 * security-critical logic drift silently and both then look correct — and shaped this
 * module's signature to match the real one so the fix would be an import swap. It was.
 *
 * ─── WHAT IT IS NOW ──────────────────────────────────────────────────────────────────
 *
 * The implementation lives in `packages/types/src/ssrf.ts`, which was ALREADY a dependency
 * of both apps, so nothing was installed (RELAY-62 forbids `pnpm add`). This is a
 * re-export, not a wrapper: the function identity is preserved, so the ingest path and the
 * forward path hold the same function object — asserted by reference equality in
 * `apps/proxy/test/ssrf.test.ts`.
 *
 * Callers: `lib/relay/forward.ts` and `pages/api/teams/[slug]/relay/dlq/[id]/retry.ts`.
 * Neither needed an edit, which is why the filename is still `ssrfGap.ts` — renaming it
 * would touch `retry.ts`, a file another agent is concurrently wrapping in `withTeamScope`
 * (RELAY-84), and a rename collision on a security fix is not a trade worth making. The
 * rename is a follow-up, and it is cosmetic: the control is live either way.
 *
 * ─── THE REMAINING GAP, NOW CLOSED ────────────────────────────────────────────────────
 *
 * `validateDestination` alone is a LITERAL-ADDRESS validator — it does not resolve DNS, so
 * a hostname that resolves to 169.254.169.254 passed straight through it. That was
 * RELAY-33's last open AC: "DNS resolved on our side and the RESOLVED address re-checked."
 *
 * `resolveAndValidateDestination`, re-exported below from `packages/types/src/ssrf-dns.ts`,
 * closes it: a DNS-over-HTTPS lookup (Cloudflare cannot resolve DNS directly — no `dns`
 * module, no raw socket) of every A/AAAA record, each re-checked through
 * `isBlockedIPv4`/`isBlockedIPv6`. `forward.ts` calls it, not `validateDestination`
 * directly, and calls it IMMEDIATELY before the outbound `fetch` — resolving once, early,
 * would just move the TOCTOU window rather than close it, since the record can change
 * again between an early resolution and the actual send. See `ssrf-dns.ts`'s own header
 * for the residual gap that remains even so (neither Workers nor Node `fetch` lets us pin
 * the connection to the address we just validated — the runtime re-resolves at connect
 * time) and why that is out of reach from inside a fetch-only runtime.
 *
 * `forward.ts` also sets `redirect: 'manual'`, which closes the redirect-chain half of the
 * same problem, and that is the reason it must stay.
 */
export {
  validateDestination,
  resolveAndValidateDestination,
  isBlockedIPv4,
  isBlockedIPv6,
  type SsrfCheck,
  type SsrfReason,
  type ResolveOptions,
} from '@coreframe-relay/types';
