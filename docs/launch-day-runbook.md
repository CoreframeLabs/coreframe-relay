# Launch-Day Runbook — 2026-08-19 (D8)

Written 2026-08-18 (D7) per `relay-launch-sprint.md` D7 action item #5: *"Write the
launch-day runbook: what happens at 09:00, who is watching, what triggers the kill
switch."* The schedule below is copied verbatim from `growth/product/relay-launch-sprint.md`
§1 "D8 — Wed 2026-08-19 — Launch" — this doc does not redefine the timeline, it operationalizes
it against the actual scripts and workflows in this branch.

**This is not a GO declaration.** It is the procedure to follow *if* D7's hard gate (§5 of
the sprint plan) passes. See this task's final report for the current, measured state of
O1/O2/O3/F1 — several are not yet green as of this writing.

## 09:00 — Deploy the frozen SHA. Nothing else.

The SHA was frozen at D7's 16:00 merge freeze (`relay-launch-sprint.md` D7 action #4).
Deploying it means merging *that exact commit* — not `main`, not whatever `release` has
drifted to since — into `release`:

```bash
git fetch origin
git log --oneline -1 <frozen-sha>          # confirm this is the SHA named in the D7 record
git checkout release && git pull origin release
git merge --no-ff <frozen-sha>
git push origin release
```

This push is what fires `deploy.yml` (see `docs/deploy-runbook.md` §2–§3 for the full job
sequence: `wait-for-ci` → `gate` → `deploy-worker` → `verify`). **Do not run
`workflow_dispatch` against a different SHA as a shortcut** — `wait-for-ci` exists
specifically to confirm CI is green on the SHA actually being deployed, not assumed from
an earlier run.

**Nothing else at 09:00.** No opportunistic fixes, no "while I'm in there" changes. If
`deploy.yml` fails at any job, stop and diagnose — do not push a second, different commit
to `release` to try to fix it forward; that silently un-freezes the SHA the gate was run
against.

## 09:30 — Re-run the production smoke against the deployed artefact

> "A green pre-deploy smoke is not evidence about the deployed thing." — `relay-launch-sprint.md` D8

```bash
DASHBOARD_URL=https://relay.coreframe-labs.dev \
PROXY_URL=https://in.relay.coreframe-labs.dev \
SMOKE_DEST_AUTH=<production RELAY_API_SECRET> \
./scripts/smoke-buffer.sh
```

Also run the narrower deploy check, which is faster and catches the specific F1/F5
regressions this branch's own testing surfaced (see `docs/deploy-runbook.md` §6):

```bash
bash apps/dashboard/scripts/verify-deploy.sh
```

**Expected: `SMOKE: PASS (N assertions, ≤ some warnings)`** from `smoke-buffer.sh`, and
`VERIFY: PASS -- all 4 checks green` from `verify-deploy.sh`. Any FAIL on either is a
NO-GO on 10:00 — do not open signups against a smoke that just failed. Roll back per
`docs/rollback.md` and re-run this step before proceeding.

## 10:00 — Open signups behind the Founding Access cap

