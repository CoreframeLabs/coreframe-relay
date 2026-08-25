# Deploy Runbook (RELAY-85)

The numbered sequence `.github/workflows/deploy.yml` and `.github/workflows/migrate.yml`
automate the tail end of. Written against the actual files in this branch
(`relay/release-pipeline`) on 2026-08-18 — every command below is either a real script in
this repo or a documented Vercel/Cloudflare/GitHub API contract, never an invented one.
Where something could not be executed from this sandbox (no Vercel token, no Cloudflare
token with the right scope, no GitHub Environments configured yet), that is stated next to
the step, not glossed over.

## 0. One-time repo Settings — director only, done once, before any of this works

None of steps 1–7 below function until these exist. They are dashboard actions, not files,
so this repo cannot express them.

| # | Where | Action |
|---|---|---|
| 0.1 | GitHub → Settings → Environments | Create environment **`production`**. Attach **Required reviewers** (the director, at minimum). This is what makes `deploy.yml`'s `gate` job a real approval gate instead of a label — see the comment above the `gate:` job in `deploy.yml`. |
| 0.2 | GitHub → Settings → Environments | Create environment **`staging`**. No required reviewers needed (non-production). |
| 0.3 | GitHub → Settings → Environments → `production` → Secrets | Add `CLOUDFLARE_API_TOKEN` and `DATABASE_MIGRATION_URL` (production DB, DDL-capable role — **not** `RELAY_APP_DATABASE_URL`, see §7). |
| 0.4 | GitHub → Settings → Environments → `staging` → Secrets | Add `DATABASE_MIGRATION_URL` (staging DB). |
| 0.5 | Vercel → Project Settings → Git → Production Branch | Change from `main` to `release`. **This is the primary O1 control** — see §8. |
| 0.6 | Vercel → Project Settings → Git → Ignored Build Step | Paste exactly: `bash apps/dashboard/scripts/vercel-ignore-build-step.sh`. This is the secondary, code-reviewable O1 control — belt-and-suspenders with 0.5, same reasoning as RLS's two-layer design (`docs/rls.md`). |

**Verification status of 0.1–0.6, stated plainly:** none of these six could be checked from
this environment. No GitHub Environments API scope, no Vercel token, and no console access
exist in this sandbox. §8 restates this against the specific gate condition it blocks (O1).

## 1. Cut the `release` branch (one-time, or after a rebase-worthy drift)

```bash
git fetch origin
git checkout -b release origin/main
git push -u origin release
```

**Verification status, checked from this branch just now:**

```bash
$ git branch -a
* main
  relay/landing-launch
  relay/launch-tests
  relay/release-pipeline
  relay/rls-wrap
  relay/sec-criticals
  remotes/origin/HEAD -> origin/main
  remotes/origin/main
$ git ls-remote --heads origin release
(no output)
```

**The `release` branch does not exist yet, locally or on origin, as of this branch's last
`git fetch`.** Until it does, `deploy.yml`'s `on: push: branches: [release]` trigger cannot
fire from a normal merge, and 0.5 above (Vercel production branch) has nothing to point at
even if the setting is changed. Creating it is a **director action**, not this script's —
§6 of `relay-launch-sprint.md` reserves "only the director merges to `release`."

## 2. Normal release flow, once 0 and 1 are done

```bash
# 1. Land your PR against `release` (never main) after review.
git checkout release
git pull origin release
git merge --no-ff <your-branch>
git push origin release
```

Pushing to `release` fires two independent listeners on the same event (see `deploy.yml`'s
header comment for why they cannot be made to wait on each other):

- **Vercel's Git integration** deploys the dashboard immediately if 0.5 is set.
- **`deploy.yml`** runs `wait-for-ci` → `gate` (blocks on the `production` environment's
  required reviewers) → `deploy-worker` → `verify`.

## 3. Watch the deploy run

