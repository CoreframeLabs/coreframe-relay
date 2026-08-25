# Relay launch test plan

## RELAY-91 addendum — cross-tenant isolation suite, D7 measured result

**Date measured:** 2026-08-18 (D7, hard gate day)
**Branch:** `relay/launch-tests`, worktree `../coreframe-relay-worktrees/launch-tests`
**Suite:** `apps/dashboard/__tests__/relay/cross-tenant-isolation.spec.ts`
**Run against:** an explicit `relay_app`-scoped Prisma client (`RELAY_APP_DATABASE_URL_LOCAL`
via `createScopedPrismaClient`), independent of whatever `DATABASE_URL` the rest of the
suite uses — never the ambient `postgres` connection. RLS confirmed enabled+forced on all
six protected tables and `relay_app` confirmed `rolbypassrls=false` by `__tests__/lib/rls.spec.ts`
(13/13 passed) on the same local stack immediately before this run.

**Command:** `npx jest __tests__/relay/cross-tenant-isolation.spec.ts --runInBand`

### Result: 14 of 18 tests passed, 4 failed. Reproduced twice, identical result both runs.

**Coverage: all 10 relay units.** The 4 already-wrapped (`dlq/index.ts`, `dlq/[id]/retry.ts`,
`lib/relay/consume.ts`'s `consumeEnvelope`, `models/route.ts`'s `fetchRouteBySlugs`) plus the
6 `relay/rls-wrap` is wrapping (`routes/index.ts`, `destination-headers.ts`,
`rotate-token.ts`, `test-send.ts`, `log.ts`, `log-stream.ts`).

### Negative controls (the leak test) — 10 of 10 passed, zero leaks measured

Every handler/unit was exercised with Team A authenticated as itself, reaching for a
resource id created under Team B. In every case: zero rows, a clean 404, or a refusal —
never Team B's data, never a mutation, never an outbound side effect (fetch to the
victim's real destination) toward Team B's resource. This holds **regardless of
RELAY-84's wrap status** — the reason is that `models/route.ts` / `models/delivery.ts` /
`models/dlq.ts` already filter every query by `teamId` at the application layer, and RLS
is defence in depth on top of that. **No leak was found on any of the 10 units,
including the 6 still-unwrapped handlers.**

### Positive controls (own-team access still works) — 4 of 8 passed

| Unit | Result | Reason |
|---|---|---|
| `dlq/index.ts` | PASS | Already wrapped (RELAY-39/RELAY-8) |
| `models/route.ts` `fetchRouteBySlugs` | PASS | Already wrapped — resolves Team unscoped (no RLS policy on Team), then wraps the Route lookup in `withTeamScope` derived from that row |
| `routes/index.ts` | **FAIL** | Not yet wrapped in `withTeamScope` — blocked on RELAY-84 |
| `destination-headers.ts` GET | **FAIL** | Not yet wrapped — blocked on RELAY-84 |
| `log.ts` | **FAIL** | Not yet wrapped — blocked on RELAY-84 |
| `lib/relay/consume.ts` `consumeEnvelope` | **FAIL — NOT gated by RELAY-84** | See below. New finding. |

(`rotate-token.ts`, `test-send.ts`, `log-stream.ts` do not have positive-control
assertions in this suite yet — negative-control coverage exists for all three and is
green; own-team-still-works coverage for these three is a gap to close alongside the
RELAY-84 merge, not before D7's gate.)

### New finding: `consumeEnvelope`'s own-team delivery fails under `relay_app`, independent of RELAY-84

`lib/relay/consume.ts` calls `assertRouteBelongsToTeam(teamId, routeId)` **before**
`withTeamScope(teamId, ...)` is established (by design — see the comment in that file: the
DB's word must gate scope, not the caller's claim). That first query therefore runs with
no ambient team scope. Under `relay_app` with RLS forced, an unscoped query denies every
row — including a genuinely matching, legitimate `(teamId, routeId)` pair. Measured
directly: a real envelope for Team A's own route, sent to `consumeEnvelope`, returned
`400 { error: 'bad_request' }` instead of `200 { status: 'delivered' }`, and no
`DeliveryLog` row was written.

This is **not** a cross-tenant leak — the negative control for the same function (a
forged Team A / Team B route pair) correctly denies and is green, proving no leak
independently. It is a **functional gap**: once `DATABASE_URL` flips to `relay_app`
(G2a), every real webhook delivery through `consumeEnvelope` will 400 rather than
deliver, regardless of RELAY-84's six-handler wrap landing. This sits squarely inside
D4's "silent zero rows" failure mode the plan already names, but on the delivery path
itself rather than on a read surface, and is not currently ticketed under RELAY-84.

This file's edits do not touch `lib/relay/consume.ts` (out of this branch's file
boundary — `apps/dashboard/__tests__/**` and this doc only). Flagging for the director /
whichever lane owns the RLS wrapping to add a ticket before G2a, or `consumeEnvelope`
needs its own scope fix ahead of the `DATABASE_URL` flip.

