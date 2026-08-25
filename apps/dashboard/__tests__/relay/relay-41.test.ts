/**
 * @jest-environment node
 */

/**
 * [RELAY-41] The migration role is NOT `relay_app` — proven against a live database.
 *
 * WHY THIS SUITE EXISTS
 * ----------------------
 * `apps/dashboard/scripts/build.sh` already refuses to run `prisma db push` against a
 * hosted host, and `.github/workflows/migrate.yml` already runs `prisma migrate deploy`
 * against `secrets.DATABASE_MIGRATION_URL`, a credential the workflow's own comment says
 * is "distinct from RELAY_APP_DATABASE_URL / the deployed app's DATABASE_URL (relay_app,
 * granted NO DDL by 20260804120000_relay_app_login_and_grants.sql)". Both of those are
 * real, but neither is PROVEN — a comment can drift out of true the moment someone points
 * a secret at the wrong value, and nothing before this file would notice. This is that
 * proof, in the same style `__tests__/lib/rls.spec.ts` uses for the RLS half of the same
 * migration: query the live database directly, because the property lives there and a
 * mocked client would assert nothing.
 *
 * TWO TIERS, DELIBERATELY
 * ------------------------
 * Tier 1 (`static configuration`) needs no database and always runs — it is the "at
 * minimum" floor this ticket's own instructions call for: the two credentials must be
 * configured as genuinely distinct env vars, checked by reading `migrate.yml` itself and
 * by refusing to pass if both variables happen to be set to the same value in the CURRENT
 * process (the shape of mistake a copy-pasted `.env` produces).
 *
 * Tier 2 (`the live database`) is the real claim — "that role deliberately lacks DDL
 * rights" — and it SKIPS with a loud message if no migration-capable connection string is
 * configured, exactly like `rls.spec.ts` does for the relay_app-scoped connection. A
 * security test that silently no-ops on a missing env var is worse than no test, so this
 * says so out loud rather than reporting a hollow green run.
 *
 * WHAT IT CONNECTS TO
 * --------------------
 *   RLS_MIGRATION_TEST_DATABASE_URL   explicit override (used to point at hosted)
 *   DATABASE_MIGRATION_URL            the same secret name migrate.yml itself reads
 *   DATABASE_URL                      local dev fallback — .env.example's local Supabase
 *                                      stack connects as `postgres`, which IS today's
 *                                      migration role locally (see the grants migration's
 *                                      own `ALTER DEFAULT PRIVILEGES FOR ROLE postgres`)
 */

import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATION_DATABASE_URL =
  process.env.RLS_MIGRATION_TEST_DATABASE_URL ||
  process.env.DATABASE_MIGRATION_URL ||
  process.env.DATABASE_URL;

const describeIfConfigured = MIGRATION_DATABASE_URL ? describe : describe.skip;

if (!MIGRATION_DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[RELAY-41] migration-role suite SKIPPED: no RLS_MIGRATION_TEST_DATABASE_URL / ' +
      'DATABASE_MIGRATION_URL / DATABASE_URL set. This is the only automated proof that ' +
      'the migration role is not relay_app and genuinely lacks DDL rights.\n'
  );
}

jest.setTimeout(60_000);

