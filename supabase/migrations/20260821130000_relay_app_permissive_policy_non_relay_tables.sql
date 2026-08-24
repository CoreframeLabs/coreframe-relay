-- [RELAY-39 / G2a flip] The 16 non-Relay tables (BoxyHQ's own auth/billing/SSO schema:
-- User, Account, Session, VerificationToken, PasswordReset, Team, TeamMember, Invitation,
-- ApiKey, Price, Service, Subscription, jackson_store, jackson_index, jackson_ttl,
-- _prisma_migrations) have RLS ENABLED (from an earlier, undocumented change — not this
-- migration's doing) but carry ZERO policies. `relforcerowsecurity=false` on all of them,
-- so RLS is inert for the table owner, but relay_app is NOT the owner and does not bypass
-- RLS (`rolbypassrls=false`, by design — see RELAY-39's own migration). Enabled-with-no-
-- policy is deny-all for any such role.
--
-- This was flagged as a real risk in RELAY-39's own notes back on 2026-08-05 ("staging had
-- RLS enabled with ZERO policies on all 16 non-Relay tables... invisible while connecting
-- as postgres") but the flip itself was never attempted against production until
-- 2026-08-21, when it broke signup immediately: `new row violates row-level security
-- policy for table "User"` on `prisma.user.create()`. Confirmed live, not assumed.
--
-- These 16 tables are NOT meant to be tenant-isolated via RLS — they're BoxyHQ's own
-- auth/billing/SSO schema, deliberately excluded from `RLS_PROTECTED_MODELS`
-- (lib/db/scope.ts) and deliberately read via `unscopedPrisma` in `lib/nextAuth.ts`.
-- Access control for these tables is the application's job (NextAuth's own logic,
-- `throwIfNoTeamAccess`/`getCurrentUserWithTeam` in API handlers), not RLS's — RLS on
-- these tables was never a designed control, just an artifact nobody built a policy for.
--
-- Fix: one permissive policy per table, scoped to `relay_app` specifically (not `public`
-- or `authenticated` — this app has no Supabase-Auth-issued JWTs reaching Postgres, so
-- those roles are moot here), restoring exactly the unrestricted behaviour these tables
-- had implicitly while the app ran as `postgres`. RLS stays technically "on" (whatever
-- enabled it in the first place is left alone, not investigated further this pass), but
-- is no longer deny-all for the one non-superuser role that actually needs to use these
-- tables.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'User', 'Account', 'Session', 'VerificationToken', 'PasswordReset',
      'Team', 'TeamMember', 'Invitation', 'ApiKey',
      'Price', 'Service', 'Subscription',
      'jackson_store', 'jackson_index', 'jackson_ttl',
      '_prisma_migrations'
    ])
  LOOP
    EXECUTE format(
      'CREATE POLICY relay_app_full_access ON public.%I FOR ALL TO relay_app USING (true) WITH CHECK (true);',
      t
    );
  END LOOP;
END $$;
