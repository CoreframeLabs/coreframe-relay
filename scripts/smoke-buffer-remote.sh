#!/usr/bin/env bash
# ==============================================================================
# smoke-buffer-remote.sh — RELAY-66's G1 gate, the REAL production path
#
# WHY THIS FILE EXISTS, NOT A REWRITE OF scripts/smoke-buffer.sh:
#
# `smoke-buffer.sh`'s "PRODUCTION" mode has been structurally unable to pass since
# RELAY-74 landed. Steps 5/6/8/9 all go through `/api/relay/qstash-test`, and step 3's
# destination is `/api/relay/smoke-destination` — both endpoints are correctly refused
# on any deployed platform by `lib/relay/localOnly.ts`'s `localOnlyVerdict()` (a
# deliberate security control, not a bug). No SMOKE_DEST_AUTH value, however correct,
# changes that: the refusal fires on `isDeployedPlatform()` alone, before any
# credential is even read. See relay-dev-log.md's 2026-08-31 entry for the full
# investigation. `smoke-buffer.sh` itself is UNCHANGED by this file and remains the
# right tool for local dev (`smoke-dev.sh` still calls it).
#
# THE REAL PATH THIS SCRIPT PROVES, END TO END, AGAINST REAL PRODUCTION:
#
#   - A route's `destination` is fixed at CREATE time and there is NO public API to
#     change it afterwards (grepped: the only caller of `updateRoute` with an arbitrary
#     destination is test-send.ts's own catcher round-trip, which restores it in a
#     `finally`). So "re-point the destination" cannot mean an API call this script
#     controls — it has to mean the EXTERNAL destination's own behaviour changes while
#     its URL stays fixed. webhook.site supports exactly that: `PUT /token/:uuid` sets
#     the `default_status` the token's public URL answers with, with no auth required
#     for this. One route, one real `destination`, two behaviours over its lifetime —
#     this is what "genuinely external, real async QStash delivery" means when the
#     product itself has no destination-swap feature to call instead.
#
#   - `/api/relay/routes` is created WITHOUT `destinationHeaders`. RELAY_DESTINATION_
#     HEADERS_KEY does not exist in production (a separately tracked, real defect —
#     see RELAY-59's entry) and setting destinationHeaders is explicitly out of this
#     script's scope. Every route this script creates carries only `destination`,
#     `name`, `maxRetries`.
#
#   - CONFIRM_EMAIL=true gates login in production. This script cannot complete a cold
#     run unattended: signup happens, then the script PAUSES (exit 75) and prints the
#     exact SQL to hand to `mcp__claude_ai_Supabase__execute_sql` (project
#     qflrfhrpchazyihxtfrl) to fetch the real `VerificationToken`, plus the `curl` that
#     hits the real `GET /auth/verify-email-token?token=...` page route. Re-running
#     this script with the SAME `SMOKE_STAMP` then continues: signup's 400 "already
#     exists" is the pass-through, and login now succeeds for real.
#
# USAGE (production, the actual G1 run):
#
#   ./scripts/smoke-buffer-remote.sh
#     …  prints STAMP, EMAIL, TEAM, and pauses at exit 75  …
#   # fetch VerificationToken via Supabase MCP, hit the real verify-email-token URL
#   SMOKE_STAMP=<same stamp printed above> ./scripts/smoke-buffer-remote.sh
#     …  continues from signup (idempotent) through the full DLQ+retry proof  …
#
# Steps:
#   1  preflight     tools, remote-host guard (refuses localhost — the INVERSE of
#                    smoke-buffer.sh's local-only guard), dashboard/proxy health
#   2  signup        POST /api/auth/join, throwaway email; idempotent on re-run
#   3  verify+login  detects the CONFIRM_EMAIL gate; pauses for out-of-band
#                    verification on first run, succeeds on the re-run
#   4  route         real POST …/relay/routes, destination = a fresh webhook.site
#                    token (started at 200), NO destinationHeaders
#   5  SAVE          a real webhook POSTed to the real public ingest URL, polled from
#                    the real …/relay/log until a DeliveryLog row is DELIVERED — real
#                    async QStash round trip, not a synchronous local shortcut
#   6  test-send     real POST …/routes/:id/test-send (NOT gated by localOnly — it is
#                    a real customer-facing button), polled the same way
#   7  DLQ           webhook.site token flipped to 500 via its own real API, a real
#                    webhook sent, polled until DeliveryLog status=DLQ and a DlqItem
#                    exists — real QStash retry-then-give-up, on real infrastructure
#   8  DLQ retry     webhook.site token flipped BACK to 200, real POST
#                    …/relay/dlq/:id/retry, polled until the SAME row transitions
#                    DLQ -> DELIVERED (proof is the status transition on one row, see
#                    the attemptCount note below — NOT attemptCount magnitude)
#
# A NOTE ON attemptCount ACROSS A RETRY, read directly from the source before writing
# this script (`lib/relay/consume.ts`): `attemptCount` is computed per QStash MESSAGE
# from that message's own `Upstash-Retried` header, not accumulated across separate
# `publishToQStash` calls. A DLQ retry publishes a brand-new message with a fresh
# retry budget, so a retry that succeeds on its own first attempt writes
# `attemptCount=1` to the SAME row, not the DLQ write's attemptCount plus one.
# `smoke-buffer.sh`'s step 9 asserts `attemptCount >= 2` after a retry — an assumption
# that was never actually exercised against a real retry (the local run always hit the
# QStash-loopback wall first), and this script does NOT repeat it. The honest proof of
# a genuine redelivery is the STATUS transition (DLQ -> DELIVERED) on the one row keyed
# by the retry's unchanged `requestId`, plus exactly one DlqItem still on file for it
# (dedupe-on-requestId, unchanged by the retry).
#
# A REAL, LIVE PRODUCTION DEFECT THIS SCRIPT'S FIRST RUN FOUND (2026-08-31), BLOCKING
# STEP 7/8 AS OF THIS WRITING: production's `DlqItem` table is missing the `headers`
# column — migration `20260819120000_relay_65_dlq_headers` is absent from production's
# `_prisma_migrations` table even though later migrations are present, so it was
# skipped, not a halted pipeline. The deployed app code is current and unconditionally
# writes `headers` on every DLQ insert, so every real DLQ write in production throws
# (column does not exist), is swallowed, and answers QStash's own final retry attempt
# with 500 — which is read as terminal, not retried again. Confirmed by a direct
# `select count(*) from "DlqItem"` on production returning **zero** rows: the DLQ
# feature has never written a single row in production. This is an environment defect,
# not a flaw in this script's design — step 7 below detects it and explains it in
# place rather than failing generically. Fix is a director-approved migration deploy
# (the migration itself is a one-line additive `ALTER TABLE ... ADD COLUMN`, safe, no
# backfill needed) — not something this script does on its own.
#
# Exit: 0 pass; 75 = paused for out-of-band email verification (not a failure);
# N (other) = failing step.
# Env: DASHBOARD_URL, PROXY_URL, SMOKE_STAMP, SMOKE_PASSWORD, WEBHOOK_SITE_BASE.
# ==============================================================================
set -u