### S7 — verdict

**S7: FAIL, blocked on `routes/index.ts`, `destination-headers.ts`, `rotate-token.ts`,
`test-send.ts`, `log.ts`, `log-stream.ts` (RELAY-84, in flight on `relay/rls-wrap`), plus
a newly measured, not-yet-ticketed gap in `lib/relay/consume.ts`'s `consumeEnvelope`.**

The isolation half of S7 — "cross-tenant isolation holds with `where teamId` omitted" —
is proven: 10 of 10 negative controls green, zero leaks across every unit tested,
mechanism-level proof already independently confirmed by `rls.spec.ts` (13/13). What is
red is the **availability** half implicit in F3/F4/F6: six handlers currently return
zero rows for their own caller under `relay_app`, and `consumeEnvelope` currently 400s
every real delivery under `relay_app`, until the fixes above land. Re-run this exact
suite after `relay/rls-wrap` merges and `DATABASE_URL` flips (G2a) — it will read S7:
PASS the day both are true, without needing to be rewritten.

---

*This suite's own header comments carry the full rationale for why it connects as an
explicit `relay_app` client rather than the ambient `DATABASE_URL`, why the models/team
mock is configured inside `jest.isolateModules` rather than at the outer binding, and
why `consumeEnvelope`/`fetchRouteBySlugs` are exercised directly rather than through a
req/res double. Read the file before re-running it elsewhere.*

---

## n8n-wedge Payment Link — test-mode verification (2026-08-19)

**Scope note:** this is deliberately *not* RELAY-49 (the general Stripe products/prices/
Checkout/webhook/Customer Portal/entitlements ticket, still TODO). It is a smaller slice:
one test-mode Product, one Price ($19/mo, the single-flat-tier recommendation in
`growth/product/design-panel/product-owner-revenue-2026-08-19.md` §5), one Payment Link,
and a webhook path that marks a team as paying. No tier enforcement, no metering, no new
billing model — see `apps/dashboard/pages/api/webhooks/stripe.ts` and
`apps/dashboard/scripts/create-n8n-wedge-price.mjs` for what actually shipped.

**Branch/worktree:** `relay/stripe-payment-link`, worktree `../coreframe-relay-worktrees/stripe-paymentlink`.

**What already existed and was reused, not rebuilt:** the BoxyHQ starter kit ships a
complete Stripe billing scaffold — `lib/stripe.ts` (customer creation), `models/subscription.ts`
(`Subscription.active` — already exactly the "paid/not-paid flag" this ticket needed),
`models/price.ts`/`models/service.ts`, a webhook consumer at `pages/api/webhooks/stripe.ts`
already handling `customer.subscription.created/updated/deleted`, an in-app Checkout Session
flow (`pages/api/teams/[slug]/payments/create-checkout-session.ts`), a Customer Portal link
(`create-portal-link.ts` + `LinkToPortal.tsx`), and a full billing page at
`/teams/[slug]/billing` gated on `FEATURE_TEAM_PAYMENTS` + both Stripe env vars being set —
all wired into team RBAC (`team_payments` permission) and nav (`TeamTab.tsx`). None of this
was known to be present before this ticket started; it changed what "smallest slice" meant —
see the commit message for the full reasoning. The `stripe` npm package (17.7.0) was
already a dependency; nothing new was installed.

**What this ticket added:**
1. `scripts/create-n8n-wedge-price.mjs` — idempotent script creating one test-mode Product,
   one recurring Price ($19.00/month USD, `lookup_key: relay_n8n_wedge_monthly`), and one
   Payment Link. Refuses to run against anything but an `sk_test_` key.
