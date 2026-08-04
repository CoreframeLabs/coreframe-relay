-- RELAY-39: make `relay_app` a usable runtime role so RLS actually applies to the
-- app's Prisma traffic.
--
-- RELAY-11 (20260804010000_relay_rls.sql) created `relay_app` NOLOGIN with CRUD on
-- the six Relay tables only. That is not enough to run the application:
--
--   * NOLOGIN  -> it cannot be the target of DATABASE_URL at all.
--   * 6 tables -> the dashboard also reads/writes User, Session, Account, Team,
--                 TeamMember, Invitation, PasswordReset, ApiKey, Subscription,
--                 Service, Price, VerificationToken and the three jackson_*
--                 tables. Measured on the local stack: 22 BASE TABLEs in
--                 `public`, and relay_app held grants on exactly 6 of them.
--                 Repointing DATABASE_URL without this migration takes the whole
--                 app down (NextAuth cannot read `Session`), which is why the
--                 grants are widened here rather than in a follow-up.
--
-- What this migration deliberately does NOT do:
--
--   * It does not set a password. Passwords do not belong in git. The operator
--     issues one out of band:  ALTER ROLE relay_app WITH PASSWORD '<secret>';
--     LOGIN is granted here so that step is the only out-of-band action needed.
--   * It grants NO DDL. relay_app cannot CREATE/ALTER/DROP anything. That is
--     intentional and is the property RELAY-41's "migration role is NOT
--     relay_app" criterion asserts: `prisma migrate deploy` / `db push` must
--     keep using DATABASE_MIGRATION_URL, and will now fail loudly if anyone
--     points them at the runtime credential.
--   * It does not change any policy. RELAY-11's `app.current_team_id` policies
--     are unchanged; this migration only changes WHO is subject to them.
--
-- See docs/rls.md for the measurements behind all of the above, including the
-- transaction-pooler behaviour that dictates how the setting must be applied.

BEGIN;

-- ─────────────────────────────────────────────────────────────────
-- 1. Let the role log in.
--
-- No password here on purpose (see header). A role with LOGIN and no password
-- cannot authenticate under scram-sha-256, so this statement on its own does
-- not widen access; it only removes the NOLOGIN attribute that made the role
-- unusable as a connection target.
--
-- NOSUPERUSER / NOBYPASSRLS are NOT restated here even though they are the two
-- attributes this ticket cares most about. Measured on both stacks: `postgres`
-- is not a superuser (it holds CREATEROLE), and CREATEROLE is not permitted to
-- set the SUPERUSER or BYPASSRLS attributes even to their existing values --
-- naming them fails the whole migration with
--   "ERROR: permission denied to alter role (SQLSTATE 42501)".
-- The role is already NOSUPERUSER NOBYPASSRLS from RELAY-11's CREATE ROLE, and
-- the DO block in section 3 verifies that rather than trying to re-impose it.
-- ─────────────────────────────────────────────────────────────────

ALTER ROLE relay_app WITH LOGIN NOCREATEDB NOCREATEROLE;

-- ─────────────────────────────────────────────────────────────────
-- 2. Runtime DML across the whole application schema.
--
-- SELECT/INSERT/UPDATE/DELETE only. No TRUNCATE (it bypasses RLS row-by-row
-- semantics entirely and no application code path truncates), no REFERENCES,
-- no TRIGGER.
-- ─────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA public TO relay_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA public
  TO relay_app;

-- PasswordReset.id and jackson_index.id are the only two sequences in `public`
-- (measured, not assumed). An INSERT into either fails with "permission denied
-- for sequence" without this, which surfaces as a broken password-reset flow.
GRANT USAGE, SELECT
  ON ALL SEQUENCES IN SCHEMA public
  TO relay_app;

-- Tables created later by `prisma migrate deploy` (which runs as the migration
-- role, not this one) would otherwise be invisible to relay_app until someone
-- remembered to re-grant. FOR ROLE postgres because that is the role that owns
-- everything Prisma creates on this stack.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO relay_app;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO relay_app;

-- ─────────────────────────────────────────────────────────────────
-- 3. Re-assert the properties the whole ticket depends on.
--
-- If any of these ever stop holding, RLS silently goes inert again exactly the
-- way RELAY-11 found it, with no error anywhere. `__tests__/lib/rls.spec.ts`
-- asserts the same three facts against the live runtime connection, so the
-- regression is caught by the test suite and not only here.
-- ─────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r record;
BEGIN
  SELECT rolsuper, rolbypassrls, rolcanlogin INTO r
    FROM pg_roles WHERE rolname = 'relay_app';

  IF r IS NULL THEN
    RAISE EXCEPTION 'relay_app is missing; 20260804010000_relay_rls.sql must run first';
  END IF;
  IF r.rolsuper THEN
    RAISE EXCEPTION 'relay_app is SUPERUSER - it would bypass RLS';
  END IF;
  IF r.rolbypassrls THEN
    RAISE EXCEPTION 'relay_app has BYPASSRLS - RLS would be inert, which is the entire bug RELAY-39 exists to fix';
  END IF;
  IF NOT r.rolcanlogin THEN
    RAISE EXCEPTION 'relay_app still cannot log in';
  END IF;
END
$$;

COMMIT;