```bash
gh run watch --repo <org>/<repo> $(gh run list --workflow=deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Expected job order and what each one proves:

| Job | Proves | Typical duration |
|---|---|---|
| `wait-for-ci` | `CI required checks` (the job name in `.github/workflows/ci.yml`) is green **on this exact SHA**, polled directly from GitHub's check-runs API — not assumed from a stale run. | seconds–20 min (polls every 30s, 40 attempts) |
| `gate` | A required reviewer clicked Approve on the `production` environment. **Does nothing until 0.1 is done.** | however long the reviewer takes |
| `deploy-worker` | `pnpm exec wrangler deploy --env production` succeeded in `apps/proxy`, using the pinned `wrangler` (`^3.99.0`, `apps/proxy/package.json`) — never a bare `npx wrangler`, which can resolve wrangler 4.x (installed and unverified against this repo, RELAY-20/21). | ~30–90s |
| `verify` | `apps/dashboard/scripts/verify-deploy.sh` passes all 4 checks against the **deployed** artefact. | up to 60s wait + up to 3 min retry budget per check |

If `deploy-worker` fails at "Refuse to deploy with no Cloudflare credential", that is
`0.3` not done, or the token still cannot list Workers (API error 10000, per
`growth/product/relay-launch-decisions.md` decision 9) and needs rotation first with
`Zone:DNS:Edit` + `Workers Scripts:Edit` scope.

## 4. Migrations — always before the code that needs them, always staging first

`migrate.yml` is `workflow_dispatch`-only, deliberately: a production schema change is a
human decision, never a side effect of a merge.

```bash
# Staging first, always.
gh workflow run migrate.yml -f target=staging -f confirm=staging

# Watch it, then check the job summary for the RLS verify-rls.sh output.
gh run watch --repo <org>/<repo> $(gh run list --workflow=migrate.yml --limit 1 --json databaseId --jq '.[0].databaseId')

# Only after staging is green:
gh workflow run migrate.yml -f target=production -f confirm=production
```

The `confirm` input must exactly match `target` — a typo (`target=production`,
`confirm=staging`) makes the `guard` job refuse the run rather than migrate the wrong
thing quietly.

**[RELAY-41 AC5]** `target=production` now ALWAYS re-runs staging first, in the same
dispatch — the `migrate-production` job has `needs: [guard, migrate-staging]`, so it is
structurally impossible to reach production without staging having just succeeded. The
two-command sequence above still works exactly as shown, but it's no longer just advice:
running `target=production` alone (skipping the first command) still runs staging first
automatically, and a failed staging run blocks production even if you dispatch
`target=production` directly.

**What the job actually does, three steps, only the third is proof:**

1. `pnpm exec prisma migrate deploy` (`apps/dashboard`) — the Prisma-tracked schema only.
2. `pnpm exec supabase db push --db-url "$DATABASE_URL"` — the RLS migration
   (`supabase/migrations/`), **as its own step**, because `prisma migrate deploy`
   provably does not carry `FORCE ROW LEVEL SECURITY` / `CREATE POLICY` statements —
   reproduced independently on staging and production per `docs/rls.md`.
3. `apps/dashboard/scripts/verify-rls.sh "$DATABASE_URL"` — a direct query. **A green
   step 1 or step 2 is not evidence RLS is live; only this query is.** Exit 0 = all six
   tables `enabled AND forced` with ≥1 policy, and `relay_app` is `rolcanlogin=t
   rolbypassrls=f rolsuper=f`. Exit 1 prints exactly which check failed and refuses to
   let the job report success.

`verify-rls.sh`'s query shape was validated 2026-08-14 against the local Supabase stack
(`127.0.0.1:54322`, Postgres 17.6) with both migrations applied — see the script's own
header for the exact output. **It has not been run against staging or production** — no
credential for either exists in this sandbox. That run is the one thing this doc cannot do
for you; it is exactly what step 4 above triggers once `0.3`/`0.4` are set.

## 5. Kill switch — not part of the normal flow, launch-day containment only

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... apps/dashboard/scripts/kill-switch.sh status
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... apps/dashboard/scripts/kill-switch.sh block
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... apps/dashboard/scripts/kill-switch.sh restore
```

See `docs/rollback.md` §3 and `docs/launch-day-runbook.md` for when to reach for this
instead of a rollback. Full reasoning is in the script's own header comment.

## 6. Manual post-deploy verification (the same check `deploy.yml`'s `verify` job runs)

```bash
DASHBOARD_URL=https://relay.coreframe-labs.dev \
PROXY_URL=https://in.relay.coreframe-labs.dev \
bash apps/dashboard/scripts/verify-deploy.sh
```

**Run against production just now (2026-08-18), for real, from this sandbox** — this
needs no credential, only network access to public hostnames:

```bash
$ VERIFY_RETRIES=1 VERIFY_SLEEP_SECS=1 bash apps/dashboard/scripts/verify-deploy.sh
== Post-deploy verification (4 checks, 2 hosts) ==
DASHBOARD_URL=https://relay.coreframe-labs.dev
PROXY_URL=https://in.relay.coreframe-labs.dev
retry budget: 1 attempts x 1s = 1s per check

-- F1: Worker /health body shape --
  FAIL  proxy /health body contains service:coreframe-relay-proxy did not pass within 1s

-- F1: Worker /health carries relay-request-id header --
  FAIL  proxy /health relay-request-id header present did not pass within 1s

-- Dashboard /api/health --
  FAIL  dashboard /api/health returns 200 did not pass within 1s

-- Dashboard /api/auth/csrf (RELAY-86) --
  FAIL  dashboard /api/auth/csrf returns 200 did not pass within 1s

VERIFY: FAIL -- see failures above. Do NOT record this deploy as verified.
```

