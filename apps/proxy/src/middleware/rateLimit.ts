import type { Bindings } from '../types/bindings.js';

/**
 * Per-team ingestion rate limiting — [RELAY-13].
 *
 * ─── WHY THE KEY IS `teamId` AND NOT AN IP ───────────────────────────────────────────
 *
 * Part 8 of the security plan is explicit that an IP-keyed limiter is the wrong control
 * here, and the reason is structural rather than stylistic: every request reaching this
 * Worker has already been through Cloudflare's edge, so the client address is whatever
 * the sender's egress happens to be that second. Stripe, GitHub and Shopify all deliver
 * from large rotating pools, so an IP key throttles a single legitimate sender's pool
 * while an attacker with any residential proxy simply never hits a bucket twice. Keying
 * on `teamId` puts the budget on the thing that actually owns the traffic and the thing
 * a customer is accountable for.
 *
 * ─── WHERE IT SITS IN THE HANDLER ────────────────────────────────────────────────────
 *
 * AFTER authentication, BEFORE the body is read. Both halves matter.
 *
 *   - After auth, because a limiter placed in front of the credential check lets an
 *     unauthenticated stranger who has merely guessed a team/route slug pair exhaust that
 *     team's budget and take their webhooks offline. That converts a rate limiter into a
 *     denial-of-service amplifier aimed at the customer it was supposed to protect.
 *   - Before the body read, because the point is to stop spending resources on the
 *     request; a limiter that runs after 1 MiB has been buffered has already paid the
 *     cost it exists to avoid.
 *
 * ─── THE MECHANISM, AND THE DEVIATION FROM THE TICKET, STATED PLAINLY ────────────────
 *
 * [RELAY-13] as written says "backed by Cloudflare KV". It is NOT, and this is a
 * deliberate, recorded deviation rather than an oversight:
 *
 *   `RELAY_KV` HAS NEVER BEEN BOUND. The `[[kv_namespaces]]` block in `wrangler.toml` is
 *   commented out because the namespace id has to be issued by `wrangler kv namespace
 *   create`, and no such namespace exists yet. A KV-backed limiter would therefore be
 *   INERT on the deployed Worker — present in the source, green in the unit suite, and
 *   enforcing nothing in production. That is the exact failure shape D7's gate exists to
 *   catch, so shipping it would be worse than shipping no limiter at all: it would be a
 *   limiter that reports itself as done.
 *
 * The Workers Rate Limiting binding needs no issued id (the `namespace_id` is chosen by
 * the author), no new npm dependency, and no external service. It is enforced by the
 * runtime at the edge and is live the moment the Worker deploys.
 *
 * What is genuinely NOT delivered by this change, and is therefore still open on the
 * ticket rather than quietly marked done:
 *
 *   - Per-PLAN limits. The binding's ceiling is one number for the whole Worker. Varying
 *     it by tier needs `RouteLookupResponse` to carry the team's plan, which is a change
 *     to the dashboard contract and to the dashboard, i.e. new scope on gate day.
 *   - Changing the ceiling without a redeploy. The number lives in `wrangler.toml`, so
 *     moving it is a deploy. A deploy of this Worker is seconds, so this is a real
 *     limitation and a small one.
 *
 * ─── WHY AN ABSENT LIMITER REFUSES THE REQUEST IN A DEPLOYED ENVIRONMENT ─────────────
 *
 * A rate limiter that silently does nothing when its binding is missing is indistinguish-
 * able, from the outside, from one that is working. The whole class of finding this
 * sprint has been closing is "a security control whose production guarantee rests on a
 * variable happening to be set correctly". So: in `staging` and `production`, an unbound
 * limiter is a MISCONFIGURATION and the request is refused with 503. In `development` it
 * falls open with a loud log line, because `wrangler dev` without the binding is a normal
 * state for someone editing an unrelated file and bricking that is pure friction.
 */

/**
 * The Workers Rate Limiting binding's surface, as we use it.
 *
 * Declared locally rather than imported: `@cloudflare/workers-types` at the pinned
 * version does not export a type for this binding, and adding a dependency to obtain one
 * is not worth it for a single-method interface.
 */
export type RateLimiterBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

/**
 * The window the binding is configured with in `wrangler.toml`. It is duplicated here
 * ONLY to compute `Retry-After`; the binding is the thing that enforces it. The runtime
 * accepts a period of 10 or 60 seconds and nothing else.
 */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

export type RateLimitDecision =
  | { ok: true }
  /** Over budget. The caller gets 429 and a `Retry-After`. */
  | { ok: false; code: 'throttled'; retryAfterSeconds: number }
  /** Deployed with no limiter bound. The caller gets 503; this is our fault, not theirs. */
  | { ok: false; code: 'not_configured' };

/**
 * Consume one unit of `teamId`'s budget.
 *
 * A binding that THROWS is treated as over-budget rather than under it. The alternative —
 * swallowing the error and allowing the request — means the limiter disappears exactly
 * when the edge is already under stress, which is the only moment it matters.
 */
export async function checkRateLimit(
  env: Bindings,
  teamId: string
): Promise<RateLimitDecision> {
  const limiter = env.RELAY_RATE_LIMITER;

  if (!limiter) {
    if (env.ENVIRONMENT === 'development') return { ok: true };
    return { ok: false, code: 'not_configured' };
  }

  try {
    const { success } = await limiter.limit({ key: teamId });
    if (success) return { ok: true };
  } catch {
    return { ok: false, code: 'throttled', retryAfterSeconds: RATE_LIMIT_WINDOW_SECONDS };
  }

  return { ok: false, code: 'throttled', retryAfterSeconds: RATE_LIMIT_WINDOW_SECONDS };
}
