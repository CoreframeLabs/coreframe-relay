# CI Pipeline (RELAY-10)

Workflow file: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)

This document says three things plainly: what gates a merge, what secrets you
need to configure before the pipeline goes green, and — because I cannot run
GitHub Actions from this sandbox — exactly which parts of this were verified by
actually running the command locally versus reasoned about from reading config
and public documentation.

## What actually exists in this repo (verified, not assumed)

Before writing the workflow I read `package.json` in the repo root,
`apps/dashboard`, `apps/proxy`, and `packages/types`, and ran the real scripts
locally. Findings that shaped the design:

| Script | Where it's real | Where it's missing |
|---|---|---|
| `lint` | **Nowhere.** Root `package.json` has `"lint": "turbo run lint"`, but no workspace defines a task called `lint`. `turbo run lint` completes with 0 tasks run — a silent, always-green no-op. | — |
| `check-lint` | `apps/dashboard` only (`eslint -c eslint.config.cjs ./`) | `apps/proxy`, `packages/types` have no eslint config at all |
| `check-types` | `apps/dashboard`, `apps/proxy`, `packages/types` — and it **is** wired correctly into `turbo.json` and the root `check-types` script | — |
| `test` | `apps/dashboard` (Jest, 1 suite / 4 tests) and `apps/proxy` (Vitest, 2 files / 33 tests) — both wired correctly into root `pnpm test` | `packages/types` (skipped by turbo, expected) |
| `test:security` | **Nowhere.** Root has the script, `turbo.json` has the task definition, but no workspace implements `test:security`. It is currently a no-op like `lint`. Not used in `ci.yml` since the ticket doesn't require it, but flagged here so it isn't mistaken for working coverage. |

Because of the first row, `ci.yml` does **not** run `pnpm lint` at the root —
that would pass every time regardless of actual lint errors, which is worse
than not having a lint job. Instead the `lint` job calls
`pnpm --filter @coreframe-relay/dashboard check-lint` directly, which is the
one real lint script in the repo. `apps/proxy` and `packages/types` are not
linted anywhere because there is no lint tooling installed for them — that's a
gap in the codebase, not something I could paper over from inside
`.github/` and `docs/`.

## What gates merges

Six jobs run on every PR into `main` (and on push to `main`):

1. **`lint`** — `check-lint` (eslint) on `apps/dashboard` only.
2. **`typecheck`** — `pnpm check-types` (root script → `turbo run check-types`), covering dashboard, proxy, and the shared types package.
3. **`test`** — `pnpm test` (root script → `turbo run test`), covering dashboard's Jest suite and proxy's 33 Vitest tests.
4. **`secret-scan`** — Gitleaks over full git history.
5. **`sast`** — Semgrep (`p/typescript`, `p/nextjs`, `p/owasp-top-ten`, `p/secrets`).
6. **`dependency-audit`** — `pnpm audit --audit-level high` + Trivy filesystem scan, both gating on HIGH/CRITICAL.

