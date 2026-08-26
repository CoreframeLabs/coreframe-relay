import type { RateLimiterBinding } from '../middleware/rateLimit.js';

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
  /**
   * Origin of the Next.js dashboard — the route-lookup endpoint the Worker reads its
   * config from, and the origin of the QStash consumer callback. `http://localhost:4002`
   * in local development.
   */
  RELAY_DASHBOARD_URL?: string;
  UPSTASH_QSTASH_URL?: string;
  UPSTASH_QSTASH_TOKEN?: string;
  /**
   * [RELAY-50] When set, `POST /in/…` accepts requests on a wholly local loop:
   * instead of publishing to QStash, the envelope is POSTed straight to
   * `@coreframe-relay/dashboard`'s consumer (`/api/relay/qstash-test`), which
   * bypasses signature verification (localhost-only) so the pipeline can be proven
   * end to end without a public callback or live QStash. Set on `wrangler dev`
   * only — deployed envs never have this binding.
   */
  RELAY_LOCAL_QUEUE_URL?: string;
  /** Idempotency keys and the route-lookup cache ([RELAY-4]). Still unbound — see below. */
  RELAY_KV?: KVNamespace;
  /**
   * [RELAY-13] Per-team, per-PLAN ingestion rate limiters — the Workers Rate Limiting
   * binding, declared in `wrangler.toml` under `[[unsafe.bindings]]`, one per plan tier.
   *
   * THREE bindings, not one. Cloudflare's Rate Limiting binding fixes its `limit`/`period`
   * at deploy time per binding — the `limit()` call only ever takes a `key`, nothing that
   * varies the ceiling per caller — so "per-plan limits" cannot be one binding whose
   * number changes at runtime. It has to be a small, fixed set of bindings, one per tier,
   * selected in application code by the team's plan. Full reasoning, including the
   * Cloudflare-docs confirmation of that constraint, is in `middleware/rateLimit.ts`.
   *
   * NOT KV, on purpose. `RELAY_KV` has never been bound (its `wrangler.toml` block is
   * commented out pending an issued namespace id), so a KV-backed limiter would be inert
   * on the deployed Worker while looking complete in the source. These bindings need no
   * issued id and are enforced by the runtime.
   *
   * Optional in the type for the same reason every other secret is: the Worker must boot
   * and answer /health when one is missing. NOT optional in behaviour — a deployed
   * environment missing the binding a request's plan resolves to refuses ingestion with
   * 503 rather than falling back to a different plan's ceiling or failing open.
   */
  RELAY_RATE_LIMITER_FREE?: RateLimiterBinding;
  RELAY_RATE_LIMITER_PRO?: RateLimiterBinding;
  RELAY_RATE_LIMITER_ENTERPRISE?: RateLimiterBinding;
  /**
   * [RELAY-67] Dashboard health endpoint the daily Cron Trigger pings to keep the
   * hosted Supabase project busy enough that Supabase Free's 7-day no-activity pause
   * never fires. Must be a full URL (e.g. `https://relay.coreframe-labs.dev/api/health`).
   * Absent in local dev, where the keep-warm is pointless.
   */
  RELAY_DASHBOARD_HEALTH_URL?: string;
  /**
   * [RELAY-67 / RELAY-44] DSN for `@sentry/cloudflare` — the Workers-native Sentry SDK,
   * NOT the dashboard's `@sentry/nextjs` (a Next.js-only SDK that does not run in the
   * Workers runtime at all; see `apps/dashboard/instrumentation.ts` for that side).
   *
   * Same optional-secret pattern as `RELAY_DASHBOARD_HEALTH_URL` immediately above: the
   * Worker must boot and answer /health even when this is unset, so a missing DSN
   * degrades to "Sentry disabled" (the `withSentry` options callback in `index.ts`
   * returns `undefined` when this is falsy — the SDK's own documented way to no-op),
   * never a boot failure. Set via `wrangler secret put SENTRY_DSN`, never as a `[vars]`
   * value in `wrangler.toml`.
   *
   * Whether this should REUSE the dashboard's existing Sentry project (`javascript-nextjs`,
   * org `coreframe-labs-ltd`, confirmed via Sentry MCP to be the only project in that org
   * as of this writing) or point at a new Workers-specific project is a decision for
   * whoever sets the real value — not resolved here. No real DSN exists anywhere in this
   * repo (checked `apps/dashboard/.env.example`, `sentry.client.config.ts`,
   * `instrumentation.ts` — all read `NEXT_PUBLIC_SENTRY_DSN`/`SENTRY_DSN` from env, none
   * hardcode a value), so none is invented here either.
   */
  SENTRY_DSN?: string;
  /**
   * [RELAY-12] Per-environment override for the ingest body-size cap, in bytes. Absent
   * (the normal case) falls back to `MAX_BODY_BYTES` (1 MiB) in `routes/ingest.ts`. Must
   * parse as a positive integer; an unset, empty, or malformed value falls back to the
   * default rather than disabling the cap — this floor exists specifically to keep an
   * unbounded body out of a 128MB isolate, so a bad env value must never widen it.
   */
  RELAY_MAX_BODY_BYTES?: string;
};

/** Values middleware attaches to the request context. */
export type Variables = {
  /** Correlation id carried end to end on the `relay-request-id` header. */
  requestId: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