DASHBOARD_URL="${DASHBOARD_URL:-https://relay.coreframe-labs.dev}"
PROXY_URL="${PROXY_URL:-https://in.relay.coreframe-labs.dev}"
WEBHOOK_SITE_BASE="${WEBHOOK_SITE_BASE:-https://webhook.site}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/smoke-buffer-remote.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

CURRENT_STEP=1; PASSES=0; WARNS=0
pass()     { PASSES=$((PASSES+1)); printf '  PASS %s\n' "$1"; }
warn()     { WARNS=$((WARNS+1));   printf '  WARN %s\n' "$1"; }
banner()   { CURRENT_STEP="$1"; printf '\n== STEP %s — %s ==\n' "$1" "$2"; }
fail_step(){ printf '  FAIL (step %s) %s\n' "$CURRENT_STEP" "$1";
             printf '\nSMOKE-REMOTE: FAILED at step %s (exit %s)\n' "$CURRENT_STEP" "$CURRENT_STEP" >&2; exit "$CURRENT_STEP"; }
pause_for_verification() {
  printf '\n%s\n' "$1"
  printf '\nSMOKE-REMOTE: PAUSED — out-of-band step required (not a failure, exit 75)\n' >&2
  exit 75
}

jget() { printf '%s' "$1" | jq -r "$2 | if . == null then empty else tostring end" 2>/dev/null; }