A seventh job, **`ci-required`**, depends on all six and fails if any of them
failed or were cancelled. **Point GitHub branch protection at `ci-required`**,
not at the six individual jobs — a workflow file alone does not block merges;
you still have to go to
**Settings → Branches → Branch protection rule → `main` → Require status
checks to pass → add `ci-required`**. I could not do this from the repo
checkout (it's a GitHub repo setting, not a file), so it is not done yet.

Jobs run in parallel, not chained sequentially like the sketch in
`relay-engineering-standards.md` PART 10 (`lint-typecheck → unit-integration →
e2e`). That sketch also references `pnpm turbo typecheck lint`, a task name
(`typecheck`) that doesn't exist in this repo (`check-types` does) — I followed
the real script names instead of the sketch's names throughout.

## Required and optional secrets

| Secret | Required? | Used by | Notes |
|---|---|---|---|
| `GITHUB_TOKEN` | Already provided by GitHub Actions automatically | `secret-scan` | No setup needed. |
| `GITLEAKS_LICENSE` | **Conditionally required** | `secret-scan` | Gitleaks-Action is free for repos under a **personal** GitHub account, but requires a license key once the repo lives under a GitHub **Organization** (free for the first repo, paid beyond that). I could not determine from this checkout whether `coreframe-relay` is (or will be) hosted under an org vs. a personal account. If it's an org repo, `secret-scan` will fail with a licensing error until this secret is set — that failure is Gitleaks Inc.'s policy, not a bug in this workflow. Get a trial/paid license at gitleaks.io if needed. |
| `SEMGREP_APP_TOKEN` | **Not required, not used** | — | Deliberately not referenced. See "Semgrep" below. |

No other secrets are referenced anywhere in `ci.yml`. I did not invent any
secret name that isn't either provided by default (`GITHUB_TOKEN`) or
explicitly called out above as something you may need to add.

## Deliberate deviations from the sketches, and why

**Semgrep.** `relay-security-testing-plan.md` PART 5 sketches
`semgrep/semgrep-action@v1`. I checked current Semgrep documentation: that
Marketplace Action wrapper is deprecated upstream in favor of running the
official `semgrep/semgrep` container directly. I used that container with
`semgrep scan --config ... --error`, which runs the same four rulesets from the
sketch (`p/typescript p/nextjs p/owasp-top-ten p/secrets`) and exits non-zero on
findings — no login, no `SEMGREP_APP_TOKEN` required. `semgrep ci` (the
alternative command) *does* require `SEMGREP_APP_TOKEN` for diff-aware scanning,
PR comments, and Semgrep Cloud Platform reporting; if you want those features
later, provision that secret and swap `semgrep scan --error ...` for
`semgrep ci`.

**Gitleaks and Trivy Action versions.** Pinned to `gitleaks/gitleaks-action@v2`
(matches the sketch) and `aquasecurity/trivy-action@0.36.0` (current per a
2026-08 check of the project). Both are floating/tag references, not commit
SHAs. Pinning third-party Actions to a commit SHA is the stronger supply-chain
practice; I did not do it here because I have no reliable way to verify an
exact SHA is correct from inside this sandbox, and shipping a wrong/hallucinated
SHA would silently break the pipeline. Treat "pin these to SHAs" as a follow-up,
not something this PR already does.

**`npm audit` → `pnpm audit`.** The sketch in the security-testing-plan uses
`npm audit --audit-level high`, but this repo has no `package-lock.json` — only
`pnpm-lock.yaml`. `pnpm audit --audit-level high` is the real equivalent and is
what's wired in.

**Trivy invocation.** The sketch curl-installs Trivy by shell script. I used
the official `aquasecurity/trivy-action` GitHub Action instead — same tool,
maintained install path, less brittle in CI than piping a remote install
script to `sh`.

## The Postgres service container (dashboard typecheck)

`apps/dashboard`'s `schema.prisma` reads `DATABASE_URL` via `env("DATABASE_URL")`,
and `tsc --noEmit` fails without a generated Prisma Client (missing
`@prisma/client` types) unless `prisma generate` has already run. I verified
locally:

- `prisma generate` succeeds with `DATABASE_URL` set to a Postgres connection
  string **even when nothing is listening on that port** — it only needs to
  parse the schema, not connect. Confirmed by running it against a URL with no
  live database and getting a clean generate.
- Once generated, `pnpm --filter @coreframe-relay/dashboard check-types` passes
  (exit 0), confirmed locally.

The `typecheck` job still spins up a real `postgres:16` service container and
points `DATABASE_URL` at it, rather than using an obviously-fake URL, so the
same job can grow a `prisma db push`/`migrate deploy` step later without a
second CI setup. The job does **not** run `apps/dashboard`'s own `build` script
(`prisma generate && prisma db push && next build`) — that needs a much larger
env var matrix (`NEXTAUTH_SECRET`, `AUTH_PROVIDERS`, `JACKSON_*`, feature
flags, etc.). That matrix already exists, fully worked out, in a **vestigial,
non-executing** workflow file at `apps/dashboard/.github/workflows/main.yml`
(leftover from the BoxyHQ SaaS Starter Kit this app was forked from — GitHub
Actions only reads `.github/workflows/` at the repo **root**, so that file
currently does nothing). It's a ready-made reference for whoever picks up a
future "full build in CI" ticket. RELAY-10's acceptance criteria only asks for
lint, typecheck, and tests, so a full `next build` is out of scope here.

## The `test` job has no database

I removed `apps/dashboard/.env` locally and re-ran `pnpm test` — the existing
Jest suite (4 tests) passed with no `DATABASE_URL` and no `.env` file present at
all. So the `test` job runs with no Postgres service. **This is a fact about
the current test suite, not a guarantee** — if a future dashboard test touches
Prisma-backed code, this job will need the same `postgres:16` service the
`typecheck` job already has.

## Known-red on day one — pre-existing issues, not CI bugs

Two of the six jobs will fail as soon as this pipeline runs, and neither
failure is caused by the CI setup — both are pre-existing issues in app source
that I could not fix because this task's file boundary is limited to
`.github/` and `docs/ci.md`:

- **`lint` will fail.** `pnpm --filter @coreframe-relay/dashboard check-lint`
  currently reports 22 errors / 3 warnings, run locally and confirmed. Most are
  `i18next/no-literal-string` (hardcoded JSX strings in
  `components/relay/*`, `components/ui/dialog.tsx`) plus one genuine unused
  import (`PaperAirplaneIcon` in `components/team/TeamTab.tsx`).
- **`typecheck` will fail.** `pnpm --filter @coreframe-relay/proxy check-types`
  currently reports `src/index.ts(4,21): error TS6133: 'REQUEST_ID_HEADER' is
  declared but its value is never read.` — one unused const, confirmed locally.

Whoever merges this should expect the pipeline to be red immediately, then file
two quick follow-up fixes (or fix them in the same PR that adds this workflow,
if that's in scope) rather than assume the workflow itself is broken.

## What was verified locally vs. reasoned about

**Verified by actually running the command in this repo:**
- `pnpm --filter @coreframe-relay/proxy test` → 33/33 pass.
- `pnpm --filter @coreframe-relay/proxy check-types` → fails (TS6133, see above).
- `pnpm --filter @coreframe-relay/types check-types` → passes.
- `prisma generate` with a placeholder `DATABASE_URL` and no reachable database → succeeds.
- `pnpm --filter @coreframe-relay/dashboard check-types` after `prisma generate` → passes.
- `pnpm --filter @coreframe-relay/dashboard check-lint` → fails (22 errors, see above).
- `pnpm --filter @coreframe-relay/dashboard test` (Jest), with and without `.env` present → passes both ways, 4/4.
- Confirmed `apps/dashboard/.github/workflows/main.yml` is tracked by git but sits outside the repo-root `.github/`, so GitHub Actions never executes it.
- Confirmed no workspace defines a `lint` or `test:security` script despite root `package.json`/`turbo.json` referencing both.

**Not verified — reasoned about from the actual workflow file, action READMEs, and web search, but never executed (GitHub Actions can't be run from this sandbox):**
- Whether the full `ci.yml` actually parses and runs green on GitHub's runners.
- Whether `coreframe-relay` is hosted under a personal account or a GitHub Organization (determines whether `GITLEAKS_LICENSE` is actually required).
- The exact behavior/output of `gitleaks/gitleaks-action@v2`, `semgrep/semgrep` container, and `aquasecurity/trivy-action@0.36.0` against this specific codebase — I could not install or run any of these three tools inside this sandbox.
- Whether `pnpm audit` returns any HIGH/CRITICAL findings for this dependency tree — the sandbox has no network access, so `pnpm audit` timed out locally and could not be completed.
- Whether `pnpm/action-setup@v4`'s automatic version detection from the `packageManager` field behaves as documented on a real runner.

## Scope explicitly excluded

- **Playwright e2e** (`apps/dashboard`'s `test:e2e`) is not in this pipeline.
  RELAY-10's acceptance criteria names lint, typecheck, and Vitest only. E2e
  needs a mock SAML IdP service, a much larger env var matrix, and browser
  installs — real cost that isn't asked for here. `apps/dashboard/.github/workflows/main.yml`
  (see above) shows a working reference for a future ticket that adds it.
- **Coverage upload / Codecov**, present in the engineering-standards sketch,
  is not included — no `CODECOV_TOKEN` exists and it isn't part of the
  acceptance criteria.
