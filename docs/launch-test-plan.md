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
