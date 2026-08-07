/**
 * @jest-environment node
 */

/**
 * [RELAY-39] Row Level Security, proven against a live database.
 *
 * WHY THIS SUITE EXISTS AT ALL
 * ----------------------------
 * RELAY-11 shipped RLS policies on six tables and then reported honestly that
 * they were INERT, because the app connected as `postgres` (`rolbypassrls=t`)
 * and a role attribute cannot be overridden by `FORCE ROW LEVEL SECURITY`.
 * Every assertion in this file is written so that the RELAY-11 state FAILS it.
 * If someone repoints the connection back at `postgres`, or drops the scope
 * extension, or a future migration hands `relay_app` BYPASSRLS, these tests go
 * red rather than the control quietly going inert again.
 *
 * WHAT IT CONNECTS TO
 * -------------------
 * A real Postgres. There is nothing to mock here: the entire control lives in
 * the database, so a mocked client would prove precisely nothing. Configure
 * with one of, in order of precedence:
 *
 *   RLS_TEST_DATABASE_URL         explicit override (used to point at hosted)
 *   RELAY_APP_DATABASE_URL_LOCAL  the local Supabase stack (default)
 *   RELAY_APP_DATABASE_URL        the hosted project, via Supavisor :6543
 *
 * If none is set the suite SKIPS with a loud message rather than passing
 * vacuously -- a security test that silently no-ops is worse than no test.
 */

import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { createScopedPrismaClient } from '@/lib/db/scoped-client';
import { withTeamScope, currentTeamId } from '@/lib/db/scope';

const DATABASE_URL =
  process.env.RLS_TEST_DATABASE_URL ||
  process.env.RELAY_APP_DATABASE_URL_LOCAL ||
  process.env.RELAY_APP_DATABASE_URL;

// A unique prefix per run. The hosted project is about to take real signups, so
// fixtures must be unmistakable and must not collide between concurrent runs.
const RUN = randomUUID().slice(0, 8);
const TEAM_A = `rls-test-a-${RUN}`;
const TEAM_B = `rls-test-b-${RUN}`;
const ROUTE_A = `rls-route-a-${RUN}`;
const ROUTE_B = `rls-route-b-${RUN}`;

const describeIfConfigured = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[RELAY-39] RLS suite SKIPPED: no RLS_TEST_DATABASE_URL / ' +
      'RELAY_APP_DATABASE_URL_LOCAL / RELAY_APP_DATABASE_URL set. ' +
      'This suite is the only proof that tenant isolation is enforced by the ' +
      'database rather than by every Prisma query remembering `where teamId`.\n'
  );
}

jest.setTimeout(120_000); // the hosted pooler is a network round trip away

