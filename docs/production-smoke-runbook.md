# Production smoke runbook — companion to `scripts/smoke-buffer.sh`

**RELAY-90.** This is the numbered, human-executed procedure for re-running
`scripts/smoke-buffer.sh` **unmodified** against the real production hosts
(`https://relay.coreframe-labs.dev`, `https://in.relay.coreframe-labs.dev`), with the
exact command and exact expected output at every one of the script's 10 internal steps.

**This file does not replace, duplicate, or overlap with `docs/launch-day-runbook.md`.**
That file (RELAY-85's deliverable, confirmed by its own attribution in
`growth/product/relay-dev-log.md`'s 2026-08-18 entry: *"`docs/deploy-runbook.md`,
`docs/rollback.md`, `docs/launch-day-runbook.md` also written"* under RELAY-85) is the
launch-**day** operational timeline — deploy the frozen SHA, open signups, run a 2-hourly
DLQ watch query, decide when to reach for the kill switch. Its §"09:30" step names the
overall smoke command and the script's own final summary line, but gives no per-step
expected output — it assumes the reader already knows what the script does internally.
This file is that missing companion: what a human unfamiliar with the script's internals
should see printed at **each** of its 10 steps, so a silent divergence (a step that
"passes" for the wrong reason, or a step whose output differs from what production is
supposed to produce) is catchable by inspection, not just by the final exit code.

Read `scripts/smoke-buffer.sh` top-to-bottom once before your first production run — every
step number, banner text, and expected-output string below is copied directly from that
file (cited by line number) as it exists on `main` at the time of writing, not
paraphrased. **This runbook does not modify the script in any way.**

---

## 0. Before you start

- **Do not run this against a fresh clean-slate expectation.** Production already has real
  history (a merged-and-verified n8n-wedge landing page, real prior test signups from this
  session's own verification work, all cleaned up afterward — see
  `relay-dev-log.md`'s 2026-08-21 "RELAY-39 flipped" entry). This run creates its own
  fresh throwaway account (`smoke-<timestamp>@smoke.coreframe-labs.dev`) and does not touch
  anyone else's data.
- **You need `SMOKE_DEST_AUTH`** — the production `RELAY_API_SECRET`. Get it from Vercel's
  production environment variables (`vercel env pull --environment=production` or the
  Vercel dashboard), never from a chat transcript or a committed file. This runbook does
  not print or require printing that value.
- **Known production caveat — read this before you decide whether to run step 10.** If
  `psql` is on your `PATH`, **do not run this smoke against production unless you have
  first confirmed you are prepared for step 10 to hard-crash the script**, not fail
  gracefully. `smoke-buffer.sh` only assigns the `DATABASE_URL_LINE` shell variable inside
  its **local**-mode branch (`scripts/smoke-buffer.sh:98`, guarded by the `if [ "$DEPLOY" =
  local ]` check at line 95). In remote/production mode that variable is never assigned.
  The script runs under `set -u` (line 51), and step 10 (`scripts/smoke-buffer.sh:330`,
  `339`) unconditionally references `"$DATABASE_URL_LINE"` whenever `psql` was detected on
  `PATH` at step 1 (`HAVE_PSQL=1`, line 85-87) — **regardless of deploy mode**. Verified
  directly (not assumed) by reproducing the exact failure shape in isolation:
  ```
  $ bash -c 'set -u; echo "$UNSET_VAR"'
  bash: line 1: UNSET_VAR: unbound variable
  ```
  So: if `psql` is installed on the machine you run this from, expect step 10 to abort the
  whole script with `smoke-buffer.sh: line 330: DATABASE_URL_LINE: unbound variable` and a
  **non-zero exit with no `SMOKE: PASS` summary printed at all** — even though steps 1–9
  will have already printed their own PASS lines above it. This is not a bug this runbook
  introduces or can fix (the AC forbids modifying the script); it is a real, reproducible
  property of the script as written, worth knowing before you conclude a crash means
  production is broken. **Practical options, in order of preference:**
  1. Run this from a machine/container/shell with no `psql` on `PATH` — step 1 will then
     correctly print `WARN psql NOT on PATH — step 10 will SKIP` and the script completes
     cleanly through the real `SMOKE: PASS` summary.
  2. If you must run from a machine with `psql` installed, temporarily shadow it for this
     one invocation: `PATH=$(echo "$PATH" | tr ':' '\n' | grep -v psql | paste -sd:) ./scripts/smoke-buffer.sh` is fragile — simpler is `env PATH=/usr/bin:/bin ./scripts/smoke-buffer.sh` if that strips the `psql`-containing directory, or rename/move `psql` out of `PATH` for the duration of the run.
  3. Accept the step-10 crash as expected and read steps 1–9's PASS lines as your evidence
     — they are the steps that actually exercise production (signup, route, ingest, DLQ,
     retry); step 10 is a **local-only** direct-DB rowcount cross-check that has no
     production-safe equivalent as the script is written (it would need production
     `DATABASE_URL` in scope, which the script's local-only guard at lines 89–109
     deliberately never assumes in remote mode).

---

## 1. Run the command

```bash
DASHBOARD_URL=https://relay.coreframe-labs.dev \
PROXY_URL=https://in.relay.coreframe-labs.dev \
SMOKE_DEST_AUTH=<the production RELAY_API_SECRET, from Vercel env, never pasted into chat> \
./scripts/smoke-buffer.sh
```

Run it from the repository root of a checkout of `main` (or whatever SHA is currently
deployed to production — the smoke tests what's *live*, so run it against a checkout that
matches, per `docs/launch-day-runbook.md`'s own "a green pre-deploy smoke is not evidence
about the deployed thing" principle).

---

## 2. Numbered checklist — expected output per step

Every `PASS`/`WARN`/`FAIL` line quoted below is the script's own literal output format
(`scripts/smoke-buffer.sh:60-64`'s `pass()`/`warn()`/`fail_step()` functions). Lines
containing a live value (email, route id, request id) will differ run to run — only the
**shape** and the **PASS/WARN/FAIL verdict** are the thing to check, not the exact string.

### STEP 1 — preflight (`smoke-buffer.sh:80-122`)

```
  PASS curl on PATH (...)
  PASS jq on PATH (...)
  PASS awk on PATH (...)
  PASS python3 on PATH (...)
  PASS node on PATH (...)
  PASS psql on PATH — step 10 will run the direct-DB proof
    -- OR --
  WARN psql NOT on PATH — step 10 will SKIP (API evidence in steps 5–9 already covers it)
  PASS deploy mode: remote (DASHBOARD_URL=https://relay.coreframe-labs.dev)
  PASS dashboard healthy — /api/health 200
  PASS proxy healthy — /health 200, configured.dashboard=...
  PASS API hot-path pre-compiled (join / csrf / session / qstash-test)
```

**Expected: `deploy mode: remote`** (line 89-93 of the script matches on
`http://localhost*`/`http://127.0.0.1*` for local mode — a `https://relay.coreframe-labs.dev`
URL falls through to `remote`). If this instead prints `deploy mode: local`, your
`DASHBOARD_URL` was not set correctly and you are about to smoke-test your own laptop, not
production — stop and re-check the env vars.

**If `SMOKE_DEST_AUTH` is unset**, step 1 fails immediately with `FAIL (step 1) remote mode
requires SMOKE_DEST_AUTH=<the env's RELAY_API_SECRET>` (line 108) — the script exits before
touching production at all in that case, which is by design.

### STEP 2 — signup (`smoke-buffer.sh:124-140`)

```
== STEP 2 — signup — POST /api/auth/join (throwaway account) ==
  PASS signup 201 — smoke-<timestamp>@smoke.coreframe-labs.dev created (a REAL local DB write: the account + team + membership now exist)
```

**Expected: `201`.** (The script's own comment says "local DB write" — that phrasing is
generic across local/remote; against production this is a real row in the production
database, cleaned up by nobody automatically — see §3 below.) A `400` with `already
exists` is also an accepted pass (idempotent re-run of the exact same timestamp-keyed
email, extremely unlikely in practice since `STAMP="$(date +%s)"` is second-resolution).

### STEP 3 — session + route (`smoke-buffer.sh:142-170`)

```
== STEP 3 — session + route — NextAuth credentials, POST …/relay/routes ==
  PASS signed in — POST callback/credentials 200; GET session .user.email=smoke-<ts>@smoke.coreframe-labs.dev
  PASS route created 201 — id=<uuid> slug=smoke-<ts>; data.relayUrl names the team 'smoke-<ts>' in its path (team+membership proven by the signup)
  PASS RELAY-59 destination auth set atomically at create — header names: authorization (values never returned, never logged)
```

**Expected: both `201`s and the session email match.** This is the step that proves a
real credentials-based session round trip works against production right now — the same
proof RELAY-42's dev-log entry (2026-08-25) already cites, exercised freshly here.

### STEP 4 — headerless webhook (`smoke-buffer.sh:172-191`)

```
== STEP 4 — headerless webhook — POST /in/:team/:route/:token, NO X-Relay-Key ==
  PASS headerless webhook -> 200 {"status":"queued"} requestId=smoke-real-<ts> — path token ALONE authenticated it
```

**Expected: `200 {"status":"queued"}` — this is the production-only branch.** Locally this
step takes a different, 502-based branch (line 186-188); against real production hosts the
script's own comment confirms **200 is the expected result** (line 187: *"in production the
same step returns 200"*). **A `502` here against the real production hosts is a genuine
regression, not the accepted local-posture substitution** — treat it as a FAIL-equivalent
finding even though the script's generic `fail_step` message (line 190) mentions the
502-locally case as one of two expected shapes; that message is written to cover both
deploy modes generically, but only the `200` branch is correct once `DEPLOY=remote`.

### STEP 5 — SAVE THE WEBHOOK (`smoke-buffer.sh:193-214`)

```
== STEP 5 — SAVE THE WEBHOOK — a real DeliveryLog row (isTest=false) for this route ==
  PASS SAVE THE WEBHOOK — DeliveryLog row requestId=<uuid> isTest=false status=DELIVERED attemptCount=1 responseCode=200 → the smoke-destination answered 200. This durable write is the RELAY-68 activation moment.
```

**Expected: `status=DELIVERED`, `isTest=false`, `responseCode=200`.** This is the literal
production-database proof this whole runbook exists to produce for G1 — a real row, keyed
on a printed `requestId`, in the production `DeliveryLog` table.

### STEP 6 — test webhook (`smoke-buffer.sh:216-232`)

```
== STEP 6 — test webhook — POST …/routes/<id>/test-send ==
  PASS test-send -> 200 requestId=<uuid> (RELAY-50 real-pipeline probe)
```

**Expected: `200`, driven through the real "Send test webhook" button endpoint** — unlike
local mode, production does not need the `x-relay-event=test` local-loopback substitution
(that branch exists only because local SSRF blocks the local catcher; production has no
such restriction).

### STEP 7 — isTest distinction (`smoke-buffer.sh:234-246`)

```
== STEP 7 — isTest distinction — one feed read separates real from test ==
  PASS isTest split — real=<uuid> isTest=false status=DELIVERED  vs  test=<uuid> isTest=true status=DELIVERED (RELAY-12's billing-exclusion field is real and readable)
```

**Expected: the real row's `isTest=false` and the test row's `isTest=true`, both visible
in the same `…/relay/log` feed read.**

### STEP 8 — DLQ (`smoke-buffer.sh:248-283`)

```
== STEP 8 — DLQ — envelope at ?mode=500, maxRetries=1 → final attempt → dead-letter ==
  PASS DLQ first attempt — 502 retrying, exactly the consumer's retry signal
  PASS DLQ leg — final attempt answered 200 with the envelope delivered to ?mode=500 (responseCode 500 recorded), DLQ write coming
  PASS DLQ row present — DlqItem id=<uuid>, DeliveryLog status=DLQ responseCode=500
```

**Expected: exactly this three-line shape** — a 502 on the first (retryable) attempt, a
200 on the deliberately-final attempt (the consumer's own contract: the retry budget is
spent, so it reports success-at-handling even though the destination itself returned 500),
and a `DlqItem` row that actually exists when queried back.

### STEP 9 — DLQ retry (`smoke-buffer.sh:285-323`)

```
== STEP 9 — DLQ retry — re-point route at ?mode=200, POST …/dlq/:id/retry ==
  PASS retry queued — POST …/dlq/:id/retry -> 202 requestId=<uuid>
  PASS redelivered — SAME requestId=<uuid> now DELIVERED attemptCount=2 (unique-requestId update; no duplicate)
  PASS no second DLQ entry — exactly 1 item for <uuid> after the retry (dedupe on requestId)
```

**Expected: `202` (unconditional in production — script comment, line 298: *"In production
this step UNCONDITIONALLY returns 202"*), then the SAME row transitioning to `DELIVERED`
with `attemptCount ≥ 2`.** This is the one step where the **local** run's accepted-pass
shape (a `502 QStash refused`) is explicitly **not** a valid production outcome — if you
see `502` here against the real production hosts, that is a regression to investigate, not
an expected local-posture branch. The script's own conditional (line 299) only takes that
branch on a specific `502` + `'QStash refused'` body match, which should not occur once
QStash has a real public callback URL to reach (`https://in.relay.coreframe-labs.dev`), so
seeing it in a production run is itself the signal something is wrong.

### STEP 10 — direct-DB proof (`smoke-buffer.sh:325-344`)

**See §0's caveat above before you get here.** Two valid outcomes:

```
  WARN psql absent — skipping direct SQL (steps 5–9 already prove the rows via API)
```
— the clean, expected outcome when `psql` was not on `PATH` at step 1 — the script prints
its final `SMOKE: PASS` summary immediately after this line, or:

```
smoke-buffer.sh: line 330: DATABASE_URL_LINE: unbound variable
```
— an unhandled bash crash (no `FAIL (step 10) ...` line, no `SMOKE: PASS` summary, script
exits) if `psql` **was** detected on `PATH` at step 1. This is the known caveat from §0 —
not a sign production itself is broken; re-run from an environment without `psql` on
`PATH` to get a clean pass-through instead, or read steps 1–9's already-printed PASS lines
as sufficient production evidence on their own (which is what they are).

### Final summary (only reached if step 10 didn't crash per the caveat above)

```
==============================================
SMOKE: PASS  (N assertions, M warnings)
  account : smoke-<ts>@smoke.coreframe-labs.dev
  team    : smoke-<ts>
  route   : <uuid> (smoke-<ts>)
  save    : isTest=false status=DELIVERED
  test    : isTest=true present
  dlq     : <uuid> -> DLQ -> retry -> DELIVERED (attemptCount=2)
==============================================
```

**Expected `N` against production:** locally the script measures 23 assertions / 7
warnings (`relay-dev-log.md`'s 2026-08-11 entry, "RELAY-66 smoke test built and passing
locally"); against production, several of the local-posture `WARN` lines do not fire
(steps 4 and 9 take their clean 200/202 branches instead of the local 502 substitutions),
so the production count is expected to be **higher on PASS, lower on WARN** than the
local baseline — the exact number was not measured this session (no production run was
executed as part of writing this runbook; see the note at the end of this file), so state
what you actually observe rather than expecting a specific number to match.

---

## 3. After the run — clean up the throwaway account

The script does not delete what it creates (by design — deleting rows via raw SQL against
production `DATABASE_URL` is exactly the kind of hard constraint this workspace's launch
docs treat as director-only). After a production run:

```sql
-- Run via the Supabase MCP or the setup console, not a raw psql session with production
-- DATABASE_URL, per this workspace's credential-handling rules.
select id, email from "User" where email like 'smoke-%@smoke.coreframe-labs.dev';
-- then delete the throwaway User/Team/TeamMember/Route/DeliveryLog/DlqItem rows for that
-- id, in FK-safe order (children before parents), the same pattern
-- `relay-dev-log.md`'s 2026-08-21 "RELAY-39 flipped" entry already used for its own
-- verification accounts: "Test users/teams/routes from verification deleted afterward via
-- direct SQL — production left clean, nothing left behind."
```

---

## 4. Does not modify `scripts/smoke-buffer.sh`

Confirmed directly: this runbook is a new, separate file
(`coreframe-relay/docs/production-smoke-runbook.md`) written on branch
`relay/relay-90-91-docs`. `scripts/smoke-buffer.sh` itself was read in full to write the
step-by-step detail above but was not opened with a write tool and carries no diff in this
branch — `git diff main -- scripts/smoke-buffer.sh` on this branch is empty by
construction, satisfying this ticket's second acceptance criterion directly.

---

## A note on what this session did and did not do

This runbook was written by reading `scripts/smoke-buffer.sh` in full and cross-checking
every line-numbered claim above against the actual file on `main`. **It was not produced
by executing the script against production this session** — writing an accurate runbook
does not require a live run, and this session's own dev log
(`relay-dev-log.md`, 2026-08-25 "RELAY-42's sign-in AC closed retroactively" entry) records
that Vercel's bot-protection is currently challenging this session's testing IP after
repeated automated hits earlier the same day, so a fresh scripted run right now would risk
a false FAIL from the bot challenge rather than a true reading of the pipeline. Separately,
and unprompted by this ticket, this same session's 2026-08-21 dev-log entry ("RELAY-43
fixed") already proved the mechanism this script exercises works end to end in production
by hand — a real signup, a real route, a real webhook POSTed to the public
`in.relay.coreframe-labs.dev` ingest URL, a real `200 {"status":"queued"}` with a genuine
QStash `messageId`, and a real `DeliveryLog` row confirmed by a direct Supabase query
against the production database. That is evidence the underlying pipeline works, cited
here for context — it is not a substitute for someone actually running this runbook's
numbered steps in one sitting, which is what G1 and this document's own AC still ask for.