Director action (RELAY-88's cap mechanism — invite codes or admin toggle, per
`relay-launch-sprint.md` D2 decision #4). Not scripted in this branch; this file only
marks the timing dependency: **do not open signups before 09:30's smoke is confirmed
green.**

## 10:00→ — Watch rota begins

**Cadence** (from `relay-launch-sprint.md` D6/D8): every 2 hours for the first 12 hours
(i.e. through ~22:00), then 3×/day after that, for 72 hours total (RELAY-93).

**Who is watching:** ***[director to name here before 09:00 — this line is intentionally
blank.]*** `relay-launch-sprint.md` gate condition O4 requires "a named human and a
written query" — this document supplies the query (below); the name is a same-day
operational decision this branch cannot make on the director's behalf, and inventing a
name would misrepresent who is actually on call.

**What "watching" means, concretely** — there is no automated alerting for this
(`docs/observability.md` §3: RELAY-44's rolling-window DLQ/failure-ratio check is
explicitly not implemented; "today the only reader of DLQ growth is a human running the
smoke test or querying the DLQ page"). Run this query by hand, every 2h for the first 12h:

```bash
docker run --rm postgres:16 psql "$DATABASE_URL" -t -A -F'|' -c "
select
  count(*) filter (where status = 'DLQ') as dlq_last_2h,
  count(*) filter (where status = 'FAILED' and \"isTest\" = false) as failed_last_2h,
  count(*) filter (where \"isTest\" = false) as total_last_2h
from \"DeliveryLog\"
where \"createdAt\" > now() - interval '2 hours';
"
```

(Same `docker run postgres:16 psql` pattern `apps/dashboard/scripts/verify-rls.sh` already
uses, so no local `psql` install is needed — RELAY-62: no new dependency.)

**Read it as:**
- `dlq_last_2h` climbing steadily rather than staying near zero → destinations are
  failing systematically (bad DNS, a common bug in the forward path) — investigate before
  it compounds.
- `failed_last_2h` / `total_last_2h` (a rough failure ratio) trending up across
  consecutive checks → same signal, earlier warning than the DLQ number alone since
  `FAILED` rows haven't necessarily exhausted retries yet.
- `total_last_2h` at or near zero for the whole first window → **not necessarily healthy**
  — it may mean nobody has signed up yet, or it may mean the ingest path is silently
  dropping traffic before it reaches `DeliveryLog` at all (`docs/observability.md` §1's
  "the proxy answers 200 while the queue consumer never runs" failure mode). Cross-check
  against `wrangler tail --format pretty | grep proxy.ingest.queued` in `apps/proxy` to
  see whether anything is being accepted at the edge at all.

## What triggers the kill switch

Not every red number above is a kill-switch event — most are "investigate now." Reach for
`apps/dashboard/scripts/kill-switch.sh block` (see `docs/rollback.md` §3 for the command
and what it actually does) when **any** of the following is true:

1. **A security incident** — a credential appears to be compromised, an SSRF or
   cross-tenant isolation bypass is suspected live (the exact class of bug S1–S8 in
   `relay-launch-sprint.md` §5 gate the launch on), or `wrangler tail` shows requests that
   look like an attack rather than normal traffic.
2. **Sustained, compounding DLQ growth** with no known cause — the watch query above
   showing `dlq_last_2h` rising across two or more consecutive 2-hourly checks, and a
   first look at `wrangler tail` / the DLQ page does not explain it (e.g. it is not one
   customer's misconfigured destination).
3. **A confirmed data-integrity or cross-tenant leak** — any evidence a team saw another
   team's data. Zero tolerance; block first, investigate after. This is the failure mode
   G2a's whole design (`relay-launch-sprint.md` D4) exists to prevent, and if it happens
   anyway the kill switch is the only response fast enough to matter.
4. **The Worker itself is erroring at volume** — `wrangler tail | grep unhandled_error`
   showing repeated crashes, not isolated one-offs, and a rollback (`docs/rollback.md` §1)
   is not immediately available or has already been tried and did not help.

**What does NOT trigger it** — a single destination's connectivity issue (that customer's
problem, visible as isolated DLQ entries for one `routeId`), a slow but not failing
delivery, or one anomalous data point without a second confirming check. The kill switch
stops **all** inbound traffic for **every** customer; using it for a single-tenant issue
is a worse outage than the one being contained.

**After blocking:** note the time (`kill-switch.sh block`'s own output prints the API call
duration; log the wall-clock time you ran it separately, since that is the number gate
condition O3 actually asks for — see `docs/rollback.md` §3's status caveat: this has not
yet been drilled, so there is no prior timing to compare against). Fix or roll back in
parallel. Restore with `kill-switch.sh restore` once resolved, and verify with:

```bash
curl -s https://in.relay.coreframe-labs.dev/health
```

## 17:00 — Day-1 write-up

What broke, what was measured, what the watch queries said across the day's checks.
Written to `growth/product/relay-dev-log.md` per this project's tracker convention (every
session's own first-and-last action, per `relay-launch-sprint.md` §6's dispatch rules) —
not to this file, which is a static procedure, not a log.

## Reminder: G3 is separate

`relay-launch-sprint.md` D8: **"G3 (outreach go) is a separate decision and is not
automatic on launch. Launching and telling people are two acts; keep them apart by at
least 48 hours of watch data."** Nothing in this runbook authorizes outreach — that is a
distinct, later decision.
