# Rollback (RELAY-45)

Three components, three different rollback shapes, none of them equally fast. Read this
before an incident, not during one — the whole point of RELAY-45 is that "the first time
you run the procedure" should not also be "during the incident."

**Status of the drill this doc's own acceptance criteria require, stated plainly:**
`growth/product/relay-sprint-plan.md`'s `[RELAY-45]` entry is `Status: TODO`, all four
acceptance boxes unticked, as of this branch. **No rollback has been drilled against
staging or production from this environment or recorded in `growth/product/relay-dev-log.md`.**
Every command below was checked for syntax (`wrangler rollback --help`,
`wrangler deployments list --help`, both run against the pinned `wrangler ^3.99.0` in
`apps/proxy/package.json` and reproduced verbatim below) and is believed correct, but
**"correct syntax" is not the same claim as "drilled and timed."** §4 states exactly what
running the real drill would take.

## 1. Worker rollback — the fast, real one

The Worker has no queue in front of it (`apps/proxy` is the ingest edge itself). If it
500s, the only retry is whatever the customer's sender happens to implement, which we do
not control — this is the component where rollback speed matters most.

```bash
cd apps/proxy

# 1. See the 10 most recent deployments for the target environment.
pnpm exec wrangler deployments list --env production

# 2. Roll back to a specific version id from that list (recommended — explicit,
#    auditable, and matches what a drill would time).
pnpm exec wrangler rollback <version-id> --env production --message "rollback: <reason>"

# Confirmed CLI syntax (wrangler 3.99.x, run from this repo, 2026-08-18):
#   wrangler rollback [version-id]
#   -e, --env      Environment to use for operations
#   -m, --message  The reason for this rollback
#   -y, --yes      Automatically accept defaults to prompts
```

**Verify the rollback landed** — never trust the CLI's exit code alone, same discipline as
`verify-rls.sh`:

```bash
bash apps/dashboard/scripts/verify-deploy.sh
```

Passing means the Worker's `/health` body is back to `service: "coreframe-relay-proxy"`
with a `relay-request-id` header — i.e., *a* Worker is live and answering in our shape.
It does not by itself prove *which* version; cross-check `wrangler deployments list`
shows the target version-id as current.

**Expected time-to-recover: not yet a recorded number.** `deploy.yml`'s comment on the
`deploy-worker` job and this doc both describe the mechanism; neither is a substitute for
the actual drilled, timed run RELAY-45 requires. §4 names what that run needs.

## 2. Dashboard rollback — slower, and not controllable from this repo

Vercel keeps every deployment; rolling back means **promoting a previous one to
production**, which is a Vercel-side action:

- **Via the Vercel dashboard** (works without any token, director-only):
  Project → Deployments → find the last-known-good deployment → "..." menu →
  **Promote to Production**.
- **Via CLI**, if a `VERCEL_TOKEN` is ever added to this environment:
  ```bash
  vercel rollback <deployment-url-or-id> --token=$VERCEL_TOKEN
  ```
  **Not available in this sandbox** — no Vercel token exists here, so this line is
  documented from Vercel's published CLI contract, not executed. Treat it as unverified
  until run once for real.

Because `docs/deploy-runbook.md` §0.5/§0.6 gate deploys to the `release` branch, a bad
dashboard deploy should be rare by construction — but "rare" is not "impossible," and this
is the one rollback path this repo cannot script end-to-end without a credential it does
not have.

## 3. The fastest containment option is not a rollback — it's the kill switch

If the question is "how do I stop it *right now*" rather than "how do I get the last-good
version back," `apps/dashboard/scripts/kill-switch.sh` is faster than either rollback
above: it unbinds the Cloudflare Workers Custom Domain in front of
`in.relay.coreframe-labs.dev`, which stops traffic in seconds without a deploy or a
version selection. It is not a fix — nothing about the bad version is repaired — it is a
bleed-stop while a real rollback or fix is prepared. See `docs/launch-day-runbook.md` for
exactly when to reach for it over a rollback, and the kill switch script's own header
comment for the full reasoning.

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... apps/dashboard/scripts/kill-switch.sh block
# ... fix or roll back in parallel ...
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... apps/dashboard/scripts/kill-switch.sh restore
```

**Same status caveat as the Worker rollback above: this script has not been run against a
real Cloudflare account from this sandbox** — no `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` exist here. Its logic was reasoned from Cloudflare's documented
Workers Custom Domains API, and it fails loudly (checks `success:true` on every response,
never infers "already blocked" from an ambiguous error) rather than silently — but "fails
loudly if wrong" is not the same claim as "measured against a real account."

## 4. The migration rollback — the slow case, and the one to avoid needing

There is no `prisma migrate rollback` — Prisma has no down-migration primitive.
Reversing a schema change means **hand-writing the reverse SQL** and running it the same
way `migrate.yml` runs forward migrations: `workflow_dispatch`, staging first, confirmed
by name.

```bash
# Hand-write the reverse migration under supabase/migrations/ or
# apps/dashboard/prisma/migrations/ (whichever system owns the change being reversed —
# see docs/deploy-runbook.md §4 for why there are two).
# Then run it the same way any forward migration runs:
gh workflow run migrate.yml -f target=staging -f confirm=staging
# staging green, then:
gh workflow run migrate.yml -f target=production -f confirm=production
```

**Expected time: 10–15+ minutes minimum**, and slower under real load — this is a hand
process, not a one-command revert. **This is why RELAY-41's additive-only migration
policy exists**: every migration on this project is written to be additive (new nullable
columns, new tables, no destructive `DROP`/`ALTER…NOT NULL` on existing data) specifically
so that this slow path is rarely the one actually needed. If a bad deploy is schema-driven,
the first question is whether the *previous* application code still works against the
*new* schema (in which case a Worker/dashboard rollback alone fixes it, no migration
rollback needed) before reaching for a hand-written reverse migration at all.

## 5. What a real drill still requires, named plainly

To close RELAY-45's four acceptance boxes for real (not just have this doc describe how):

1. A deliberate bad deploy to **staging** (Worker), rolled back via §1, timed with a
   stopwatch, result written to `growth/product/relay-dev-log.md`.
2. Same for the dashboard (§2) — cheaper, can wait per the sprint plan's own D3 note.
3. Both need real Cloudflare/Vercel credentials this sandbox does not have. The director
   action is: run the drill by hand (or hand a scoped, time-boxed credential to an agent
   in a throwaway staging-only context) and record the two numbers.

Until that happens, gate condition **O2 is not satisfiable** — see the PASS/FAIL table in
this task's final report for the exact reasoning.