// ─────────────────────────────────────────────────────────────────────────
// Tier 1 — static configuration. No database, always runs.
// ─────────────────────────────────────────────────────────────────────────
describe('[RELAY-41] the two credentials are configured as genuinely distinct env vars', () => {
  it('migrate.yml reads a DIFFERENT secret name than the app runtime credential', () => {
    const workflowPath = path.join(__dirname, '../../../../.github/workflows/migrate.yml');
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    // The migration job's DATABASE_URL is sourced from DATABASE_MIGRATION_URL, never
    // from RELAY_APP_DATABASE_URL or a bare DATABASE_URL secret. If a future edit
    // repointed this at the runtime credential, this line would stop matching.
    expect(workflow).toMatch(/DATABASE_URL:\s*\$\{\{\s*secrets\.DATABASE_MIGRATION_URL\s*\}\}/);

    // And the runtime credential's name must never appear as the SOURCE of that
    // assignment — this is the mistake this test exists to catch: someone "simplifying"
    // migrate.yml to reuse the app's own secret because it already exists.
    expect(workflow).not.toMatch(
      /DATABASE_URL:\s*\$\{\{\s*secrets\.RELAY_APP_DATABASE_URL\s*\}\}/
    );
  });

  it('relay_app is granted NO DDL in the grants migration that defines its privileges', () => {
    const grantsPath = path.join(
      __dirname,
      '../../../../supabase/migrations/20260804120000_relay_app_login_and_grants.sql'
    );
    const sql = fs.readFileSync(grantsPath, 'utf8');

    // The only GRANT statements in this file, and the only privileges relay_app is
    // ever given: DML on tables, and USAGE/SELECT on sequences (for auto-increment
    // ids). No CREATE, ALTER, DROP, or TRUNCATE anywhere.
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE\s*\n\s*ON ALL TABLES/);
    expect(sql).not.toMatch(/GRANT[^;]*\b(CREATE|TRUNCATE)\b[^;]*TO relay_app/i);
    expect(sql).not.toMatch(/ALTER ROLE relay_app[^;]*\b(SUPERUSER|CREATEDB|CREATEROLE)\b/i);
  });

  it('refuses if both credentials happen to be set to the identical value in THIS process', () => {
    // The shape of mistake a copy-pasted .env produces: DATABASE_MIGRATION_URL and
    // RELAY_APP_DATABASE_URL both present and equal. Only meaningful when both are
    // actually set — most environments (including this sandbox, most of the time)
    // have neither, which is a different, already-covered gap (Tier 2 below).
    const migration = process.env.DATABASE_MIGRATION_URL;
    const runtime = process.env.RELAY_APP_DATABASE_URL;
    if (migration && runtime) {
      expect(migration).not.toBe(runtime);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tier 2 — the live database. Skips loudly without a configured connection.
// ─────────────────────────────────────────────────────────────────────────
describeIfConfigured('[RELAY-41] the migration role has no DDL rights, relay_app does', () => {
  let migration: PrismaClient;

  beforeAll(() => {
    migration = new PrismaClient({
      datasources: { db: { url: MIGRATION_DATABASE_URL as string } },
    });
  });

  afterAll(async () => {
    await migration.$disconnect();
  });

  // ───────────────────────────────────────────────────────────────
  // Criterion: "A test confirms the migration role is NOT relay_app".
  // ───────────────────────────────────────────────────────────────
  it('the migration connection does not authenticate as relay_app', async () => {
    const [row] = await migration.$queryRawUnsafe<{ current_user: string }[]>(
      `SELECT current_user`
    );

    // eslint-disable-next-line no-console
    console.log('[RELAY-41] migration connection role:', row.current_user);

    expect(row.current_user).not.toBe('relay_app');
  });

  // ───────────────────────────────────────────────────────────────
  // Criterion: "that role deliberately lacks DDL rights" — asserted about relay_app
  // FROM the migration connection, which can see any role's attributes and schema
  // privileges (pg_roles and has_schema_privilege are readable cluster-wide; this does
  // not require literally connecting as relay_app to prove what relay_app can do).
  // ───────────────────────────────────────────────────────────────
  describe('relay_app', () => {
    it('cannot create objects in the public schema (no CREATE privilege)', async () => {
      const [row] = await migration.$queryRawUnsafe<{ can_create: boolean }[]>(
        `SELECT has_schema_privilege('relay_app', 'public', 'CREATE') AS can_create`
      );

      expect(row.can_create).toBe(false);
    });

    it('owns zero tables — nothing it could ALTER or DROP by ownership', async () => {
      const [row] = await migration.$queryRawUnsafe<{ owned: bigint }[]>(
        `SELECT count(*)::bigint AS owned
           FROM pg_tables
          WHERE schemaname = 'public' AND tableowner = 'relay_app'`
      );

      expect(Number(row.owned)).toBe(0);
    });

    it('has none of the role attributes that would grant DDL power outside a GRANT', async () => {
      const [role] = await migration.$queryRawUnsafe<
        { rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }[]
      >(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
           FROM pg_roles WHERE rolname = 'relay_app'`
      );

      expect(role).toBeDefined();
      expect(role.rolsuper).toBe(false);
      expect(role.rolcreatedb).toBe(false);
      expect(role.rolcreaterole).toBe(false);
      // Restated from rls.spec.ts deliberately: BYPASSRLS is a different property
      // (RELAY-39's concern) from DDL (this ticket's), and a regression on either
      // should fail its own suite rather than only the other one's.
      expect(role.rolbypassrls).toBe(false);
    });

    it('only ever holds SELECT/INSERT/UPDATE/DELETE on public tables — a positive control', async () => {
      // Without this, "relay_app can't do X" for an ever-growing list of Xs would
      // never prove relay_app can do anything at all. This is the allow-list this
      // suite expects to still be true; ANY other privilege type appearing here is
      // scope creep on relay_app's grants that this test is designed to catch.
      const rows = await migration.$queryRawUnsafe<{ privilege_type: string }[]>(
        `SELECT DISTINCT privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = 'relay_app' AND table_schema = 'public'
          ORDER BY privilege_type`
      );

      const privileges = rows.map((r) => r.privilege_type).sort();
      expect(privileges).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Positive control: the MIGRATION role itself must actually be able to create
  // objects, or this whole suite would be trivially satisfied by two roles that are
  // both powerless — which proves nothing about relay_app specifically being the
  // restricted one.
  // ───────────────────────────────────────────────────────────────
  it('positive control: the migration role itself CAN create in the public schema', async () => {
    const [row] = await migration.$queryRawUnsafe<{ can_create: boolean }[]>(
      `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create`
    );

    expect(row.can_create).toBe(true);
  });
});
