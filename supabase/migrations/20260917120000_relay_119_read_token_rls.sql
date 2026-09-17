-- [RELAY-119] Row Level Security for "RelayReadToken", plus the ONE sanctioned unscoped
-- read path: a definer-rights lookup by token hash.
--
-- Companion to apps/dashboard/prisma/migrations/20260917120000_relay_119_read_token,
-- which creates the table. Same split as every other Relay table: Prisma owns the DDL,
-- this directory owns the policy (Prisma cannot express FORCE ROW LEVEL SECURITY — see
-- docs/rls.md). Apply AFTER the Prisma migration; it references the table.
--
-- ─────────────────────────────────────────────────────────────────
-- WHY THIS TABLE NEEDS ONE THING THE OTHER SIX DO NOT
-- ─────────────────────────────────────────────────────────────────
-- Every existing Relay table is read AFTER the caller's team is known (NextAuth session
-- → `throwIfNoTeamAccess` → `withTeamScope(teamId)` → query). `RelayReadToken` is read
-- BEFORE: the bearer token on `GET /api/relay/deliveries` is the thing that TELLS us the
-- team, so the row has to be found by hash with no `app.current_team_id` set. Under the
-- plain `relay_team_isolation` policy below that lookup would see NULL and return zero
-- rows — every token would 401, forever, which is fail-closed and also useless.
--
-- The tempting fixes are both wrong:
--   * A second, permissive policy (`USING (true)` for SELECT). Postgres ORs permissive
--     policies together, so that would make EVERY unscoped SELECT on this table return
--     every team's rows — the exact class of bug RLS exists to make impossible.
--   * Running the lookup as a bypass role. relay_app must stay NOBYPASSRLS
--     (20260804120000_relay_app_login_and_grants.sql raises if it is not).
--
-- What this migration does instead: a SECURITY DEFINER function whose ONLY behaviour is
-- `WHERE "hashedToken" = $1`. The function's owner (the DDL role that applies this
-- migration — `postgres` on the hosted project, rolbypassrls=t, confirmed in
-- 20260804010000_relay_rls.sql) evaluates the query, so the policy is bypassed for
-- exactly one predicate that cannot be widened from the caller's side: the caller
-- supplies a hash, and gets back at most the one row whose hash it already knew. That is
-- not a leak — presenting the hash's preimage IS the authentication. Everything else on
-- this table (mint, list, revoke, and the `lastUsedAt` write the read path performs
-- after the token is verified) runs as relay_app inside `withTeamScope(token.teamId)`
-- under the ordinary policy, same as `Route` or `DeliveryLog`.
--
-- The guard block at the end raises if the current role does NOT carry BYPASSRLS — a
-- definer function owned by a non-bypass role would inherit FORCE RLS on the table and
-- silently return zero rows, which is the loud-failure-not-silent-leak direction, but
-- still a broken deploy. Better to refuse the migration than to ship a 401-everything.
-- ─────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Enable + FORCE, same as the six tables in 20260804010000_relay_rls.sql.
ALTER TABLE "RelayReadToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RelayReadToken" FORCE ROW LEVEL SECURITY;

-- 2. The ordinary team-isolation policy. `teamId` is carried directly on the row, so
--    this is the `Route`/`AuditLog` shape, not the `DeliveryLog` join-through-Route shape.
--    current_setting(..., true) returns NULL when unset, `"teamId" = NULL` is never true,
--    so the default is deny.
CREATE POLICY relay_team_isolation ON "RelayReadToken"
  USING ("teamId" = current_setting('app.current_team_id', true))
  WITH CHECK ("teamId" = current_setting('app.current_team_id', true));

-- 3. Grants. relay_app already has DML on the table via ALTER DEFAULT PRIVILEGES
--    (20260804120000); this is explicit anyway so the table's policy and its grant are
--    readable side by side, exactly as 20260804010000 does for the first six.
GRANT SELECT, INSERT, UPDATE, DELETE ON "RelayReadToken" TO relay_app;

-- 4. The definer-rights lookup. Returns the full row for one hash, or nothing.
--
--    `SET search_path = pg_catalog, public` — a SECURITY DEFINER function without a
--    pinned search_path is the textbook privilege-escalation vector (a caller who can
--    create objects in an earlier schema on the path shadows a name the function
--    resolves at run time). relay_app cannot create objects anywhere, but the pin costs
--    nothing and removes the argument.
--
--    STABLE: no writes, same result within one statement for the same input.
--    Not filtered on revokedAt/expiresAt on purpose — the application decides those and
--    answers the same 401 body for each, so a caller cannot distinguish "unknown" from
--    "known but dead" (relay-119-auth-decision.md §B.1 "uniform response body"). Keeping
--    the SQL to a bare equality also keeps the one bypass predicate trivially auditable.
CREATE OR REPLACE FUNCTION relay_read_token_lookup(p_hashed_token text)
RETURNS SETOF "RelayReadToken"
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public."RelayReadToken" WHERE "hashedToken" = p_hashed_token LIMIT 1;
$$;

-- Default EXECUTE on functions is granted to PUBLIC; revoke it and re-grant to the one
-- role that should call this. `authenticated`/`anon` (PostgREST) never get it.
REVOKE ALL ON FUNCTION relay_read_token_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay_read_token_lookup(text) TO relay_app;

-- 5. Guard: the function is only a bypass if its owner bypasses RLS. Refuse otherwise.
DO $$
DECLARE
  owner_bypasses boolean;
BEGIN
  SELECT r.rolbypassrls OR r.rolsuper INTO owner_bypasses
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.proname = 'relay_read_token_lookup'
     AND p.pronamespace = 'public'::regnamespace;
  IF owner_bypasses IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'relay_read_token_lookup() is owned by a role without BYPASSRLS — the read-token lookup would return zero rows for every token. Apply this migration as the DDL role (postgres), not as relay_app.';
  END IF;
END
$$;

COMMIT;
