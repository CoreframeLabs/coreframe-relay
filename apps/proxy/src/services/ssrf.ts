/**
 * SSRF destination validator — re-export seam. [RELAY-4] built it, [RELAY-33] moved it.
 *
 * The implementation now lives in `packages/types/src/ssrf.ts` (+ `ssrf-dns.ts` for DNS
 * resolution) so the ingest path (here) and the forward path
 * (`apps/dashboard/lib/relay/ssrfGap.ts`) run ONE function rather than two copies. This
 * file stays so every existing import site inside the Worker keeps working unchanged, and
 * so the Worker's dependency on the control is still visible in its own source tree.
 *
 * A re-export, deliberately, not a wrapper. `export { x } from '…'` preserves the
 * function's identity, so `proxySsrf.validateDestination === typesSsrf.validateDestination`
 * is literally true — which is what `test/ssrf.test.ts` asserts to satisfy RELAY-33's
 * "a test proves both paths import the SAME function". A wrapper would pass a behavioural
 * test and quietly reintroduce the thing being guarded against: a second place to edit.
 *
 * `resolveAndValidateDestination` is the DNS-resolving layer — [RELAY-33]'s final AC.
 * `routes/ingest.ts` calls IT, not the literal-only `validateDestination`, so a hostname
 * that resolves to 169.254.169.254 is refused at ingest even though it passes the literal
 * check. `validateDestination` stays exported because `resolveAndValidateDestination`
 * calls it internally and because tests assert on the literal layer directly.
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
