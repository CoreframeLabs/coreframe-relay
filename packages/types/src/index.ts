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
// The proxy↔dashboard internal contract. Exported here so both apps import it as
// `@coreframe-relay/types` rather than by relative path across an app boundary — the
// package's `exports` map only exposes `"."`, so a subpath import does not resolve.
export * from './internal';