req() { local m="$1" u="$2"; shift 2
  local raw; raw="$(curl -s -m 20 -w '\n%{http_code}' -X "$m" "$u" "$@")"
  R_CODE="$(printf '%s' "$raw" | awk 'END{print}')"
  R_BODY="$(printf '%s' "$raw" | awk 'NR>1{print p}{p=$0}')"; }

# ── STEP 1 ──────────────────────────────────────────────────────────────────
banner 1 "preflight — tools, remote-host guard, dashboard/proxy liveness"
for t in curl jq node; do
  command -v "$t" >/dev/null 2>&1 && pass "$t on PATH ($(command -v "$t"))" \
    || fail_step "$t not on PATH"; done

case "$DASHBOARD_URL" in
  http://localhost*|http://127.0.0.1*)
    fail_step "DASHBOARD_URL=$DASHBOARD_URL is a loopback host — this script is the REMOTE-only counterpart to smoke-buffer.sh. Use smoke-buffer.sh for local dev." ;;
  *) : ;;
esac
pass "remote host guard — DASHBOARD_URL=$DASHBOARD_URL is not localhost"

req GET "$DASHBOARD_URL/api/health"
[ "$R_CODE" = 200 ] || fail_step "dashboard /api/health -> $R_CODE"
pass "dashboard healthy — /api/health 200"
req GET "$PROXY_URL/health"
[ "$R_CODE" = 200 ] || fail_step "proxy /health -> $R_CODE"
pass "proxy healthy — /health 200"

# ── STEP 2 — signup ─────────────────────────────────────────────────────────
banner 2 "signup — POST /api/auth/join (throwaway account, real production DB write)"
STAMP="${SMOKE_STAMP:-$(date +%s)}"
SMOKE_EMAIL="smoke-remote-${STAMP}@smoke.coreframe-labs.dev"
SMOKE_TEAM="smoke-remote-${STAMP}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-smoke-remote-${STAMP}-Aa1!}"
printf '  STAMP=%s\n  EMAIL=%s\n  TEAM=%s\n' "$STAMP" "$SMOKE_EMAIL" "$SMOKE_TEAM"

req POST "$DASHBOARD_URL/api/auth/join" -H 'content-type: application/json' \
  -d "{\"name\":\"Smoke Remote Runner\",\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PASSWORD\",\"team\":\"$SMOKE_TEAM\"}"
case "$R_CODE" in
  201) CONFIRM_NEEDED="$(jget "$R_BODY" .data.confirmEmail)"
       pass "signup 201 — $SMOKE_EMAIL created (real DB write: account + team + membership); confirmEmail=$CONFIRM_NEEDED" ;;
  400) printf '%s' "$R_BODY" | grep -q "already exists" \
        && pass "signup pass-through — 'user already exists' (idempotent re-run) for $SMOKE_EMAIL" \
        || fail_step "signup 400: $(printf '%s' "$R_BODY" | head -c 200)" ;;
  *)   fail_step "signup -> $R_CODE: $(printf '%s' "$R_BODY" | head -c 200)" ;;
esac

# ── STEP 3 — verification gate + session ────────────────────────────────────
banner 3 "verify+login — NextAuth credentials; CONFIRM_EMAIL gate handled explicitly"
JAR="$WORK/cookies.txt"
req GET "$DASHBOARD_URL/api/auth/csrf" -c "$JAR"
[ "$R_CODE" = 200 ] || fail_step "csrf -> $R_CODE"
CSRF="$(jget "$R_BODY" .csrfToken)"; [ -n "$CSRF" ] || fail_step "csrfToken missing"

