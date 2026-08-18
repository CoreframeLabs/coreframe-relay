#!/usr/bin/env bash
# RELAY-85 / launch containment — Vercel "Ignored Build Step".
#
# THE PROBLEM THIS FILE EXISTS FOR: today, Vercel's Git integration auto-deploys every
# push to `main` straight to the publicly reachable relay.coreframe-labs.dev, with no
# review gate. That is the single most dangerous item on the launch board this week —
# see growth/product/relay-launch-decisions.md #1 and relay-launch-sprint.md D1.
#
# THE FIX HAS TWO INDEPENDENT LAYERS, deliberately not just one:
#   1. Vercel Project Settings -> Git -> Production Branch: change `main` -> `release`.
#      This is a director-only dashboard action this repo cannot express in a file —
#      there is no Vercel API token available in this environment to make the change
#      via API either. See docs/deploy-runbook.md step 1.
#   2. THIS SCRIPT, wired into Vercel Project Settings -> Git -> Ignored Build Step
#      (paste: `bash apps/dashboard/scripts/vercel-ignore-build-step.sh`). It is a
#      second, code-reviewable gate that does not depend on the director remembering
#      the dashboard setting is still correct three weeks from now. Belt AND suspenders
#      — the same reasoning as RLS's own two-layer design (docs/rls.md): one control can
#      be silently reverted or misconfigured without the other noticing.
#
# VERCEL'S CONTRACT (per Vercel's documented Ignored Build Step behaviour — reasoned
# from Vercel's docs, NOT executed against a live Vercel deployment in this sandbox: no
# Vercel credentials are available here):
#   - exit code 0  -> Vercel SKIPS the build. No deployment is produced.
#   - exit code 1  -> Vercel PROCEEDS with the build.
# That is the inverse of a typical CI gate ("0 = fine, continue") and easy to get
# backwards, so it is spelled out at every exit point below.
#
# Vercel provides VERCEL_GIT_COMMIT_REF (the branch name being built) as a System
# Environment Variable automatically -- no configuration needed for it to be present.
set -euo pipefail

REF="${VERCEL_GIT_COMMIT_REF:-}"

if [ -z "$REF" ]; then
  # Unknown ref -- fail SAFE, which for a build gate means "skip the build", not
  # "build it anyway". A missing System Environment Variable is a Vercel platform
  # anomaly, not grounds to deploy.
  echo "REFUSING build: VERCEL_GIT_COMMIT_REF is unset. Skipping (exit 0 = Vercel skips)."
  exit 0
fi

if [ "$REF" = "release" ]; then
  echo "Branch is 'release' -- proceeding with build (exit 1 = Vercel builds)."
  exit 1
fi

echo "Branch is '$REF', not 'release' -- skipping build (exit 0 = Vercel skips)."
echo "Production deploys are gated to the 'release' branch only. See docs/deploy-runbook.md."
exit 0
