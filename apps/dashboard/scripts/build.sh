#!/usr/bin/env bash
# RELAY-41 — `prisma db push` must never run against a hosted database.
#
# The previous build script ran `prisma generate && prisma db push && next build`.
# `db push` diffs the schema and can drop columns WITHOUT confirmation when run
# non-interactively — which is exactly what a build is. Nothing stood between it
# and production the day Vercel was wired to the hosted database.
#
# Vercel is already safe: its project build command is overridden to
# `prisma generate && next build` (RELAY-60, and `build-ci` in package.json).
# THIS script makes the shared default `pnpm build` safe for the local/CI path:
#   - it resolves DATABASE_URL (.env, then environment, then .env.local),
#   - extracts the host,
#   - and REFUSES to build unless the host is 127.0.0.1 or localhost.
#
# Migrations against hosted environments are a deliberate, separate act
# (`prisma migrate deploy` from CI, RELAY-47), never a side effect of a build.
set -euo pipefail

cd "$(dirname "$0")/.."

# Resolution order: apps/dashboard/.env first, then the environment, then
# .env.local. (Next.js itself reads .env, then .env.local overrides it for
# non-test envs; the environment overrides both when exported.)
url_from_file() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  local line
  line=$(grep -E '^[[:space:]]*DATABASE_URL[[:space:]]*=' "$file" | tail -n 1) || return 1
  [[ -n "$line" ]] || return 1
  line="${line#*=}"
  line="${line%%#*}"                       # strip trailing comment
  line="${line#\"}"; line="${line%\"}"     # strip surrounding quotes
  line="${line#\'}"; line="${line%\'}"
  # trim whitespace
  line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  [[ -n "$line" ]] || return 1
  printf '%s' "$line"
}

db_url=""
if ! db_url=$(url_from_file .env); then
  if [[ -n "${DATABASE_URL:-}" ]]; then
    db_url="$DATABASE_URL"
  elif db_url=$(url_from_file .env.local); then
    :
  else
    db_url=""
  fi
fi

host=""
if [[ -n "$db_url" ]]; then
  # postgresql://user:pass@host:port/db?qs — strip scheme, creds, path.
  host="${db_url#*://}"
  host="${host#*@}"
  host="${host%%[/:?#]*}"
  host="${host,,}" # lowercase
fi

if [[ "$host" != "127.0.0.1" && "$host" != "localhost" ]]; then
  echo "REFUSING to build (RELAY-41): DATABASE_URL host is '${host:-<none>}'." >&2
  echo "'prisma db push' can silently drop columns non-interactively; the default" >&2
  echo "build only ever runs against a LOCAL database (127.0.0.1 / localhost)." >&2
  echo "For CI/Vercel use 'build-ci' (next build); hosted migrations are a" >&2
  echo "separate, deliberate 'prisma migrate deploy' — never part of a build." >&2
  exit 1
fi

npx prisma generate
npx next build