req POST "$DASHBOARD_URL/api/auth/callback/credentials" -b "$JAR" -c "$JAR" \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "email=$SMOKE_EMAIL" \
  --data-urlencode "password=$SMOKE_PASSWORD" --data-urlencode "json=true"

if [ "$R_CODE" != 200 ]; then
  pause_for_verification "  Login -> $R_CODE (expected while the account is unverified: CONFIRM_EMAIL=true gates it). Body: $(printf '%s' "$R_BODY" | head -c 200)

  This is the real production auth gate — not a bug in this script. To continue:

  1. Fetch the real VerificationToken via mcp__claude_ai_Supabase__execute_sql (project qflrfhrpchazyihxtfrl):
       select token from \"VerificationToken\" where identifier = '$SMOKE_EMAIL' order by expires desc limit 1;

  2. Hit the real verify-email-token page route with that token (sets emailVerified, deletes the token):
       curl -sD - -o /dev/null '$DASHBOARD_URL/auth/verify-email-token?token=<TOKEN>' | grep -i '^location:'
     (expect a redirect Location containing /auth/login?success=email-verified)

  3. Re-run this script with the SAME stamp so signup is a no-op pass-through and login now succeeds:
       SMOKE_STAMP=$STAMP $0"
fi

req GET "$DASHBOARD_URL/api/auth/session" -b "$JAR"
[ "$(jget "$R_BODY" .user.email)" = "$SMOKE_EMAIL" ] || fail_step "session email=$(jget "$R_BODY" .user.email) expected $SMOKE_EMAIL"
pass "signed in for real — POST callback/credentials 200; GET session .user.email=$SMOKE_EMAIL"

# ── STEP 4 — route, destination = a real external webhook.site token ───────
banner 4 "route — POST …/relay/routes, destination = a fresh webhook.site token (no destinationHeaders)"
WH_CREATE="$(curl -s -m 20 -X POST "$WEBHOOK_SITE_BASE/token" -H 'content-type: application/json' \
  -d '{"default_status":200,"default_content":"smoke-ok","default_content_type":"text/plain"}')"
WH_TOKEN="$(jget "$WH_CREATE" .uuid)"
[ -n "$WH_TOKEN" ] || fail_step "could not create a webhook.site token: $(printf '%s' "$WH_CREATE" | head -c 200)"
WH_URL="$WEBHOOK_SITE_BASE/$WH_TOKEN"
pass "webhook.site token created — $WH_TOKEN (default_status=200); this is the route's REAL destination for its whole lifetime"

req POST "$DASHBOARD_URL/api/teams/$SMOKE_TEAM/relay/routes" -b "$JAR" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"smoke-remote-$STAMP\",\"destination\":\"$WH_URL\",\"maxRetries\":1}"
[ "$R_CODE" = 201 ] || fail_step "route create -> $R_CODE: $(printf '%s' "$R_BODY" | head -c 300)"
ROUTE_ID="$(jget "$R_BODY" .data.id)"; ROUTE_SLUG="$(jget "$R_BODY" .data.slug)"
INGEST_URL="$(jget "$R_BODY" .data.relayUrl)"
case "$INGEST_URL" in *"$SMOKE_TEAM"*) : ;; *) fail_step "relayUrl missing team slug $SMOKE_TEAM: $INGEST_URL" ;; esac
pass "route created 201 — id=$ROUTE_ID slug=$ROUTE_SLUG destination=$WH_URL relayUrl=$INGEST_URL (no destinationHeaders — RELAY_DESTINATION_HEADERS_KEY is out of scope)"

