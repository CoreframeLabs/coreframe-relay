#!/usr/bin/env bash
# RELAY-85 — post-deploy verification. Called by .github/workflows/deploy.yml's `verify`
# job, and safe to run by hand (see docs/deploy-runbook.md step 6).
#
# THREE CHECKS, ACROSS TWO HOSTNAMES, RUN ONLY AGAINST THE DEPLOYED ARTEFACT — never
# against a pre-deploy smoke, which proves nothing about what is actually live:
#
#   1. Worker  /health         body contains service:"coreframe-relay-proxy"   (gate F1)
#   2. Worker  /health         response carries a relay-request-id header      (F1, second half)
#   3. Dashboard /api/health   returns 200
#   4. Dashboard /api/auth/csrf returns 200                                    (gate F3/F5, RELAY-86)
#
# WHY BODY, NEVER STATUS, FOR THE WORKER CHECK: growth/product/relay-launch-sprint.md §5,
# condition F1, is explicit — "`/health` body contains `service: 'coreframe-relay-proxy'`
# — body, never status." Cloudflare's own placeholder Worker ALSO answers /health with
# HTTP 200, so a status-only check cannot tell "our Worker is live" apart from "the
# hostname still points at Cloudflare's Hello World stub". Confirmed the hard way while
# writing this script, 2026-08-18, against the current production hostname:
#
#   $ curl -sS https://in.relay.coreframe-labs.dev/health
#   Hello world
#   $ curl -sSI https://in.relay.coreframe-labs.dev/health | grep -i server
#   server: cloudflare
#
# That is the exact failure this check exists to catch — plain text, no JSON body, no
# `relay-request-id` header, `server: cloudflare` rather than our own response shape
# (apps/proxy/src/routes/health.ts). As of that command, condition F1 is RED. This script
# would have caught it, and did.
#
# WHY /api/auth/csrf: the same run found the dashboard host answering 503 on /api/health
# and 500 on /api/auth/csrf (RELAY-86 — filed for exactly this, not fixed here; this
# script is verification, not the fix). Recorded so a future green run has a "was this
# ever red" baseline instead of relying on memory.
#
# RETRIES: Vercel's deploy timing is not under this pipeline's control (see deploy.yml's
# header comment) — the artefact this job checks may not have finished propagating when
# it starts. Every check retries for up to 3 minutes (18 attempts, 10s apart) before it
# is called a failure.
set -uo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-https://relay.coreframe-labs.dev}"
PROXY_URL="${PROXY_URL:-https://in.relay.coreframe-labs.dev}"
RETRIES="${VERIFY_RETRIES:-18}"
SLEEP_SECS="${VERIFY_SLEEP_SECS:-10}"

FAIL=0

retry() {
  local desc="$1"; shift
  local i
  for i in $(seq 1 "$RETRIES"); do
    if "$@"; then
      echo "  PASS  $desc (attempt $i/$RETRIES)"
      return 0
    fi
    echo "  ...   $desc not yet passing (attempt $i/$RETRIES) -- waiting ${SLEEP_SECS}s"
    sleep "$SLEEP_SECS"
  done
  echo "  FAIL  $desc did not pass within $((RETRIES * SLEEP_SECS))s"
  return 1
}

check_worker_body_shape() {
  local body service
  body="$(curl -sS -m 10 "$PROXY_URL/health" 2>/dev/null || true)"
  service="$(printf '%s' "$body" | jq -r '.service // empty' 2>/dev/null || true)"
  [ "$service" = "coreframe-relay-proxy" ]
}

check_worker_request_id_header() {
  local header
  header="$(curl -sSI -m 10 "$PROXY_URL/health" 2>/dev/null | tr -d '\r' | grep -i '^relay-request-id:' || true)"
  [ -n "$header" ]
}

check_dashboard_health() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 "$DASHBOARD_URL/api/health" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

check_csrf() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 "$DASHBOARD_URL/api/auth/csrf" 2>/dev/null || true)"
  [ "$code" = "200" ]
}

echo "== Post-deploy verification (4 checks, 2 hosts) =="
echo "DASHBOARD_URL=$DASHBOARD_URL"
echo "PROXY_URL=$PROXY_URL"
echo "retry budget: ${RETRIES} attempts x ${SLEEP_SECS}s = $((RETRIES * SLEEP_SECS))s per check"
echo

echo "-- F1: Worker /health body shape --"
retry "proxy /health body contains service:coreframe-relay-proxy" check_worker_body_shape || FAIL=1

echo
echo "-- F1: Worker /health carries relay-request-id header --"
retry "proxy /health relay-request-id header present" check_worker_request_id_header || FAIL=1

echo
echo "-- Dashboard /api/health --"
retry "dashboard /api/health returns 200" check_dashboard_health || FAIL=1

echo
echo "-- Dashboard /api/auth/csrf (RELAY-86) --"
retry "dashboard /api/auth/csrf returns 200" check_csrf || FAIL=1

echo
if [ "$FAIL" -eq 0 ]; then
  echo "VERIFY: PASS -- all 4 checks green against the deployed artefact."
  exit 0
else
  echo "VERIFY: FAIL -- see failures above. Do NOT record this deploy as verified." >&2
  exit 1
fi
