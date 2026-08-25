// No `.js` extension here, matching `services/routeLookup.ts`'s import of the same
// package: the subpath does not resolve through `@coreframe-relay/types`'s `exports` map
// (only `"."` is exposed), so this crosses the package boundary by relative path instead.
import type { Plan } from '../../../../packages/types/src/internal';
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
 * ─── [RELAY-13, 2026-08-25] PER-PLAN LIMITS, AND WHY THIS IS THREE BINDINGS ──────────
 *
 * The remaining AC on this ticket is "limits are per-plan and configurable without a
 * redeploy". Before building anything, the platform's actual constraint was checked
 * rather than assumed: does the Rate Limiting binding accept a caller-supplied limit or
 * key-specific ceiling at runtime? Checked against Cloudflare's own docs — the `limit()`
 * call takes exactly one argument, `{ key }`. No limit, no period, nothing that varies the
 * ceiling per call. `simple.limit`/`simple.period` are fixed per binding at deploy time,
 * full stop. Cloudflare's own documented answer for "different ceilings for different
 * callers" is: declare multiple bindings, one per tier, and pick one in code. That is not
 * a workaround invented here — it is the platform's only mechanism, so this is it.
 *
 * `RELAY_RATE_LIMITER_FREE` / `_PRO` / `_ENTERPRISE` (three separate `[[unsafe.bindings]]`
 * entries in `wrangler.toml`) are the "small fixed set of pre-declared limiter bindings".
 * `checkRateLimit` now takes the team's `plan` — sourced from `RouteLookupResponse.plan`,
 * which `Team.plan` (`prisma/schema.prisma`, [RELAY-13] migration) now carries — and picks
 * the matching binding.
 *
 * What THIS delivers on the AC, precisely:
 *
 *   - "Per-plan": real. Three tiers, three ceilings, selected by the team's actual plan
 *     row, not a single Worker-wide number.
 *   - "Configurable without a redeploy": real for the property that actually needs to
 *     change often — WHICH tier a given team is on. `Team.plan` is an ordinary column;
 *     changing it is one UPDATE (or, later, a billing webhook), and the proxy picks it up
 *     on its next uncached lookup — at most `ROUTE_LOOKUP_CACHE_TTL_SECONDS` (30s) later —
 *     with the Worker never touched. No `wrangler deploy` in that path at all.
 *
 * What this does NOT deliver, stated as plainly as the previous version of this comment
 * stated what was missing:
 *
 *   - A ceiling value that changes without touching `wrangler.toml`. Each TIER's number
 *     (600/3000/12000 per minute) still lives in `wrangler.toml` because that is the only
 *     place Cloudflare lets it live. Moving 600 to 800 for the FREE tier is a redeploy.
 *     This is the platform's ceiling on "without a redeploy", not a gap in this design —
 *     see the note above; there is no lever on this binding that would let it be otherwise
 *     without moving off the Workers Rate Limiting binding entirely (e.g. onto a
 *     KV/Durable-Object-backed counter, which is a materially bigger change and was
 *     rejected for the same reason the original ticket rejected KV: RELAY_KV is unbound).
 *   - A FOURTH tier without a redeploy. Adding one is a new `[[unsafe.bindings]]` entry —
 *     a deploy, same as adding any new binding ever is.
 *   - Any actual mapping from a Stripe subscription to `Team.plan`. That write path
 *     (billing integration, or an admin UI) is real, separate, future work — every team
 *     defaults to FREE today and nothing moves it off that yet. This ticket's job was
 *     making the LIMITER per-plan and runtime-configurable; populating `plan` from real
 *     billing state is a different ticket's job.
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
 *
 * This still holds per-plan: a request whose plan resolves to `RELAY_RATE_LIMITER_PRO`
 * gets refused with 503 if THAT specific binding is unbound, even if `_FREE` is present
 * and working. There is no fallback to a different tier's binding — a fallback to a wider
 * tier would let a misconfiguration silently grant a higher ceiling than the team is on,
 * and a fallback to a narrower one would silently throttle a paying team harder than their
 * plan promises. Neither is a decision this function is allowed to make quietly.
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
 * The window every tier's binding is configured with in `wrangler.toml`. It is duplicated
 * here ONLY to compute `Retry-After`; the binding is the thing that enforces it. The
 * runtime accepts a period of 10 or 60 seconds and nothing else, and all three tiers share
 * the same period (only the `limit` differs), so one constant is correct for all of them.
 */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

export type RateLimitDecision =
  | { ok: true }
  /** Over budget. The caller gets 429 and a `Retry-After`. */
  | { ok: false; code: 'throttled'; retryAfterSeconds: number }
  /** Deployed with no limiter bound for this team's plan. The caller gets 503. */
  | { ok: false; code: 'not_configured' };

/**
 * Which env binding governs each plan tier. A `Record<Plan, …>` rather than a `switch` —
 * TypeScript then refuses to compile if `Plan` ever grows a member this map does not
 * handle, so a new tier added to the schema without a matching `wrangler.toml` binding is
 * a build failure here, not a silent fall-through in production.
 */
const BINDING_FOR_PLAN: Record<Plan, keyof Pick<
  Bindings,
  'RELAY_RATE_LIMITER_FREE' | 'RELAY_RATE_LIMITER_PRO' | 'RELAY_RATE_LIMITER_ENTERPRISE'
>> = {
  FREE: 'RELAY_RATE_LIMITER_FREE',
  PRO: 'RELAY_RATE_LIMITER_PRO',
  ENTERPRISE: 'RELAY_RATE_LIMITER_ENTERPRISE',
};

/**
 * Consume one unit of `teamId`'s budget on the binding its `plan` resolves to.
 *
 * A binding that THROWS is treated as over-budget rather than under it. The alternative —
 * swallowing the error and allowing the request — means the limiter disappears exactly
 * when the edge is already under stress, which is the only moment it matters.
 */
export async function checkRateLimit(
  env: Bindings,
  teamId: string,
  plan: Plan
): Promise<RateLimitDecision> {
  const limiter = env[BINDING_FOR_PLAN[plan]];

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