# Poll the real delivery feed for a specific requestId until it reaches a terminal
# status, or until $3 seconds have elapsed. Prints progress every 5s.
poll_log() { # $1=requestId $2=want-status $3=timeout-seconds
  local rid="$1" want="$2" timeout="$3" elapsed=0 row=""
  while [ "$elapsed" -lt "$timeout" ]; do
    row="$(curl -s -m 15 -b "$JAR" "$DASHBOARD_URL/api/teams/$SMOKE_TEAM/relay/log?routeId=$ROUTE_ID&take=25" \
          | jq -c --arg rid "$rid" '.data[]?|select(.requestId==$rid)' 2>/dev/null | head -1)"
    if [ -n "$row" ]; then
      local st; st="$(jget "$row" .status)"
      if [ "$st" = "$want" ]; then POLL_ROW="$row"; return 0; fi
    fi
    sleep 5; elapsed=$((elapsed+5))
    [ $((elapsed % 15)) -eq 0 ] && printf '  … waited %ss for requestId=%s status=%s (want %s)\n' "$elapsed" "$rid" "${st:-none yet}" "$want"
  done
  POLL_ROW="$row"
  return 1
}

# ── STEP 5 — SAVE THE WEBHOOK, real async delivery ──────────────────────────
banner 5 "SAVE THE WEBHOOK — real webhook POSTed to the real public ingest URL"
SAVE_ID="$(node -e 'console.log(crypto.randomUUID())')"
req POST "$INGEST_URL" -H 'content-type: application/json' -H "relay-request-id: $SAVE_ID" \
  -d "{\"smoke\":\"save\",\"stamp\":\"$STAMP\"}"
[ "$R_CODE" = 200 ] || fail_step "real ingest -> $R_CODE (expected 200 queued): $(printf '%s' "$R_BODY" | head -c 200)"
[ "$(jget "$R_BODY" .status)" = "queued" ] || fail_step "ingest status != queued: $R_BODY"
RETURNED_ID="$(jget "$R_BODY" .requestId)"
[ "$RETURNED_ID" = "$SAVE_ID" ] || fail_step "proxy did not honour our relay-request-id (got $RETURNED_ID, sent $SAVE_ID)"
pass "real ingest -> 200 {\"status\":\"queued\",\"requestId\":\"$SAVE_ID\"} — path token authenticated it, QStash publish accepted"

poll_log "$SAVE_ID" DELIVERED 90 \
  || fail_step "no DELIVERED row for requestId=$SAVE_ID after 90s of real async QStash delivery (last seen: $POLL_ROW)"
SAVE_STATUS="$(jget "$POLL_ROW" .status)"
[ "$(jget "$POLL_ROW" .isTest)" = "false" ] || fail_step "save row isTest != false: $POLL_ROW"
pass "SAVE THE WEBHOOK — real DeliveryLog row requestId=$SAVE_ID isTest=false status=$SAVE_STATUS attemptCount=$(jget "$POLL_ROW" .attemptCount) responseCode=$(jget "$POLL_ROW" .responseCode) — proxy -> QStash -> consumer -> webhook.site -> DeliveryLog, entirely real infrastructure"

# ── STEP 6 — test webhook (RELAY-50), the real button ───────────────────────
banner 6 "test webhook — real POST …/routes/:id/test-send (NOT gated by localOnly)"
req POST "$DASHBOARD_URL/api/teams/$SMOKE_TEAM/relay/routes/$ROUTE_ID/test-send" -b "$JAR"
[ "$R_CODE" = 200 ] || fail_step "test-send -> $R_CODE: $(printf '%s' "$R_BODY" | head -c 200)"
TEST_REQ_ID="$(jget "$R_BODY" .data.requestId)"
[ -n "$TEST_REQ_ID" ] || fail_step "test-send returned no requestId: $R_BODY"
pass "test-send -> 200 requestId=$TEST_REQ_ID — the real customer-facing button, real ingest, real QStash"

poll_log "$TEST_REQ_ID" DELIVERED 90 \
  || fail_step "no DELIVERED row for test requestId=$TEST_REQ_ID after 90s (last seen: $POLL_ROW)"
[ "$(jget "$POLL_ROW" .isTest)" = "true" ] || fail_step "test row isTest != true: $POLL_ROW"
pass "isTest split proven for real — test=$TEST_REQ_ID isTest=true status=$(jget "$POLL_ROW" .status) (RELAY-12's billing-exclusion field, real row)"

