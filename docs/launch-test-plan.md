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
