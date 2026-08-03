/**
 * Cloudflare Workers environment bindings.
 *
 * Secrets are declared here so a missing one is a type error at the call site rather than
 * an `undefined` that reaches a comparison. They are OPTIONAL on purpose: the Worker must
 * boot and answer /health even when a secret has not been set, so that a misconfigured
 * deploy reports itself instead of failing to start.
 */
export type Bindings = {
  ENVIRONMENT: 'development' | 'staging' | 'production';
  /** Shared with the dashboard; authenticates inbound requests. Min 32 chars. */
  RELAY_API_SECRET?: string;
  UPSTASH_QSTASH_URL?: string;
  UPSTASH_QSTASH_TOKEN?: string;
  /** Idempotency keys and rate-limit counters ([RELAY-4]). */
  RELAY_KV?: KVNamespace;
};

/** Values middleware attaches to the request context. */
export type Variables = {
  /** Correlation id carried end to end on the `relay-request-id` header. */
  requestId: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