# ── STEP 7 — DLQ, real QStash retry-then-give-up ────────────────────────────
banner 7 "DLQ — webhook.site flipped to 500 (real API), real webhook, real QStash retries"
curl -s -m 15 -X PUT "$WEBHOOK_SITE_BASE/token/$WH_TOKEN" -H 'content-type: application/json' \
  -d '{"default_status":500,"default_content":"smoke-fail","default_content_type":"text/plain"}' >/dev/null
sleep 1
FLIP_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$WH_URL")"
[ "$FLIP_CODE" = 500 ] || fail_step "webhook.site did not actually flip to 500 (observed $FLIP_CODE) — refusing to trust an unverified destination state"
pass "webhook.site $WH_TOKEN now answers 500 (verified with a direct GET, not assumed) — the ROUTE's destination URL is unchanged"

DLQ_REQ_ID="$(node -e 'console.log(crypto.randomUUID())')"
req POST "$INGEST_URL" -H 'content-type: application/json' -H "relay-request-id: $DLQ_REQ_ID" \
  -d "{\"smoke\":\"dlq\",\"stamp\":\"$STAMP\"}"
[ "$R_CODE" = 200 ] || fail_step "real ingest (dlq leg) -> $R_CODE: $(printf '%s' "$R_BODY" | head -c 200)"
pass "real ingest -> 200 queued, requestId=$DLQ_REQ_ID — route.maxRetries=1 means QStash will try, fail, retry once, then give up"

poll_log "$DLQ_REQ_ID" DLQ 240 \
  || fail_step "no DLQ row for requestId=$DLQ_REQ_ID after 240s of real QStash retry backoff (last seen: $POLL_ROW)"
pass "DeliveryLog status=DLQ for real — requestId=$DLQ_REQ_ID attemptCount=$(jget "$POLL_ROW" .attemptCount) responseCode=$(jget "$POLL_ROW" .responseCode) (webhook.site really answered 500, QStash really exhausted the retry budget)"

DLQ_ITEM_ID=""; i=0
while [ $i -lt 12 ]; do
  DLQ_LIST="$(curl -s -m15 -b "$JAR" "$DASHBOARD_URL/api/teams/$SMOKE_TEAM/relay/dlq")"
  DLQ_ITEM_ID="$(printf '%s' "$DLQ_LIST" | jq -r --arg rid "$DLQ_REQ_ID" '.data.items[]?|select(.requestId==$rid)|.id' | head -1)"
  [ -n "$DLQ_ITEM_ID" ] && break; i=$((i+1)); sleep 2
done
if [ -z "$DLQ_ITEM_ID" ]; then
  fail_step "no DlqItem for requestId=$DLQ_REQ_ID after 24s, DESPITE DeliveryLog.status=DLQ above.

  KNOWN CAUSE, confirmed live 2026-08-31 via mcp__claude_ai_Supabase__execute_sql
  (project qflrfhrpchazyihxtfrl): production's DlqItem TABLE is missing the
  'headers' column entirely —
    select column_name from information_schema.columns where table_name='DlqItem';
  does not list it, because migration 20260819120000_relay_65_dlq_headers
  ('ALTER TABLE \"DlqItem\" ADD COLUMN \"headers\" JSONB;') is absent from
  production's _prisma_migrations table, even though LATER migrations
  (20260825120000_relay_13_team_plan, 20260825130000_relay_68_team_attribution)
  ARE present — this one migration was skipped, not a stopped pipeline.
  The deployed application code is current (models/dlq.ts's recordDlqItem
  unconditionally writes 'headers' on every insert), so every real DLQ write in
  production throws 'column \"headers\" of relation \"DlqItem\" does not exist',
  is swallowed by consume.ts's catch, and answers QStash's own FINAL retry
  attempt with 500 — which QStash reads as terminal (budget already exhausted)
  and does not retry again. Net effect, confirmed by a direct count query
  returning ZERO rows: the DLQ feature has NEVER written a single row in
  production. This is independent of this script — no design change here can
  work around a table missing a column the application code requires.
  Fix: apply the pending migration (safe, additive, no backfill) to production,
  then re-run this exact script with SMOKE_STAMP=$STAMP — steps 1-7 already
  passed and are idempotent-safe to skip past once verification is complete."
