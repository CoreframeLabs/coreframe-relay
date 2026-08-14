/**
 * SSRF destination validator — re-export seam. [RELAY-4] built it, [RELAY-33] moved it.
 *
 * The implementation now lives in `packages/types/src/ssrf.ts` so the ingest path (here)
 * and the forward path (`apps/dashboard/lib/relay/ssrfGap.ts`) run ONE function rather
 * than two copies. This file stays so every existing import site inside the Worker keeps
 * working unchanged, and so the Worker's dependency on the control is still visible in
 * its own source tree.
 *
 * A re-export, deliberately, not a wrapper. `export { x } from '…'` preserves the
 * function's identity, so `proxySsrf.validateDestination === typesSsrf.validateDestination`
 * is literally true — which is what `test/ssrf.test.ts` asserts to satisfy RELAY-33's
 * "a test proves both paths import the SAME function". A wrapper would pass a behavioural
 * test and quietly reintroduce the thing being guarded against: a second place to edit.
 */
export {
  validateDestination,
  isBlockedIPv4,
  isBlockedIPv6,
  type SsrfCheck,
  type SsrfReason,
} from '@coreframe-relay/types';