2. `pages/api/webhooks/stripe.ts` — added `checkout.session.completed` to `relevantEvents`
   and a new `handleCheckoutSessionCompleted` handler. Its only job: read
   `client_reference_id` (the team id, appended to the Payment Link URL as a query param —
   Stripe's documented mechanism for this) and `customer` off the completed session, and set
   `Team.billingId`/`billingProvider` to that customer. The existing
   `customer.subscription.created` handler (unchanged) then populates `Subscription.active`
   for that same customer id, same as it already does for the in-app Checkout flow.
3. `components/billing/N8nWedgePaymentLink.tsx` + a card on the existing `/teams/[slug]/billing`
   page — surfaces the Payment Link (with `?client_reference_id=<team.id>` appended) to a
   logged-in team member. Hidden entirely if `NEXT_PUBLIC_N8N_WEDGE_PAYMENT_LINK` is unset.

**Command:** `node --env-file .env scripts/create-n8n-wedge-price.mjs`, then
`node --env-file .env scripts/verify-n8n-wedge-checkout.mjs` against a locally running
`next dev` instance.

### Result: all 9 automated checks passed, run against real Stripe test-mode objects and a real local Postgres row

```
PASS — Product exists in Stripe test mode
PASS — Price exists ($19.00/month USD)
PASS — Payment Link exists and is active
PASS — Payment Link URL resolves (HTTP 200)
PASS — A test team exists locally (relay-dev)
PASS — Webhook endpoint returned 200 (got 200)
PASS — Invalid signature is rejected (got HTTP 400, expected 400)
PASS — Team.billingId now equals the checkout session's customer (cus_test_65733dc511b1d0c1)
PASS — Team.billingProvider is 'stripe'
```

Live Stripe test-mode IDs created by this run: Product `prod_V6KH4CgiGqXFu4`, Price
`price_1U67d7FxMn2UXI5YBuA94Tcb`, Payment Link `plink_1U67d7FxMn2UXI5YoZKE96E6`
(`https://buy.stripe.com/test_dRmcN50tTf5H58E8BH4Vy00`). Re-running the create script found
all three already existing rather than duplicating them (idempotency check, both runs
logged). `pnpm run sync-stripe` synced 1 product / 1 price into the local DB, which also
makes the existing `ProductPricing`/`PaymentButton` "Get Started" flow on the billing page
usable for the same Price via the in-app Checkout Session path.

### What was and wasn't verified end-to-end

**Verified for real:** the Stripe objects exist and are live (not mocked); the webhook
route's signature verification accepts a correctly-signed payload and rejects a
badly-signed one (400, not a silent pass); a `checkout.session.completed` event carrying a
real team's id as `client_reference_id` results in that exact team's `billingId`/
`billingProvider` being written to Postgres, read back, and confirmed. `check-types`,
`check-lint`, and the full Jest suite (143/143) all pass on the changed files with zero
new failures.

**Not verified by this script, and why:** the actual card-entry step on Stripe's hosted
Checkout page. Submitting a card number — even the `4242 4242 4242 4242` test card —
requires either a real browser driving Stripe.js/the hosted page, or a raw API call that
would route card data through something other than Stripe's own client-side surface. This
project's PCI posture (SAQ A: card data never reaches our server) rules out the latter even
in test mode, so this was deliberately left as a manual step rather than faked. The signed
synthetic webhook event used above is the same technique Stripe's own docs recommend for
testing webhook handlers without waiting for a live payment.

### Manual click-through (not yet executed — no browser available in this environment)

1. `pnpm dev`, then in another terminal: `stripe listen --forward-to localhost:4002/api/webhooks/stripe`.
2. Log into the dashboard, open a team's Billing tab. The "Pay with Stripe" card renders
   the Payment Link with `?client_reference_id=<team.id>` appended.
3. Complete checkout with `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
4. Confirm `checkout.session.completed` (200) in the `stripe listen` terminal.
5. `SELECT id, slug, "billingId", "billingProvider" FROM "Team" WHERE slug = '<team-slug>';`
   and confirm both columns now point at the real customer created by the purchase.

Whoever runs this manual pass next should update this section with the actual result
rather than leave it as a TODO — per this workspace's evidence rule, an unrun step stays
named as unrun until someone measures it.

---

## GO/NO-GO sheet — recalibrated for the current shape (2026-08-25)

**RELAY-91 AC2.** The original AC asked for a sheet "recalibrated to the free 'Founding
Access' launch shape" — that shape is itself dead. Per `growth/product/relay-sprint-plan.md`'s
own RELAY-91 reconciliation note (2026-08-21): *"the live plan is no longer a free launch
but the flat $19/mo n8n tier... recalibrate the sheet against the CURRENT checkpoint
mechanics in `relay-n8n-wedge-execution-plan-2026-08-21.md` §4 (the double-down/abandon
test)."* This section does that.

### Why this is a different kind of gate than the original §5 sheet

The original `growth/product/relay-launch-sprint.md` §5 "HARD GO/NO-GO GATE" (2026-08-18)
gated a single **launch day** — a frozen SHA, a specific 09:00 deploy, a specific 10:00
"open signups" moment. That day already happened; production has been live and taking real
signups continuously since 2026-08-18/19 (`relay-dev-log.md`'s "2026-08-18, later D7"
entry: production served the merged tree with real signup proven). **There is no future
"launch day" left to gate in that sense.** What the CURRENT plan actually asks a director
to decide next is narrower and commercial, not ceremonial: **is it safe and honest to (a)
flip the n8n-wedge Stripe Payment Link from test-mode to live, and (b) start Phase B's
real public organic-outreach sends** (`relay-n8n-wedge-execution-plan-2026-08-21.md` §2)?
Those two actions are what actually starts the real, money-collecting 90-day clock the CEO
ruling measures against (§4 below) — not the SHA that happens to be deployed today. This
sheet gates *that* decision, keeping the original sheet's category structure (Security /
Functional / Honesty-Commercial / Operational, any red = NO-GO) because it is a sound
structure, but re-measuring every condition against what is true **today**, not what was
true or planned on 2026-08-18.

**Every line below is either cited to a specific ticket/file/commit already verified
elsewhere in this tracker, or explicitly marked as re-checked directly for this sheet.**
Nothing here is a fresh, unverified number.

### Security (any red = NO-GO, no override)

| # | Condition | Status | Evidence |
|---|---|---|---|
| S1 | The 5 original launch-week criticals fixed | **3 of 5 green, 2 amber** | RELAY-71/72/73 DONE, independently re-verified against the merged tree (`relay-sprint-plan.md` RELAY-71/72/73 entries, 2026-08-20/21). RELAY-74 IN PROGRESS — the code guard is confirmed real by direct read, but AC2's dedicated test proving "one unauthenticated request against a production-flagged environment returns non-200" was not located (`relay-sprint-plan.md` RELAY-74 entry, 2026-08-21). RELAY-33 IN PROGRESS — DNS-rebinding re-check is genuinely open (`packages/types/src/ssrf.ts`'s own header admits it, `relay-sprint-plan.md` RELAY-33 entry) and a dedicated agent (`relay-33-dns-rebinding`) was dispatched against it earlier today per `relay-dev-log.md`'s 2026-08-25 dispatch entry — outcome not yet known as of this writing. |
| S2 | `smoke-destination.ts` refuses an unauthenticated request in production | **Amber** | Guard code confirmed correct by direct read (`localOnlyVerdict()`, fail-safe on any deploy-platform env var); the specific automated test proving it is still missing (same RELAY-74 AC2 gap as S1). |
| S3 | Per-team rate limiting live | **Amber, deliberate deviation** | `apps/proxy/src/middleware/rateLimit.ts` keyed on `teamId` (never IP), returns 429 + `Retry-After`, tested (`relay-sprint-plan.md` RELAY-13 entry, 2026-08-21). Not KV-backed (`RELAY_KV` never bound) and not per-plan-configurable — both explicitly documented gaps, not oversights. Acceptable for current single-flat-tier, 3-5-customer scale; would need revisiting before a tiered-pricing launch. |
| S4 | SSRF validator runs at forward time | **Green** | RELAY-73 DONE, merged `bd5cf1f`, tested (`ssrf.forward.spec.ts` asserts on the listener itself). |
| S5 | All 5 flagged credentials rotated | **RED** | RELAY-46 Status: TODO, zero ACs ticked (`relay-sprint-plan.md` RELAY-46 entry). No credential inventory file exists. This is the single most-restated open item across every dev-log NEXT ACTION line since D7 (2026-08-18) through 2026-08-25. |
| S6 | Runtime DB role is `relay_app`, `rolbypassrls=false` | **Green** | RELAY-39/G2a flipped 2026-08-21, re-confirmed stable 2026-08-25 by direct query: `SELECT usename, count(*) FROM pg_stat_activity` shows a live `relay_app` connection against production right now, plus a fresh signup succeeding (`relay-dev-log.md`, "RELAY-39 flipped" entry, 2026-08-21 body + 2026-08-25 re-verification note). |
| S7 | Cross-tenant isolation holds under `relay_app` | **Green, but re-run recommended** | 18/18 on the merged tree, 2026-08-18 (`relay-sprint-plan.md` RELAY-91 entry, AC1). Not independently re-run against production specifically since the G2a flip landed 3 days later (2026-08-21) — `relay-n8n-wedge-execution-plan-2026-08-21.md` §3 C2 step 3 names exactly this re-run as part of the post-flip verification checklist. Recommended, not yet confirmed done. |
| S8 | No credential appears in any log line | **Open, unverified** | RELAY-18 Status: TODO — the dedicated test/lint rule this condition asks for does not exist (`relay-sprint-plan.md` RELAY-18 entry). Not known to be failing; simply not proven either way. |

### Functional

| # | Condition | Status | Evidence |
|---|---|---|---|
| F1 | The real proxy Worker (not Cloudflare's stub) serves `in.relay.coreframe-labs.dev` | **Green** | RELAY-43 fixed 2026-08-21 (4 stacked infra bugs), a real webhook proven through the public ingest URL to a real `DeliveryLog` row via direct Supabase query, and a follow-up 503 fix 2026-08-25 (proxy route-lookup timeout + Vercel region mismatch) re-measured 5/5 clean after the fix (`relay-dev-log.md`, both 2026-08-21 "RELAY-43 fixed" and 2026-08-25 "RETRYING forever" entries). |
| F4 | A stranger can sign up; email verification works | **Amber, signup only** | Signup + full credentials session round trip proven repeatedly, most recently cited in RELAY-42's 2026-08-25 AC closure. Email **verification** specifically is still RELAY-48 AC2, unticked — Resend sending is proven by direct API receipt, but the app's own signup-verification mail path has not been proven end to end (`relay-sprint-plan.md` RELAY-48 entry). |
| F6 | A real webhook with no custom header lands a real `DeliveryLog` row | **Green** | Proven live 2026-08-21 and again implicitly by the 2026-08-25 503 fix's own 5/5 re-test (`relay-dev-log.md`, both entries). |
| F7 | DLQ retry re-delivers on the real production hosts | **Open — this is what RELAY-90's runbook (`docs/production-smoke-runbook.md`) exists to prove** | Proven locally (23 assertions, `relay-dev-log.md` 2026-08-11). Not yet re-run against the real production hosts end to end this session — see that runbook's step 9 for the exact expected production behavior (`202`, not the local `502 QStash refused` substitution). |

### Honesty and commercial (any red = NO-GO)

| # | Condition | Status | Evidence |
|---|---|---|---|
| H1 | The live price matches the decided price | **Green** | RELAY-108 DONE, merged `main` at `e0d38bf` (confirmed by direct `git merge-base --is-ancestor` check against `origin/main`, 2026-08-25). `£99` removed from every landing surface, `$19/mo` live, confirmed by real-browser Playwright check against rendered DOM text, not just source (`relay-sprint-plan.md` RELAY-108 entry). |
| H2 | No unbuilt capability is sold | **Green** | Gate/Shield remain roadmap-labelled or absent (formally PARKED, `relay-sprint-plan.md` Epic 7/Epic 4 banners, 2026-08-20). The stale DLQ header-loss disclaimer (a real shipped fix, RELAY-65, that the landing page and `docs/integrations/n8n.md` were still disclaiming as a limitation) was found and fixed 2026-08-21, commit `81e2a2a` (`relay-dev-log.md`, 2026-08-21 entry). |
| H3 | Legal documents (Terms/Privacy/DPA/Refund) are live and linked, and reachable | **Green** | RELAY-102 DONE; all four pages confirmed `200` by direct curl 2026-08-20, after a real bug (two of the four pages 307-redirecting to login) was found post-deploy and fixed the same day (`relay-dev-log.md`, 2026-08-20 entry). |
| H4 | **(New for this shape.)** A real customer can actually pay real money | **RED** | `scripts/create-n8n-wedge-price.mjs` hard-refuses any Stripe key that isn't `sk_test_` by construction (`relay-gtm-readiness-audit-2026-08-21.md` §3.3, verified by direct code read). The live Payment Link is `https://buy.stripe.com/test_dRmcN50tTf5H58E8BH4Vy00` — test-mode, by its own URL. Vercel's Hobby/Pro spend decision (`relay-launch-decisions.md` decision #8) and the Stripe go-live decision are both still unsigned director actions (`relay-dev-log.md`'s NEXT ACTION line, most recently restated 2026-08-21, not contradicted since). **This is the single most consequential red on this sheet**: every other condition being green does not matter if nobody can actually become a paying customer. |

### Operational

| # | Condition | Status | Evidence |
|---|---|---|---|
| O1 | Deploy requires review; `main` cannot ship unreviewed | **Deprioritised by design, not red** | The `release`-branch/Vercel-Production-Branch machinery this originally asked for is deliberately deprioritised behind Stripe go-live per `relay-sprint-plan.md` RELAY-85's 2026-08-21 reconciliation note (sized for a multi-customer launch this scale doesn't need yet). Every launch-week change has in practice shipped through a manually-reviewed `main` merge, which the same note calls an adequate control at this scale. |
| O2 | Rollback drilled | **Parked, not red** | `relay-sprint-plan.md` RELAY-45 entry: the runbook doc is real and live; the formal timed-drill scope is explicitly parked until before a wider public launch past the 90-day checkpoint. |
| O3 | Kill switch drilled, time-to-effect recorded | **Open** | `relay-sprint-plan.md` RELAY-89 entry: script exists, fails safe when unconfigured, but has never been pointed at a real account — no drill recorded anywhere in the dev log. |
| O4 | Watch rota has a named human and a written query | **Open** | `docs/launch-day-runbook.md`'s watch-rota section leaves "who is watching" as an intentionally blank line for the 2026-08-19 launch day, which has passed; there is no equivalent continuous rota for the current always-live state. Given current traffic is near-zero organic signups (no outreach has started — see H4), this is a real but low-severity gap today; it becomes higher-severity the moment Phase B outreach or Stripe go-live happens. |

