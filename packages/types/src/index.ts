/**
 * @coreframe-relay/types — the shared contract.
 *
 * Both apps compile against this: the Next.js dashboard and the Cloudflare Worker proxy.
 * Without it the two drift, and a webhook envelope that one side writes becomes something
 * the other cannot read.
 *
 * Rule from relay-engineering-standards.md Part 4: never hand-write an `interface` or
 * `type` for a domain object. Derive it from the Zod schema — the schema IS the
 * documentation, and it is the only version that also validates at runtime.
 */
export * from './route';
export * from './delivery';
export * from './dlq';
export * from './approval';
// [RELAY-33] The SSRF destination validator. It is a security control rather than a
// schema, and it lives in this package for the same reason the schemas do: both apps
// must run the SAME one. A second copy on the forward path is the failure this move
// exists to prevent — two copies drift silently and both then look correct.
export * from './ssrf';
// [RELAY-33] Layer two: DNS-over-HTTPS resolution + re-validation of resolved addresses,
// closing the DNS-rebinding gap `./ssrf.ts`'s own header names as unclosed. The same
// one-function-not-two-copies reasoning applies — both apps import
// `resolveAndValidateDestination` from here.
export * from './ssrf-dns';
// The proxy↔dashboard internal contract. Exported here so both apps import it as
// `@coreframe-relay/types` rather than by relative path across an app boundary — the
// package's `exports` map only exposes `"."`, so a subpath import does not resolve.
export * from './internal';