describeIfConfigured('[RELAY-39] RLS is enforced by Postgres, not by Prisma', () => {
  let base: PrismaClient;
  let db: ReturnType<typeof createScopedPrismaClient>['scoped'];

  beforeAll(async () => {
    const clients = createScopedPrismaClient(DATABASE_URL as string);
    base = clients.base;
    db = clients.scoped;

    // Team has no RLS policy, so fixtures for it go through the base client.
    await base.team.createMany({
      data: [
        { id: TEAM_A, name: 'RLS Test A', slug: TEAM_A },
        { id: TEAM_B, name: 'RLS Test B', slug: TEAM_B },
      ],
      skipDuplicates: true,
    });

    // Route DOES have a policy, including WITH CHECK, so these inserts only
    // succeed from inside the right scope. That makes fixture creation itself a
    // positive control: if scoping were broken, setup would fail rather than the
    // assertions passing for the wrong reason.
    await withTeamScope(TEAM_A, () =>
      db.route.create({
        data: {
          id: ROUTE_A,
          teamId: TEAM_A,
          name: 'A',
          slug: `a-${RUN}`,
          destination: 'https://a.example.com/hook',
          ingestToken: `rls-test-token-a-${RUN}`,
        },
      })
    );
    await withTeamScope(TEAM_B, () =>
      db.route.create({
        data: {
          id: ROUTE_B,
          teamId: TEAM_B,
          name: 'B',
          slug: `b-${RUN}`,
          destination: 'https://b.example.com/hook',
          ingestToken: `rls-test-token-b-${RUN}`,
        },
      })
    );
  });

  afterAll(async () => {
    // Sweep by PREFIX, not just this run's two ids. Learned the hard way: an
    // earlier hosted run was killed by a harness timeout before afterAll could
    // run and left `rls-test-a-8e9648d7` / `rls-test-b-8e9648d7` and their
    // routes behind on the project that is about to take real signups. A run
    // that is interrupted cannot clean up after itself, so the NEXT run has to.
    //
    // Team deletes cascade to Route (FK enforcement runs as the system, not
    // under the caller's policies), so this removes the routes too.
    await base.team.deleteMany({ where: { slug: { startsWith: 'rls-test-' } } });
    await base.$disconnect();
  });

  // ───────────────────────────────────────────────────────────────
  // Criterion: "App connects as relay_app; a test asserts the runtime role has
  // rolbypassrls=false."
  //
  // This is the assertion RELAY-11 could not make. It is first because every
  // other test in this file is meaningless if it fails: with BYPASSRLS the
  // policies are decorative and all the isolation assertions below would pass
  // or fail for reasons unrelated to RLS.
  // ───────────────────────────────────────────────────────────────
  describe('the runtime connection role', () => {
    it('is a role that cannot bypass RLS', async () => {
      const [role] = await base.$queryRawUnsafe<
        { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
      >(
        `SELECT current_user,
                (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS rolsuper,
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls`
      );

      // eslint-disable-next-line no-console
      console.log('[RELAY-39] runtime role:', role);

      expect(role.current_user).toBe('relay_app');
      expect(role.rolbypassrls).toBe(false);
      expect(role.rolsuper).toBe(false);
    });

    it('still has RLS enabled AND forced on all six Relay tables', async () => {
      const rows = await base.$queryRawUnsafe<
        { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname IN ('Route','DeliveryLog','DlqItem','GateRule','ApprovalRequest','AuditLog')
          ORDER BY c.relname`
      );

      expect(rows).toHaveLength(6);
      for (const r of rows) {
        expect(r.relrowsecurity).toBe(true);
        expect(r.relforcerowsecurity).toBe(true);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Criterion: "A forgotten `where teamId` returns zero rows rather than
  // another team's data."
  //
  // These queries pass NO teamId filter at all -- they are what a careless
  // future query looks like. Under RELAY-11's shipped state (connected as
  // `postgres`) the first of these returned every row in the table.
  // ───────────────────────────────────────────────────────────────
  describe('a query that forgets its teamId filter', () => {
    it('returns only the scoped team, not the whole table', async () => {
      const rows = await withTeamScope(TEAM_A, () =>
        db.route.findMany({ where: { id: { in: [ROUTE_A, ROUTE_B] } } })
      );

      expect(rows.map((r) => r.id)).toEqual([ROUTE_A]);
      expect(rows).toHaveLength(1);
    });

    it('returns zero rows for another team even given that row’s real id', async () => {
      // This is the IDOR shape: a valid, existing id belonging to someone else.
      // `models/route.ts` normally defends this with `where: { id, teamId }`.
      // Here the teamId is DELIBERATELY OMITTED so that RLS is the only defence
      // left standing -- which is exactly what the acceptance criterion asks to
      // be proven rather than assumed.
      const byId = await withTeamScope(TEAM_A, () =>
        db.route.findFirst({ where: { id: ROUTE_B } })
      );
      expect(byId).toBeNull();

      const many = await withTeamScope(TEAM_A, () =>
        db.route.findMany({ where: { id: ROUTE_B } })
      );
      expect(many).toHaveLength(0);
    });

    it('returns the row when it IS the scoped team (positive control)', async () => {
      // Without this, "returns nothing" would be indistinguishable from a
      // deny-all policy that isolates no one from anything.
      const mine = await withTeamScope(TEAM_A, () =>
        db.route.findFirst({ where: { id: ROUTE_A } })
      );
      expect(mine?.id).toBe(ROUTE_A);
      expect(mine?.teamId).toBe(TEAM_A);
    });

    it('cannot write across tenants either', async () => {
      // updateMany matching on the primary key alone, no teamId. WITH CHECK and
      // USING both apply, so the row is not even visible to be updated.
      const { count } = await withTeamScope(TEAM_A, () =>
        db.route.updateMany({ where: { id: ROUTE_B }, data: { name: 'hijacked' } })
      );
      expect(count).toBe(0);

      const untouched = await base.route.findFirst({
        where: { id: ROUTE_B },
        select: { name: true },
      });
      // Read back through the base client under Team B's own scope to confirm.
      const asB = await withTeamScope(TEAM_B, () =>
        db.route.findFirst({ where: { id: ROUTE_B }, select: { name: true } })
      );
      expect(asB?.name).toBe('B');
      expect(untouched === null || untouched.name === 'B').toBe(true);

      // And an INSERT claiming another team's id is rejected by WITH CHECK.
      await expect(
        withTeamScope(TEAM_A, () =>
          db.route.create({
            data: {
              teamId: TEAM_B,
              name: 'smuggled',
              slug: `smuggled-${RUN}`,
              destination: 'https://evil.example.com/hook',
              ingestToken: `rls-test-token-smuggled-${RUN}`,
            },
          })
        )
      ).rejects.toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Criterion: "app.current_team_id is set from the SESSION, never from a
  // request parameter".
  //
  // The negative case: no scope at all must deny, not allow. This is what makes
  // the extension safe to fail -- a forgotten `withTeamScope` loses data
  // visibility, it does not gain any.
  // ───────────────────────────────────────────────────────────────
  describe('with no scope set', () => {
    it('denies by default rather than returning everything', async () => {
      expect(currentTeamId()).toBeUndefined();

      const rows = await db.route.findMany({
        where: { id: { in: [ROUTE_A, ROUTE_B] } },
      });
      expect(rows).toHaveLength(0);
    });

    it('rejects an empty team id instead of scoping to nothing silently', () => {
      expect(() => withTeamScope('', async () => null)).toThrow(
        /non-empty string/
      );
    });

    it('keeps the scope alive across the await that triggers the extension', async () => {
      // Regression test for a real bug found building this ticket. A Prisma
      // extension's query hook fires when the PrismaPromise is AWAITED, not
      // when the model method is called. `withTeamScope` therefore has to await
      // inside the AsyncLocalStorage store; with the naive
      // `storage.run(store, fn)` the promise is created in scope but resolved
      // out of it, `currentTeamId()` returns undefined, and every query
      // silently returns zero rows. This asserts the fix from the outside: the
      // callback returns the un-awaited promise, which is exactly the shape
      // that used to fail.
      const rows = await withTeamScope(TEAM_A, () =>
        db.route.findMany({ where: { id: ROUTE_A } })
      );
      expect(rows).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Criterion: "cannot leak between pooled connections -- proven by a
  // concurrent test, not by inspection."
  //
  // This is the criterion that cannot be satisfied by reading code. The failure
  // mode is a shared mutable scope (a module-level variable, or a session-level
  // `SET` pinned to a pooled server connection) where request A's scope is
  // observed by request B. It only appears when requests genuinely interleave.
  // ───────────────────────────────────────────────────────────────
  describe('under concurrency', () => {
    it('never serves one team’s scope to another team’s query', async () => {
      const ITERATIONS = 60;

      const work = Array.from({ length: ITERATIONS }, (_, i) => {
        const mine = i % 2 === 0 ? TEAM_A : TEAM_B;
        const myRoute = i % 2 === 0 ? ROUTE_A : ROUTE_B;
        const theirRoute = i % 2 === 0 ? ROUTE_B : ROUTE_A;

        return withTeamScope(mine, async () => {
          // A jittered await INSIDE the scope. This is the important detail:
          // it forces the async call trees to interleave, so if scope were held
          // in shared state the value would be overwritten mid-flight by
          // another "request". Without a yield here the test can pass on a
          // broken implementation purely because nothing interleaved.
          await new Promise((r) => setTimeout(r, Math.random() * 25));

          const rows = await db.route.findMany({
            where: { id: { in: [ROUTE_A, ROUTE_B] } },
            select: { id: true, teamId: true },
          });

          return { i, mine, myRoute, theirRoute, rows };
        });
      });

      const results = await Promise.all(work);

      // Classify the two failure modes SEPARATELY, because they mean opposite
      // things and a single "violations" count hides that:
      //
      //   LEAKED  -- a row belonging to the other team came back. The scope was
      //              wrong, not absent. This is the cross-tenant data exposure
      //              the whole ticket exists to prevent. Non-zero here is a
      //              security failure.
      //   EMPTY   -- nothing came back. The scope was lost, not crossed
      //              (`current_setting(..., true)` returns NULL rather than
      //              raising, so an unscoped query denies silently). Non-zero
      //              here is a correctness/availability bug in the plumbing --
      //              bad, but it fails closed.
      //
      // Asserting only "non-empty" would pass a leak; asserting only "no leak"
      // would pass a mechanism that silently stopped working. Both are checked.
      const leaked = results.filter((r) =>
        r.rows.some((row) => row.id === r.theirRoute || row.teamId !== r.mine)
      );
      const empty = results.filter((r) => r.rows.length === 0);
      const wrongShape = results.filter(
        (r) => r.rows.length > 1 || (r.rows.length === 1 && r.rows[0].id !== r.myRoute)
      );

      // eslint-disable-next-line no-console
      console.log(
        `[RELAY-39] concurrency: ${ITERATIONS} interleaved queries across 2 tenants -> ` +
          `${leaked.length} LEAKED (other team's rows), ${empty.length} EMPTY (scope lost), ` +
          `${wrongShape.length} wrong-shape`
      );

      expect(leaked).toEqual([]);
      expect(empty).toEqual([]);
      expect(wrongShape).toEqual([]);
      expect(results).toHaveLength(ITERATIONS);
    });

    it('keeps the scope inside chained timer callbacks (the SSE poll shape)', async () => {
      // RELAY-7's `pages/api/teams/[slug]/relay/log-stream.ts` holds ONE HTTP
      // response open for minutes and re-queries on a chained setTimeout. That
      // is a genuinely different shape from a request/response handler, and it
      // is worth proving rather than assuming, because if AsyncLocalStorage did
      // NOT propagate into timer callbacks the stream would authenticate
      // correctly and then silently emit an empty feed forever.
      //
      // Note what this does NOT need: the long-lived thing is the HTTP
      // response, not a database transaction. Each poll is its own short query,
      // so each gets its own `SET LOCAL` inside its own transaction. A
      // connection is never held across the idle gap.
      const seen: { tick: number; ids: string[] }[] = [];

      await withTeamScope(TEAM_A, async () => {
        for (let tick = 0; tick < 3; tick++) {
          // Chained timeout, exactly as the SSE endpoint schedules its polls.
          await new Promise((resolve) => setTimeout(resolve, 30));
          const rows = await db.route.findMany({
            where: { id: { in: [ROUTE_A, ROUTE_B] } },
            select: { id: true },
          });
          seen.push({ tick, ids: rows.map((r) => r.id) });
        }
      });

      // eslint-disable-next-line no-console
      console.log('[RELAY-39] SSE-shaped polls:', JSON.stringify(seen));

      expect(seen).toHaveLength(3);
      for (const s of seen) {
        expect(s.ids).toEqual([ROUTE_A]);
      }
    });

    it('does not leave the setting behind on a pooled connection', async () => {
      // The direct check on the leak measured on Supavisor: after scoped work
      // completes, an UNSCOPED query on the same pool must see nothing. If the
      // extension had used a session-level `SET` instead of set_config(...,
      // local), the setting would still be pinned to a pooled server connection
      // and this would return Team A's row.
      await withTeamScope(TEAM_A, () =>
        db.route.findMany({ where: { id: ROUTE_A } })
      );

      const after = await Promise.all(
        Array.from({ length: 20 }, () =>
          base.$queryRawUnsafe<{ v: string | null }[]>(
            `SELECT current_setting('app.current_team_id', true) AS v`
          )
        )
      );

      const stale = after.flat().filter((r) => r.v !== null && r.v !== '');
      // eslint-disable-next-line no-console
      console.log(
        `[RELAY-39] pool residue: ${stale.length} of ${after.length} connections carried a stale scope`
      );
      expect(stale).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────
  // Criterion: "Connection-pool overhead measured and recorded; the
  // transaction-per-request cost is stated, not assumed."
  //
  // This asserts almost nothing on purpose -- it is a measurement, and a
  // threshold here would just be a flaky test on a shared network. It PRINTS
  // the numbers so CI logs carry them, and the recorded values live in
  // docs/rls.md.
  // ───────────────────────────────────────────────────────────────
  describe('cost of the transaction wrapper', () => {
    it('measures scoped vs unscoped query latency', async () => {
      const N = 50;

      const time = async (label: string, fn: () => Promise<unknown>) => {
        await fn(); // discard the first, it pays connection setup
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < N; i++) await fn();
        const t1 = process.hrtime.bigint();
        const perOp = Number(t1 - t0) / 1e6 / N;
        // eslint-disable-next-line no-console
        console.log(`[RELAY-39] ${label}: ${perOp.toFixed(2)} ms/query (n=${N})`);
        return perOp;
      };

      // Unscoped: a plain findMany, one round trip, no BEGIN/COMMIT. This is
      // what every Relay query costs today, before this ticket.
      const bare = await time('unscoped findMany (no transaction)', () =>
        base.route.findMany({ where: { teamId: TEAM_A } })
      );

      // Scoped: set_config + findMany inside one batch transaction. This is
      // what every Relay query costs after this ticket.
      const scoped = await time('scoped findMany (set_config + query in txn)', () =>
        withTeamScope(TEAM_A, () => db.route.findMany({}))
      );

      // eslint-disable-next-line no-console
      console.log(
        `[RELAY-39] overhead: +${(scoped - bare).toFixed(2)} ms/query ` +
          `(${(((scoped - bare) / bare) * 100).toFixed(0)}% of baseline)`
      );

      // Concurrency sanity: the wrapper must not serialise. 30 scoped queries
      // in parallel should take far less than 30x one query. An interactive
      // transaction holding a pooled connection across awaits is the shape that
      // fails this.
      const P = 30;
      const p0 = process.hrtime.bigint();
      await Promise.all(
        Array.from({ length: P }, () =>
          withTeamScope(TEAM_A, () => db.route.findMany({}))
        )
      );
      const p1 = process.hrtime.bigint();
      const wall = Number(p1 - p0) / 1e6;
      // eslint-disable-next-line no-console
      console.log(
        `[RELAY-39] ${P} scoped queries in parallel: ${wall.toFixed(0)} ms wall ` +
          `(serialised would be ~${(scoped * P).toFixed(0)} ms)`
      );

      expect(wall).toBeLessThan(scoped * P);
      expect(scoped).toBeGreaterThan(0);
    });
  });
});