### Verdict, as of 2026-08-25

**NO-GO on flipping Stripe live or starting Phase B outreach today**, on two independent
reds that each individually block per this sheet's own "any red = NO-GO" rule for their
category:
- **S5 — credential rotation is still zero-done.** Every one of the 5 flagged credentials
  (Cloudflare token first) is still exactly as exposed as it was on 2026-08-04. Rotating
  is a director-console action; nothing here is agent-blockable.
- **H4 — no real payment can be collected today by construction.** The Payment Link is
  hard-locked to Stripe test mode. Starting organic outreach before this is fixed would
  send real prospective customers to a page that cannot take their money — the exact
  failure mode `relay-gtm-readiness-audit-2026-08-21.md` §3.3 already named.

**What is genuinely ready, not blocking:** the technical pipeline itself (S4, S6, F1, F6
all green, S7 green-with-a-recommended-re-run), the honest pricing/positioning/legal
surface (H1-H3 green), and the core product mechanism (proven end to end in production
multiple times this session, most recently 2026-08-25). **The gate that remains is
entirely the two items above plus the amber test-coverage gaps (S1/S2 partial, F4/F7
open)** — none of which require new product engineering, only director console time
(S5, H4) and two small, well-scoped agent passes (S1/S2's missing tests, F7's production
runbook run via `docs/production-smoke-runbook.md`).

