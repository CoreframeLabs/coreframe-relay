#!/usr/bin/env bash
# RELAY-89 — launch-day kill switch.
#
# THE QUESTION THIS ANSWERS: "something is wrong in production, no on-call exists this
# week, what is the single fastest documented action that makes the public surface stop
# accepting traffic without a deploy?"
#
# THE ANSWER: unbind the Cloudflare Workers Custom Domain that points
# in.relay.coreframe-labs.dev at the coreframe-relay-proxy Worker. That mapping is what
# turns an inbound HTTPS request into an invocation of our code; deleting it is not a
# deploy, ships no code, and Cloudflare's edge starts answering with its own generic
# error for that hostname within seconds. Restoring it is the same call in reverse, using
# the exact payload this script saves before it deletes anything -- never a reconstructed
# guess.
#
# WHY THIS SURFACE AND NOT THE DASHBOARD: in.relay.coreframe-labs.dev is the one
# endpoint on this whole product that is DESIGNED to accept unauthenticated-by-a-browser
# POST bodies from strangers' webhook senders (Stripe, Shopify, GitHub, anyone). It is
# the highest-blast-radius surface and the one an incident is most likely to be about.
# Closing dashboard signups is a second, slower, separate action (Founding Access admin
# toggle, RELAY-88 -- a different lane's ticket -- or Vercel Deployment Protection,
# which needs a Vercel token this script does not have) and is documented as a follow-up
# in docs/deploy-runbook.md, not folded into this single command.
#
# WHAT THIS SCRIPT COULD NOT BE TESTED AGAINST: no CLOUDFLARE_API_TOKEN or
# CLOUDFLARE_ACCOUNT_ID is available in this sandbox (the real token is rotated by the
# director this week and never touches this environment). Every HTTP call below is
# reasoned from Cloudflare's documented Workers Custom Domains API, not executed against
# a live account. See docs/deploy-runbook.md's honesty section for exactly what a real
# drill would need and what it would cost.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./kill-switch.sh block
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./kill-switch.sh restore
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./kill-switch.sh status
#
# `block` writes the current binding to a state file before deleting it, so `restore`
# never has to reconstruct a guess about what the mapping was.
set -euo pipefail

HOSTNAME="in.relay.coreframe-labs.dev"
STATE_DIR="${KILL_SWITCH_STATE_DIR:-/tmp/relay-kill-switch}"
STATE_FILE="$STATE_DIR/custom-domain-backup.json"
API="https://api.cloudflare.com/client/v4"

ACTION="${1:-}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN not set -- refusing to invent a credential}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID not set -- refusing to invent a credential}"

auth() { curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' "$@"; }

# Every Cloudflare API response is JSON with a `success` boolean, independent of HTTP
# status. A bad token, a bad account id, or a network hiccup all return `success:false`
# with `result:null` -- which is INDISTINGUISHABLE from a real empty result set unless
# `success` is checked explicitly. Silently treating that as "no binding = already
# blocked" would tell an operator during a real incident that traffic is stopped when it
# is still live. This is exactly the "silent zero reads as healthy" failure mode named
# throughout this launch's own docs (docs/rls.md, growth/product/relay-launch-sprint.md
# D4) -- caught here by testing this script against a deliberately invalid token before
# ever pointing it at a real account.
api_call() {
  local resp
  resp="$(auth "$@")"
  if [ "$(printf '%s' "$resp" | jq -r '.success')" != "true" ]; then
    echo "CLOUDFLARE API CALL FAILED (success=false) -- NOT proceeding, NOT assuming any state:" >&2
    printf '%s' "$resp" | jq '.errors' >&2
    exit 3
  fi
  printf '%s' "$resp"
}

find_domain() {
  api_call "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" \
    | jq -c --arg h "$HOSTNAME" '.result[]? | select(.hostname == $h)'
}

case "$ACTION" in
  status)
    d="$(find_domain)"
    if [ -n "$d" ]; then
      echo "LIVE — $HOSTNAME is bound to a Worker:"
      echo "$d" | jq .
    else
      echo "BLOCKED — no Workers Custom Domain binding exists for $HOSTNAME right now (confirmed via a successful API call, not inferred from an error)."
      [ -f "$STATE_FILE" ] && echo "  (backup on disk at $STATE_FILE, from the last 'block')"
    fi
    ;;

  block)
    mkdir -p "$STATE_DIR"
    d="$(find_domain)"
    if [ -z "$d" ]; then
      echo "Already blocked — no binding found for $HOSTNAME. Nothing to do."
      exit 0
    fi
    echo "$d" > "$STATE_FILE"
    id="$(printf '%s' "$d" | jq -r '.id')"
    echo "Found binding id=$id for $HOSTNAME. Backing up to $STATE_FILE, then deleting."
    started=$(date +%s%3N)
    api_call -X DELETE "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains/$id" | jq .
    ended=$(date +%s%3N)
    echo "KILL SWITCH: BLOCKED $HOSTNAME. API call took $((ended-started))ms."
    echo "Cloudflare edge propagation is typically seconds, not minutes, but is NOT"
    echo "instant everywhere -- verify with: curl -s -o /dev/null -w '%{http_code}\n' https://$HOSTNAME/health"
    echo "Restore with: $0 restore"
    ;;

  restore)
    if [ ! -f "$STATE_FILE" ]; then
      echo "REFUSING: no backup at $STATE_FILE. Cannot restore a binding this script" >&2
      echo "did not itself save -- that would be reconstructing a guess, which is" >&2
      echo "exactly what this script exists to avoid. Recreate the Custom Domain by" >&2
      echo "hand in the Cloudflare dashboard (Workers & Pages -> coreframe-relay-proxy" >&2
      echo "-> Settings -> Domains & Routes) instead." >&2
      exit 1
    fi
    service="$(jq -r '.service' "$STATE_FILE")"
    environment="$(jq -r '.environment' "$STATE_FILE")"
    zone_id="$(jq -r '.zone_id' "$STATE_FILE")"
    started=$(date +%s%3N)
    api_call -X PUT "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/domains" \
      -d "$(jq -n --arg h "$HOSTNAME" --arg s "$service" --arg e "$environment" --arg z "$zone_id" \
            '{hostname:$h, service:$s, environment:$e, zone_id:$z}')" | jq .
    ended=$(date +%s%3N)
    echo "KILL SWITCH: RESTORED $HOSTNAME -> service=$service environment=$environment. API call took $((ended-started))ms."
    echo "Verify: curl -s https://$HOSTNAME/health | jq ."
    mv "$STATE_FILE" "$STATE_FILE.restored-$(date +%s)"
    ;;

  *)
    echo "Usage: $0 {block|restore|status}" >&2
    exit 2
    ;;
esac
