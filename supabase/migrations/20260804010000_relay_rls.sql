-- RELAY-11: Enable Row Level Security on every Relay table.
--
-- Tables: Route, DeliveryLog, DlqItem, GateRule, ApprovalRequest, AuditLog.
--
-- READ coreframe-relay/docs/rls.md BEFORE assuming this migration protects the
-- app's Prisma path. Short version: it does not, today. Prisma connects as the
-- `postgres` role, which carries the BYPASSRLS attribute (confirmed on the
-- local stack: rolsuper=false, rolbypassrls=true), and Postgres bypasses RLS
-- unconditionally for any role with BYPASSRLS -- FORCE ROW LEVEL SECURITY does
-- NOT override that. Tenant isolation for the app today still rests entirely
-- on every Prisma query's `where teamId = ...`, exactly as before this
-- migration. What this migration DOES do is close off every other path to
-- these tables (PostgREST anon/authenticated, the Supabase SQL editor under a
-- non-bypass role, any future service that connects without BYPASSRLS) so that
-- path fails closed instead of wide open. See docs/rls.md for the full
-- reasoning and the follow-up required to make RLS cover Prisma itself.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Enable + FORCE row level security on all six Relay tables.
--
-- FORCE is what makes RLS apply even to the table owner (normally an owner
-- is exempt). It's still bypassed by any role carrying BYPASSRLS (postgres,
-- service_role on this stack) -- that exemption cannot be turned off with
-- FORCE; it is a role attribute, not a table setting. See docs/rls.md.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE "Route"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Route"           FORCE ROW LEVEL SECURITY;

ALTER TABLE "DeliveryLog"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeliveryLog"     FORCE ROW LEVEL SECURITY;

ALTER TABLE "DlqItem"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DlqItem"         FORCE ROW LEVEL SECURITY;

ALTER TABLE "GateRule"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GateRule"        FORCE ROW LEVEL SECURITY;

ALTER TABLE "ApprovalRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalRequest" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AuditLog"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog"        FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────
-- 2. Policies.
--
-- This app has no Supabase Auth users -- NextAuth owns sessions, and
-- TeamMember.userId points at this app's own User table, never at
-- auth.users. That means auth.uid() has nothing to join against here; a
-- policy written against auth.uid() would silently deny every real caller
-- forever and give a false sense of "per-team" enforcement that can never
-- actually be demonstrated (see docs/rls.md for why that was rejected).
--
-- Instead these policies scope on a session-local setting,
-- `app.current_team_id`, that a trusted server-side caller sets (e.g. via
-- `SET LOCAL` inside the request's transaction) AFTER verifying the caller's
-- team membership from their own session -- never from a client-supplied
-- header or body field. current_setting(..., true) returns NULL when unset,
-- and `"teamId" = NULL` is never true, so the default is deny, not allow.
--
-- Route / GateRule / ApprovalRequest / AuditLog carry teamId directly.
-- DeliveryLog / DlqItem only carry routeId, so they scope through Route.
-- ─────────────────────────────────────────────────────────────────

CREATE POLICY relay_team_isolation ON "Route"
  USING ("teamId" = current_setting('app.current_team_id', true))
  WITH CHECK ("teamId" = current_setting('app.current_team_id', true));

CREATE POLICY relay_team_isolation ON "GateRule"
  USING ("teamId" = current_setting('app.current_team_id', true))
  WITH CHECK ("teamId" = current_setting('app.current_team_id', true));

CREATE POLICY relay_team_isolation ON "ApprovalRequest"
  USING ("teamId" = current_setting('app.current_team_id', true))
  WITH CHECK ("teamId" = current_setting('app.current_team_id', true));

CREATE POLICY relay_team_isolation ON "AuditLog"
  USING ("teamId" = current_setting('app.current_team_id', true))
  WITH CHECK ("teamId" = current_setting('app.current_team_id', true));

CREATE POLICY relay_team_isolation ON "DeliveryLog"
  USING (
    EXISTS (
      SELECT 1 FROM "Route" r
      WHERE r.id = "DeliveryLog"."routeId"
        AND r."teamId" = current_setting('app.current_team_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Route" r
      WHERE r.id = "DeliveryLog"."routeId"
        AND r."teamId" = current_setting('app.current_team_id', true)
    )
  );

CREATE POLICY relay_team_isolation ON "DlqItem"
  USING (
    EXISTS (
      SELECT 1 FROM "Route" r
      WHERE r.id = "DlqItem"."routeId"
        AND r."teamId" = current_setting('app.current_team_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Route" r
      WHERE r.id = "DlqItem"."routeId"
        AND r."teamId" = current_setting('app.current_team_id', true)
    )
  );

-- ─────────────────────────────────────────────────────────────────
-- 3. Prepare (do not wire up) a dedicated, non-bypassing app role.
--
-- This is the actual fix required to make RLS cover the Prisma path -- see
-- docs/rls.md. It is created here, NOLOGIN, with no password, purely so the
-- role exists and is granted the right table privileges ahead of time. No
-- app code or connection string is changed by this migration: the dashboard
-- still connects as `postgres` after this runs, and still bypasses RLS. To
-- actually cut over, an operator must: ALTER ROLE relay_app WITH LOGIN
-- PASSWORD '<secret, out of band>'; then point DATABASE_URL at it; then add
-- the `SET LOCAL app.current_team_id` call in the Prisma query path.
-- ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relay_app') THEN
    CREATE ROLE relay_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO relay_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "Route", "DeliveryLog", "DlqItem", "GateRule", "ApprovalRequest", "AuditLog"
  TO relay_app;

COMMIT;