### The actual decision this sheet feeds — restated verbatim, not re-derived

Per `growth/product/design-panel/ceo-revenue-call-2026-08-19.md` §4 and
`relay-n8n-wedge-execution-plan-2026-08-21.md` §4:

> **90-day win** (by **2026-11-17**, 90 days from the 2026-08-19 ruling): the n8n
> community node is published and discoverable in n8n's own registry, and Relay has
> converted **3–5 paying customers acquired through that channel specifically** — found
> via the node, the community forum, or the registry, not previously-known contacts — at
> Hookdeck-comparable entry pricing (~$10–39/mo). On the order of **£50–£200 MRR** from
> this channel alone.
>
> **Double down** if, by day 90, the node has produced organic signups **and** at least
> one to two convert to paying without a sales call.
> **Abandon or deprioritise** if the node is live but produces zero organic signups, or
> signups occur but none convert.

**Judgment call this sheet surfaces, not resolves:** the 90-day clock as written runs from
the ruling date, but the channel is not genuinely testable until this sheet's two reds
(S5, H4) clear, the node actually publishes (RELAY-109, TODO — provenance workflow +
live-instance smoke test still needed before `npm publish`), and Phase B's first public
post goes out. As of 2026-08-25, **6 days into the nominal 90-day window, none of those
three things has happened yet** — the effective testing window inside the fixed clock is
shrinking by exactly the number of days this gate stays red. This plan does not recommend
moving the 2026-11-17 date (that would be a new decision this sheet is not positioned to
make); it records the gap plainly so a late close reads as informative, not as a surprise
at day 90.