Raw evidence behind each of those four lines, run directly:

```bash
$ curl -sS https://in.relay.coreframe-labs.dev/health
Hello world
$ curl -sSI https://in.relay.coreframe-labs.dev/health | grep -i '^server:'
server: cloudflare
$ curl -sS -o /dev/null -w '%{http_code}\n' https://relay.coreframe-labs.dev/api/health
503
$ curl -sS -o /dev/null -w '%{http_code}\n' https://relay.coreframe-labs.dev/api/auth/csrf
500
```

`in.relay.coreframe-labs.dev` is still answering with Cloudflare's default placeholder
Worker (plain-text `Hello world`, `server: cloudflare`, no `relay-request-id` header, no
JSON) — not `apps/proxy/src/routes/health.ts`. This is gate condition **F1, currently
RED**, observed directly, not inferred. §8 restates this against the gate table.

## 7. Environment / secret inventory, as actually read by the code in this branch

| Name | Held by | Read by | Notes |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret, `production` environment | `deploy.yml` → `wrangler deploy` | Current token cannot list Workers (API error 10000). Must be rotated with `Zone:DNS:Edit` + `Workers Scripts:Edit` before `deploy-worker` can run at all. |
| `DATABASE_MIGRATION_URL` | GitHub Actions secret, per-environment (`staging`/`production`) | `migrate.yml`, exported as `DATABASE_URL` for the job's duration only | **DDL-capable role.** Deliberately not the same value as `RELAY_APP_DATABASE_URL` (RELAY-41) — see `migrate.yml`'s own comment. |
| `RELAY_API_SECRET` | `wrangler secret put` (Worker) + Vercel env (dashboard) | `apps/proxy/src/types/bindings.ts`, dashboard | Shared secret authenticating proxy↔dashboard route lookups. |
| `UPSTASH_QSTASH_URL` / `UPSTASH_QSTASH_TOKEN` / `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | `wrangler secret put` + Vercel env | proxy + dashboard consumer | Rotation status: per D1 of `relay-launch-sprint.md`, director action — not verifiable from this sandbox. |
| `RELAY_APP_DATABASE_URL` | Vercel env (production), `.env` (local) | dashboard Prisma client once G2a flips | Non-bypass role (`rolbypassrls=f`). **Not** the migration credential — see RELAY-41. |
| `RELAY_DESTINATION_HEADERS_KEY` | Vercel env | `lib/relay/destinationAuth.ts` | AES-256-GCM key for encrypted destination auth headers (RELAY-59). No default; absence fails loudly rather than silently. |

**`docs/credential-rotation.md`, referenced by `deploy.yml`'s Cloudflare-token guard step,
does not exist in this repo as of this branch.** Writing it is RELAY-46's scope (the
director's secret inventory, D1 action #4 in `relay-launch-sprint.md`), not this lane's
(`relay/release-pipeline`, L4 DevOps). Flagged here rather than silently left as a dead
link.

## 8. What this runbook could not verify, and why — read before trusting any GO decision

Every item below needs a credential or console access this sandbox does not have. Each
line names the exact director action that would close it.

| Gap | What's missing | Director action needed |
|---|---|---|
| Whether 0.1–0.6 (GitHub Environments, Vercel settings) are actually configured | Console access | Check each setting by hand against §0's table |
| Whether `CLOUDFLARE_API_TOKEN` has been rotated with the correct scope | Cloudflare console/API access | Rotate per `relay-launch-decisions.md` decision 9, add as the `production` environment secret |
| Whether `DATABASE_MIGRATION_URL` is set for either environment | GitHub Settings access | Add per §0.3/0.4 |
| Whether the Worker has ever been deployed for real | Cloudflare credential | Run §3 once 0 and 1 are satisfied; §6's raw `curl` output above is current, direct proof it has not been, as of 2026-08-18 |
| Whether the dashboard is serving from `release` or still `main` | Vercel console access | Check Vercel → Deployments → which branch produced the current production alias |

This is the honest floor: **this runbook, the workflows, and the scripts are complete and
internally consistent, but nothing in this list has been executed against a live account
from this environment.** Treat every "PASS" claim elsewhere in this branch's docs as
"the mechanism is correct and ready to run," never as "this has already happened."