fi
pass "real DlqItem present — id=$DLQ_ITEM_ID"

# ── STEP 8 — DLQ retry, real redelivery ─────────────────────────────────────
banner 8 "DLQ retry — webhook.site flipped back to 200, real POST …/dlq/:id/retry"
curl -s -m 15 -X PUT "$WEBHOOK_SITE_BASE/token/$WH_TOKEN" -H 'content-type: application/json' \
  -d '{"default_status":200,"default_content":"smoke-ok","default_content_type":"text/plain"}' >/dev/null
sleep 1
FLIP_CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$WH_URL")"
[ "$FLIP_CODE" = 200 ] || fail_step "webhook.site did not actually flip back to 200 (observed $FLIP_CODE)"
pass "webhook.site $WH_TOKEN now answers 200 again — same URL the whole time, the ROUTE's destination was never touched by this script"

req POST "$DASHBOARD_URL/api/teams/$SMOKE_TEAM/relay/dlq/$DLQ_ITEM_ID/retry" -b "$JAR"
[ "$R_CODE" = 202 ] || fail_step "retry -> $R_CODE (expected 202 queued against real production): $(printf '%s' "$R_BODY" | head -c 300)"
pass "retry queued — POST …/dlq/:id/retry -> 202 requestId=$(jget "$R_BODY" .data.requestId) messageId=$(jget "$R_BODY" .data.messageId)"

poll_log "$DLQ_REQ_ID" DELIVERED 90 \
  || fail_step "retried row requestId=$DLQ_REQ_ID never reached DELIVERED after 90s (last seen: $POLL_ROW)"
pass "REDELIVERED FOR REAL — same requestId=$DLQ_REQ_ID, same DeliveryLog row, transitioned DLQ -> DELIVERED, attemptCount=$(jget "$POLL_ROW" .attemptCount) (see this script's header note on why attemptCount is not asserted >=2 — it is per-message, not cumulative)"

DLQ_AGAIN="$(curl -s -m15 -b "$JAR" "$DASHBOARD_URL/api/teams/$SMOKE_TEAM/relay/dlq")"
CT="$(printf '%s' "$DLQ_AGAIN" | jq --arg rid "$DLQ_REQ_ID" '[.data.items[]?|select(.requestId==$rid)]|length')"
[ "$CT" = 1 ] || fail_step "DLQ holds $CT items for $DLQ_REQ_ID after retry (expected exactly 1 — requestId dedupe)"
pass "no duplicate DLQ entry — exactly 1 item for $DLQ_REQ_ID after the retry"

printf '\n==============================================\n'
printf 'SMOKE-REMOTE: PASS  (%s assertions, %s warnings)\n' "$PASSES" "$WARNS"
printf '  account       : %s\n  team          : %s\n  route         : %s (%s)\n' "$SMOKE_EMAIL" "$SMOKE_TEAM" "$ROUTE_ID" "$ROUTE_SLUG"
printf '  webhook.site  : %s (%s)\n' "$WH_TOKEN" "$WH_URL"
printf '  save          : requestId=%s isTest=false status=%s\n' "$SAVE_ID" "$SAVE_STATUS"
printf '  test-send     : requestId=%s isTest=true DELIVERED\n' "$TEST_REQ_ID"
printf '  dlq -> retry  : requestId=%s dlqItem=%s -> DELIVERED\n' "$DLQ_REQ_ID" "$DLQ_ITEM_ID"
printf '\n  CLEANUP OWED (not performed by this script): user %s, team %s, route %s,\n' "$SMOKE_EMAIL" "$SMOKE_TEAM" "$ROUTE_ID"
printf '  the DeliveryLog rows for requestIds %s / %s / %s, DlqItem %s,\n' "$SAVE_ID" "$TEST_REQ_ID" "$DLQ_REQ_ID" "$DLQ_ITEM_ID"
printf '  and the webhook.site token %s (DELETE https://webhook.site/token/%s).\n' "$WH_TOKEN" "$WH_TOKEN"
printf '==============================================\n'
exit 0
