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
export * from './route.js';
export * from './delivery.js';
export * from './dlq.js';
export * from './approval.js';
