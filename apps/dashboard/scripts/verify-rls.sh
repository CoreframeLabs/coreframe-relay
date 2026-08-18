#!/usr/bin/env bash
# RELAY-83 — RLS verification, as its own step, never inferred from an exit code.
#
# WHY THIS SCRIPT EXISTS: `prisma migrate deploy` does not apply
# `supabase/migrations/` at all -- Prisma has no representation for
# `FORCE ROW LEVEL SECURITY` or `CREATE POLICY`. That gap is reproduced
# independently on both staging and production (docs/rls.md) and would ship
# silently both times if a green `migrate deploy` were mistaken for proof RLS
# is live. The only real proof is a direct query against the running database,
# run AFTER `supabase db push`, which is what this script does.
#
# Checks (all six must pass):
#   - Route, DeliveryLog, DlqItem, GateRule, ApprovalRequest, AuditLog:
#     relrowsecurity=t AND relforcerowsecurity=t AND >=1 policy each
#   - relay_app role: rolcanlogin=t, rolbypassrls=f, rolsuper=f
#     (rolbypassrls=t would make every policy above inert -- see docs/rls.md's
#     own demonstration of exactly that failure mode against `postgres`)
#
# QUERY VALIDATED (2026-08-14) against the local Supabase stack
# (supabase_db_coreframe-relay, 127.0.0.1:54322, Postgres 17.6) with both
# migrations already applied -- exact output:
#   ApprovalRequest|t|t|1   AuditLog|t|t|1   DeliveryLog|t|t|1
#   DlqItem|t|t|1           GateRule|t|t|1   Route|t|t|1
#   relay_app|t|f|f  (rolname|rolcanlogin|rolbypassrls|rolsuper)
# This proves the QUERY SHAPE is correct against this exact schema. It has NOT
# been run against staging or production -- no credential for either exists in
# this sandbox. That run is the one thing this script cannot do for you.
#
# Usage: verify-rls.sh <postgres-connection-string>
# Exit: 0 all checks pass; 1 otherwise, with every failing check named on stdout.
set -euo pipefail

DB_URL="${1:?usage: verify-rls.sh <postgres-connection-string>}"

psql_query() {
  # Runs via a throwaway postgres:16 container so the runner never needs psql
  # installed locally -- same image family already used in .github/workflows/ci.yml's
  # typecheck job. The connection string is passed as an arg to `psql` inside the
  # container, never echoed, never logged.
  docker run --rm postgres:16 psql "$DB_URL" -t -A -F'|' -c "$1"
}

TABLES=(Route DeliveryLog DlqItem GateRule ApprovalRequest AuditLog)
FAIL=0

echo "== RLS table check (enabled + forced + >=1 policy, all six tables) =="
ROWS="$(psql_query "
select t.relname, t.relrowsecurity, t.relforcerowsecurity,
       (select count(*) from pg_policies p where p.tablename = t.relname)
from pg_class t
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname in ('Route','DeliveryLog','DlqItem','GateRule','ApprovalRequest','AuditLog')
order by t.relname;
")"

for tbl in "${TABLES[@]}"; do
  line="$(printf '%s\n' "$ROWS" | grep -E "^${tbl}\|" || true)"
  if [ -z "$line" ]; then
    echo "  FAIL  $tbl: no row returned (table missing, or migration not applied)"
    FAIL=1
    continue
  fi
  IFS='|' read -r name enabled forced policies <<<"$line"
  ok=1
  [ "$enabled" = t ] || { echo "  FAIL  $tbl: relrowsecurity=$enabled (want t)"; ok=0; }
  [ "$forced"  = t ] || { echo "  FAIL  $tbl: relforcerowsecurity=$forced (want t)"; ok=0; }
  [ "${policies:-0}" -ge 1 ] || { echo "  FAIL  $tbl: policy_count=${policies:-0} (want >=1)"; ok=0; }
  if [ "$ok" = 1 ]; then
    echo "  PASS  $tbl: enabled=t forced=t policies=$policies"
  else
    FAIL=1
  fi
done

echo
echo "== relay_app role check =="
ROLE="$(psql_query "select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname = 'relay_app';")"
if [ -z "$ROLE" ]; then
  echo "  FAIL  relay_app: role does not exist"
  FAIL=1
else
  IFS='|' read -r rolname canlogin bypassrls super <<<"$ROLE"
  ok=1
  [ "$canlogin"  = t ] || { echo "  FAIL  relay_app: rolcanlogin=$canlogin (want t)"; ok=0; }
  [ "$bypassrls" = f ] || { echo "  FAIL  relay_app: rolbypassrls=$bypassrls (want f -- BYPASSRLS makes every policy above inert, see docs/rls.md)"; ok=0; }
  [ "$super"     = f ] || { echo "  FAIL  relay_app: rolsuper=$super (want f)"; ok=0; }
  if [ "$ok" = 1 ]; then
    echo "  PASS  relay_app: rolcanlogin=t rolbypassrls=f rolsuper=f"
  else
    FAIL=1
  fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "RLS VERIFY: PASS -- all six tables enabled+forced with >=1 policy; relay_app present and non-bypassing."
  exit 0
else
  echo "RLS VERIFY: FAIL -- see failures above." >&2
  echo "Do NOT flip DATABASE_URL to relay_app, and do NOT hand a URL to a stranger, until this is green." >&2
  exit 1
fi
