/**
 * @jest-environment node
 */

/**
 * [RELAY-84] The six Relay handlers, driven end to end against a live Postgres as
 * `relay_app`.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM `rls.spec.ts`
 * --------------------------------------------------
 * RELAY-39's suite proves the MECHANISM: `withTeamScope` + the Prisma extension +
 * the policies isolate two tenants under concurrency. It proves nothing about
 * whether any given HANDLER remembers to call it. Four handlers did; six did not.
 *
 * That gap is not a normal bug. Under `relay_app` (rolbypassrls=f) an unscoped
 * SELECT on a protected table does not raise — `current_setting('app.current_team_id',
 * true)` returns NULL, `"teamId" = NULL` is never true, and the query returns ZERO
 * ROWS with a 200. A customer opening the routes page after the G2a flip would see
 * "no routes", not "access denied". A broken product looks like an empty one, and
 * there is no error to trace. So the acceptance test cannot be "the handler answers
 * 200"; it has to be **"the handler answers 200 with the expected NON-ZERO rows"**.
 *
 * WHY THE CLIENT IS BUILT HERE AND NOT TAKEN FROM `DATABASE_URL`
 * --------------------------------------------------------------
 * `DATABASE_URL` still points at `postgres` (rolbypassrls=t) and will until the
 * director performs G2a. Run against that role, every assertion below would pass
 * whether or not a single handler were wrapped, because RLS is inert on it. So
 * `@/lib/prisma` is MOCKED with a client built explicitly against the `relay_app`
 * credential — the same `createScopedPrismaClient` factory RELAY-39 added for exactly
 * this reason. `describe('the mocked client')` asserts the role really is `relay_app`
 * with `rolbypassrls=false` FIRST, so this suite cannot pass vacuously.
 *
 * Configure with one of, in order of precedence (identical to `rls.spec.ts`):
 *
 *   RLS_TEST_DATABASE_URL
 *   RELAY_APP_DATABASE_URL_LOCAL
 *   RELAY_APP_DATABASE_URL
 *
 * With none set the suite SKIPS loudly rather than passing on nothing.
 *
 * WHAT IS MOCKED, AND WHY THAT DOES NOT WEAKEN THE PROOF
 * ------------------------------------------------------
 * Only two things: `@/lib/prisma` (to force the `relay_app` role — see above) and
 * `models/team`'s two session helpers (there is no NextAuth session in a jest
 * process, and inventing one would test NextAuth rather than RLS). The team ids the
 * mock returns come from real `Team` rows created in `beforeAll`. Everything the
 * ticket is about — the handler bodies, `models/route.ts`, `models/delivery.ts`,
 * `lib/audit.ts`, the Prisma extension, the policies — is the real thing.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { NextApiResponse } from 'next';
import { DeliveryStatus, type PrismaClient } from '@prisma/client';

import { withTeamScope, currentTeamId } from '@/lib/db/scope';

const DATABASE_URL =
  process.env.RLS_TEST_DATABASE_URL ||
  process.env.RELAY_APP_DATABASE_URL_LOCAL ||
  process.env.RELAY_APP_DATABASE_URL;

const RUN = randomUUID().slice(0, 8);
const TEAM_A = `rls-h-a-${RUN}`;
const TEAM_B = `rls-h-b-${RUN}`;
// Real UUIDs, not prefixed strings: `log.ts` validates `routeId` with
// `z.string().uuid()`, so a fixture id like `rls-h-route-b-…` would be rejected as a
// 422 before the query ran — and the cross-tenant case would then be proven by
// input validation rather than by RLS, which is not the same claim at all.
// Cleanup still finds them: `Team` deletes cascade to `Route`.
const ROUTE_A = randomUUID();
const ROUTE_B = randomUUID();

/**
 * Who the mocked session helpers currently say the caller is. Set by `actAs` before
 * each handler invocation. It is a module-level mutable because the mock factory is
 * hoisted above everything and cannot close over per-test state any other way.
 */
let ACTING: { teamId: string; teamSlug: string } = {
  teamId: TEAM_A,
  teamSlug: TEAM_A,
};

const actAs = (teamId: string) => {
  ACTING = { teamId, teamSlug: teamId };
};

// ── The one mock that makes this suite mean anything ────────────────────────────
// Replaces the app's `DATABASE_URL`-derived client with one bound to `relay_app`.
// The extension applied is the SAME `withTeamScopeExtension` the app uses, so what
// is under test is the handler's use of `withTeamScope`, not a test-only variant.
// NOTE: the mock target is written as a RELATIVE path, not `@/lib/prisma`.
// `jest.mock` does not resolve the tsconfig `@/…` alias here (measured: "Cannot find
// module '@/lib/prisma'"), while a static `import` does. Both forms resolve to the
// same absolute file, so the handlers' own `import { prisma } from '@/lib/prisma'`
// still receives this mock — the module registry is keyed by resolved path.
jest.mock('../../lib/prisma', () => {
  const url =
    process.env.RLS_TEST_DATABASE_URL ||
    process.env.RELAY_APP_DATABASE_URL_LOCAL ||
    process.env.RELAY_APP_DATABASE_URL;

  if (!url) {
    // Nothing to bind to; the suite is skipped anyway. Fall through to the real
    // module so importing it does not explode during collection.
    return jest.requireActual('../../lib/prisma');
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createScopedPrismaClient } = require('../../lib/db/scoped-client');
  const clients = createScopedPrismaClient(url);

  return {
    prisma: clients.scoped,
    unscopedPrisma: clients.base,
    // Handed to the suite for fixtures and for the role assertion.
    __testClients: clients,
  };
});

// ── [RELAY-84] The 7th call site's collaborator. ─────────────────────────────────
// `consumeEnvelope` forwards to a real URL before it records anything. That HTTP
// call is not an RLS concern, and letting it run would make this suite depend on
// DNS and on the SSRF validator's behaviour for `example.com`. Stubbed so the test
// is about the only thing RELAY-84 claims: that the consumer can SEE its own route
// under `relay_app`, and that the DeliveryLog row it writes actually lands.
jest.mock('../../lib/relay/forward', () => ({
  forwardToDestination: jest.fn(async () => ({
    ok: true,
    responseCode: 200,
    latencyMs: 12,
  })),
}));

// ── Session helpers. No NextAuth in a jest process; the ids are real Team rows. ──
jest.mock('../../models/team', () => ({
  throwIfNoTeamAccess: jest.fn(async () => ({
    teamId: ACTING.teamId,
    role: 'OWNER',
  })),
  getCurrentUserWithTeam: jest.fn(async () => ({
    id: `user-${ACTING.teamId}`,
    email: `owner@${ACTING.teamId}.example.com`,
    role: 'OWNER',
    team: { id: ACTING.teamId, slug: ACTING.teamSlug },
  })),
}));

// Plain `import`s, not `require`s: the transform hoists the `jest.mock` calls above
// every import in this file, so these modules are already looking at the mocked
// `lib/prisma` by the time they are evaluated. The `describe('the client these
// handlers are running on')` block asserts that hoisting actually happened, by
// checking `current_user` is `relay_app` and not `postgres`.
import routesIndexHandler from '../../pages/api/teams/[slug]/relay/routes/index';
import destinationHeadersHandler from '../../pages/api/teams/[slug]/relay/routes/[routeId]/destination-headers';
import rotateTokenHandler from '../../pages/api/teams/[slug]/relay/routes/[routeId]/rotate-token';
import testSendHandler from '../../pages/api/teams/[slug]/relay/routes/[routeId]/test-send';
import logHandler from '../../pages/api/teams/[slug]/relay/log';
import logStreamHandler from '../../pages/api/teams/[slug]/relay/log-stream';
import { fetchRoutes } from '../../models/route';
import {
  fetchTeamDeliveryFeed,
  assertRouteBelongsToTeam,
} from '../../models/delivery';
import { consumeEnvelope } from '../../lib/relay/consume';
import * as prismaModule from '../../lib/prisma';

/**
 * The mock's extra export. Not on the real module's type, so the cast is the honest
 * way to reach it — an `any` here would hide a typo in the property name, which is
 * exactly the mistake that would leave this suite running on `postgres`.
 */
const testClients = (
  prismaModule as unknown as {
    __testClients?: { base: PrismaClient; scoped: PrismaClient };
  }
).__testClients;

/* ────────────────────────────────────────────────────────────────────────────────
 * Minimal req/res doubles.
 *
 * Deliberately hand-rolled rather than pulled from a mocking library: RELAY-62
 * forbids adding a dependency, and what these need to record is narrow — a status,
 * a JSON body, and for the SSE case the raw frames written to the socket.
 * ──────────────────────────────────────────────────────────────────────────────── */

type CapturedRes = {
  statusCode: number | null;
  body: any;
  headers: Record<string, string>;
  /** Raw SSE frames, in order. */
  written: string[];
  writableEnded: boolean;
} & Record<string, any>;

/**
 * The double implements the handful of `ServerResponse` members these handlers
 * actually touch, not the other ~65. The cast is therefore load-bearing rather than
 * lazy: without it `tsc --noEmit` fails on every handler call below, and `npm run
 * check-types` is part of `test-all`. Kept as a single cast HERE, in the factory, so
 * no call site needs an `as any` — a per-call `any` would also silence a genuinely
 * wrong argument, which is the mistake this file cannot afford to make.
 */
function mockRes(): CapturedRes & NextApiResponse {
  const res: any = {
    statusCode: null,
    body: undefined,
    headers: {},
    written: [],
    writableEnded: false,
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: any) => {
    res.body = payload;
    return res;
  };
  res.setHeader = (k: string, v: string) => {
    res.headers[k] = v;
    return res;
  };
  res.writeHead = (code: number, headers?: Record<string, string>) => {
    res.statusCode = code;
    Object.assign(res.headers, headers ?? {});
    return res;
  };
  res.flushHeaders = () => undefined;
  res.write = (chunk: string) => {
    res.written.push(chunk);
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
    return res;
  };
  res.on = () => res;
  res.socket = { setKeepAlive: () => undefined, setTimeout: () => undefined };
  return res as unknown as CapturedRes & NextApiResponse;
}

function mockReq(init: {
  method: string;
  query?: Record<string, any>;
  body?: any;
}): any {
  const req: any = new EventEmitter();
  req.method = init.method;
  req.query = init.query ?? {};
  req.body = init.body;
  req.headers = {};
  return req;
}

/** Parse the `event:`/`data:` frames an SSE handler wrote. */
function parseSse(frames: string[]): { event: string; data: any }[] {
  const out: { event: string; data: any }[] = [];
  for (const frame of frames) {
    const eventLine = frame.match(/^event: (.+)$/m);
    const dataLine = frame.match(/^data: (.+)$/m);
    if (!eventLine || !dataLine) continue; // heartbeat comment line
    out.push({ event: eventLine[1], data: JSON.parse(dataLine[1]) });
  }
  return out;
}

const describeIfConfigured = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  console.warn(
    '\n[RELAY-84] handler RLS suite SKIPPED: no RLS_TEST_DATABASE_URL / ' +
      'RELAY_APP_DATABASE_URL_LOCAL / RELAY_APP_DATABASE_URL set. ' +
      'Without it there is no evidence that the six wrapped handlers return ' +
      'non-zero rows under the runtime role, which is the whole precondition of ' +
      'the G2a DATABASE_URL flip.\n'
  );
}

jest.setTimeout(120_000);

describeIfConfigured(
  '[RELAY-84] Relay handlers under the relay_app role',
  () => {
    let base: PrismaClient;
    let scoped: PrismaClient;

    /**
     * A route's stored ingest token, read under an explicit scope. Throws rather than
     * returning null so a lost scope shows up as a named failure here instead of as a
     * confusing `undefined` three assertions later.
     */
    const tokenOf = async (
      teamId: string,
      routeId: string
    ): Promise<string> => {
      const row = await withTeamScope(teamId, () =>
        scoped.route.findFirst({
          where: { id: routeId },
          select: { ingestToken: true },
        })
      );
      if (!row) {
        throw new Error(`route ${routeId} not visible under scope ${teamId}`);
      }
      return row.ingestToken;
    };

    beforeAll(async () => {
      const clients = testClients!;
      base = clients.base;
      scoped = clients.scoped;

      // `Team` carries no RLS policy, so fixtures for it go through the base client.
      await base.team.createMany({
        data: [
          { id: TEAM_A, name: 'RLS Handler A', slug: TEAM_A },
          { id: TEAM_B, name: 'RLS Handler B', slug: TEAM_B },
        ],
        skipDuplicates: true,
      });

      // Routes and deliveries go in through the SCOPED client, which means fixture
      // creation is itself a positive control: `Route`'s WITH CHECK rejects an insert
      // made outside the right scope, so if scoping were broken setup would fail
      // loudly rather than the assertions passing for the wrong reason.
      await withTeamScope(TEAM_A, () =>
        scoped.route.create({
          data: {
            id: ROUTE_A,
            teamId: TEAM_A,
            name: 'Handler A',
            slug: `handler-a-${RUN}`,
            destination: 'https://a.example.com/hook',
            ingestToken: `rls-h-token-a-${RUN}`,
          },
        })
      );
      await withTeamScope(TEAM_B, () =>
        scoped.route.create({
          data: {
            id: ROUTE_B,
            teamId: TEAM_B,
            name: 'Handler B',
            slug: `handler-b-${RUN}`,
            destination: 'https://b.example.com/hook',
            ingestToken: `rls-h-token-b-${RUN}`,
          },
        })
      );

      await withTeamScope(TEAM_A, () =>
        scoped.deliveryLog.create({
          data: {
            routeId: ROUTE_A,
            requestId: `rls-h-req-a-${RUN}`,
            status: DeliveryStatus.DELIVERED,
            attemptCount: 1,
            responseCode: 200,
          },
        })
      );
      await withTeamScope(TEAM_B, () =>
        scoped.deliveryLog.create({
          data: {
            routeId: ROUTE_B,
            requestId: `rls-h-req-b-${RUN}`,
            status: DeliveryStatus.DELIVERED,
            attemptCount: 1,
            responseCode: 200,
          },
        })
      );
    });

    afterAll(async () => {
      // Sweep by PREFIX, not by this run's ids. A run killed by a harness timeout
      // cannot clean up after itself, so the next one has to — the same lesson
      // `rls.spec.ts` records. Team deletes cascade to Route → DeliveryLog.
      await base.team.deleteMany({ where: { slug: { startsWith: 'rls-h-' } } });
      await base.$disconnect();
    });

    beforeEach(() => actAs(TEAM_A));

    /* ─────────────────────────────────────────────────────────────────────────────
     * 0. The suite cannot pass vacuously.
     * ───────────────────────────────────────────────────────────────────────────── */
    describe('the client these handlers are running on', () => {
      it('is relay_app, and cannot bypass RLS', async () => {
        const [role] = await base.$queryRawUnsafe<
          { current_user: string; rolbypassrls: boolean; rolsuper: boolean }[]
        >(
          `SELECT current_user,
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls,
                (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS rolsuper`
        );
        console.log('[RELAY-84] handler-suite runtime role:', role);

        expect(role.current_user).toBe('relay_app');
        expect(role.rolbypassrls).toBe(false);
        expect(role.rolsuper).toBe(false);
      });

      it('returns ZERO rows — not an error — when nothing sets the scope', async () => {
        // The negative control, and the reason every assertion below is written as a
        // ROW COUNT. This is precisely what an UNWRAPPED handler does after G2a: it
        // succeeds, and it returns nothing.
        expect(currentTeamId()).toBeUndefined();

        const routes = await fetchRoutes(TEAM_A);
        const feed = await fetchTeamDeliveryFeed(TEAM_A, {}, 200);

        console.log(
          `[RELAY-84] unwrapped baseline: fetchRoutes -> ${routes.length} rows, ` +
            `fetchTeamDeliveryFeed -> ${feed.length} rows (both threw nothing)`
        );

        expect(routes).toHaveLength(0);
        expect(feed).toHaveLength(0);
      });
    });

    /* ─────────────────────────────────────────────────────────────────────────────
     * 1. routes/index.ts
     * ───────────────────────────────────────────────────────────────────────────── */
    describe('GET/POST /api/teams/:slug/relay/routes', () => {
      it('GET returns the team’s OWN routes, non-zero', async () => {
        const req = mockReq({ method: 'GET', query: { slug: TEAM_A } });
        const res = mockRes();

        await routesIndexHandler(req, res);

        expect(res.statusCode).toBe(200);
        const ids = res.body.data.map((r: any) => r.id);
        console.log(`[RELAY-84] routes GET (team A): ${ids.length} rows`);
        expect(ids).toContain(ROUTE_A);
        expect(ids.length).toBeGreaterThan(0);
      });

      it('GET does not return the other team’s routes', async () => {
        const req = mockReq({ method: 'GET', query: { slug: TEAM_A } });
        const res = mockRes();
        await routesIndexHandler(req, res);

        expect(res.body.data.map((r: any) => r.id)).not.toContain(ROUTE_B);
        for (const row of res.body.data) {
          expect(row.teamId).toBe(TEAM_A);
        }
      });

      it('GET as the OTHER team returns that team’s routes, non-zero', async () => {
        // Symmetry matters: "team A sees only A" is also satisfied by a policy that
        // denies everyone. This proves B is served too.
        actAs(TEAM_B);
        const req = mockReq({ method: 'GET', query: { slug: TEAM_B } });
        const res = mockRes();
        await routesIndexHandler(req, res);

        const ids = res.body.data.map((r: any) => r.id);
        expect(ids).toContain(ROUTE_B);
        expect(ids).not.toContain(ROUTE_A);
      });

      it('POST creates a route — the INSERT passes the policy’s WITH CHECK', async () => {
        // An unscoped INSERT on `Route` is not a zero-row read; it is a hard
        // "new row violates row-level security policy" (SQLSTATE 42501). So this
        // asserts the write arm of the wrap, which the read tests cannot.
        const req = mockReq({
          method: 'POST',
          query: { slug: TEAM_A },
          body: {
            name: `Created ${RUN}`,
            destination: 'https://created.example.com/hook',
            maxRetries: 3,
          },
        });
        const res = mockRes();

        await routesIndexHandler(req, res);

        expect(res.statusCode).toBe(201);
        expect(res.body.data.teamId).toBe(TEAM_A);
        expect(typeof res.body.data.relayUrl).toBe('string');

        // And it is visible on the very next GET, through the same scope.
        const getRes = mockRes();
        await routesIndexHandler(
          mockReq({ method: 'GET', query: { slug: TEAM_A } }),
          getRes
        );
        expect(getRes.body.data.map((r: any) => r.id)).toContain(
          res.body.data.id
        );
      });
    });

    /* ─────────────────────────────────────────────────────────────────────────────
     * 2. routes/[routeId]/destination-headers.ts — including the inline Prisma query
     * ───────────────────────────────────────────────────────────────────────────── */
    describe('/api/teams/:slug/relay/routes/:routeId/destination-headers', () => {
      it('PUT then GET round-trips the header NAMES through the inline query', async () => {
        // This is the assertion that covers `routeWithHeadersCiphertext` — the one
        // Prisma call in the Relay path that lives outside `models/`. It reads
        // `Route.destinationHeadersEncrypted` directly. Unscoped it resolves to
        // `null`, `destinationHeaderNames(null)` is `[]`, and the endpoint answers
        // 200 with an EMPTY name list: a customer with a configured Authorization
        // header would be told they have none configured. So GET must come back
        // non-empty, not merely 200.
        const putRes = mockRes();
        await destinationHeadersHandler(
          mockReq({
            method: 'PUT',
            query: { slug: TEAM_A, routeId: ROUTE_A },
            body: {
              headers: { authorization: 'Bearer test-value-not-a-real-token' },
            },
          }),
          putRes
        );
        expect(putRes.statusCode).toBe(200);
        expect(putRes.body.data.names).toEqual(['authorization']);

        const getRes = mockRes();
        await destinationHeadersHandler(
          mockReq({ method: 'GET', query: { slug: TEAM_A, routeId: ROUTE_A } }),
          getRes
        );

        console.log(
          `[RELAY-84] destination-headers GET (inline query): ${JSON.stringify(getRes.body.data.names)}`
        );
        expect(getRes.statusCode).toBe(200);
        expect(getRes.body.data.names).toEqual(['authorization']);
        // The VALUE never leaves the server — asserted here too, because this test
        // is now the closest thing to a contract test on that promise.
        expect(JSON.stringify(getRes.body)).not.toContain(
          'test-value-not-a-real-token'
        );
      });

      it('a cross-team routeId is a 404, not a 500 and not another team’s data', async () => {
        const res = mockRes();
        await destinationHeadersHandler(
          mockReq({ method: 'GET', query: { slug: TEAM_A, routeId: ROUTE_B } }),
          res
        );

        expect(res.statusCode).toBe(404);
        expect(res.body.error.message).toMatch(/not found/i);
      });

      it('DELETE clears the names', async () => {
        const res = mockRes();
        await destinationHeadersHandler(
          mockReq({
            method: 'DELETE',
            query: { slug: TEAM_A, routeId: ROUTE_A },
          }),
          res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.data.names).toEqual([]);
      });
    });

    /* ─────────────────────────────────────────────────────────────────────────────
     * 3. routes/[routeId]/rotate-token.ts
     * ───────────────────────────────────────────────────────────────────────────── */
    describe('POST /api/teams/:slug/relay/routes/:routeId/rotate-token', () => {
      it('rotates the token and the stored value actually changes', async () => {
        // `rotateIngestToken` is `updateMany` + re-read. Unscoped, the UPDATE matches
        // zero rows and the model throws its own 404 — so the failure mode here is
        // "route not found" on a route the operator is looking at, with the
        // compromised token still live. Asserting the DB value changed proves the
        // write landed, not just that the handler answered 200.
        const before = await tokenOf(TEAM_A, ROUTE_A);

        const res = mockRes();
        await rotateTokenHandler(
          mockReq({
            method: 'POST',
            query: { slug: TEAM_A, routeId: ROUTE_A },
          }),
          res
        );

        expect(res.statusCode).toBe(200);
        expect(res.body.data.id).toBe(ROUTE_A);

        const after = await tokenOf(TEAM_A, ROUTE_A);

        console.log(
          `[RELAY-84] rotate-token: token changed = ${before !== after}`
        );
        expect(before).not.toBe(after);
        expect(res.body.data.relayUrl).toContain(after);
        expect(res.headers['Cache-Control']).toBe('no-store');
      });

      it('refuses a cross-team routeId with 404 and leaves that token alone', async () => {
        const before = await tokenOf(TEAM_B, ROUTE_B);

        const res = mockRes();
        await rotateTokenHandler(
          mockReq({
            method: 'POST',
            query: { slug: TEAM_A, routeId: ROUTE_B },
          }),
          res
        );

        expect(res.statusCode).toBe(404);

        // The other team's credential is untouched — a cross-tenant rotate must not
        // revoke a token it was never allowed to see.
        expect(await tokenOf(TEAM_B, ROUTE_B)).toBe(before);
      });
    });

    /* ─────────────────────────────────────────────────────────────────────────────
     * 4. routes/[routeId]/test-send.ts
     * ───────────────────────────────────────────────────────────────────────────── */
    describe('POST /api/teams/:slug/relay/routes/:routeId/test-send', () => {
      const realFetch = global.fetch;

      afterEach(() => {
        global.fetch = realFetch;
      });

      it('resolves the route and reaches the proxy call', async () => {
        // The proxy is stubbed — this suite is the dashboard's, and RELAY-84 is about
        // whether the handler can SEE its own route under `relay_app`. Everything
        // before the fetch is the part under test; an unwrapped handler never gets
        // this far, because `fetchRoute` returns null and it 404s.
        const calls: string[] = [];
        global.fetch = (async (url: any) => {
          calls.push(String(url));
          return {
            ok: true,
            status: 200,
            json: async () => ({ requestId: 'from-proxy', status: 'queued' }),
          };
        }) as any;

        const res = mockRes();
        await testSendHandler(
          mockReq({
            method: 'POST',
            query: { slug: TEAM_A, routeId: ROUTE_A },
          }),
          res
        );

        console.log(`[RELAY-84] test-send: ${calls.length} proxy call(s) made`);
        expect(res.statusCode).toBe(200);
        expect(calls).toHaveLength(1);
        // `fetchRouteBySlugs` (which opens its own nested scope) had to resolve for
        // the ingest URL to carry a token at all.
        expect(calls[0]).toContain(`/in/${TEAM_A}/`);
        expect(res.body.data.status).toBe('queued');
      });

      it('404s a cross-team routeId without calling the proxy at all', async () => {
        const calls: string[] = [];
        global.fetch = (async (url: any) => {
          calls.push(String(url));
          return { ok: true, status: 200, json: async () => ({}) };
        }) as any;

        const res = mockRes();
        await testSendHandler(
          mockReq({
            method: 'POST',
            query: { slug: TEAM_A, routeId: ROUTE_B },
          }),
          res
        );

        expect(res.statusCode).toBe(404);
        // The ordering guarantee retry.ts documents: verify ownership, THEN act on
        // the world outside this system.
        expect(calls).toHaveLength(0);
      });
    });

    /* ─────────────────────────────────────────────────────────────────────────────
     * 5. log.ts
     * ───────────────────────────────────────────────────────────────────────────── */
    describe('GET /api/teams/:slug/relay/log', () => {
      it('returns the team’s own delivery rows, non-zero', async () => {
        const res = mockRes();
        await logHandler(
          mockReq({ method: 'GET', query: { slug: TEAM_A } }),
          res
        );

        console.log(
          `[RELAY-84] log GET (team A): ${res.body.data.length} rows`
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.data.length).toBeGreaterThan(0);
        expect(res.body.data.map((r: any) => r.route.id)).toEqual(
          expect.arrayContaining([ROUTE_A])
        );
      });

      it('a cross-team routeId filter yields ZERO ROWS with a 200, not an error', async () => {
        // The literal wording of the failure mode this ticket exists for, asserted
        // as the CORRECT behaviour for a cross-tenant request: no leak, no 500, no
        // schema-shaped Prisma error (RELAY-63's complaint) — just an empty list.
        const res = mockRes();
        await logHandler(
          mockReq({ method: 'GET', query: { slug: TEAM_A, routeId: ROUTE_B } }),
          res
        );

        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual([]);
      });
    });

    /* ─────────────────────────────────────────────────────────────────────────────
     * 6. log-stream.ts — the SSE case, which is the reason this ticket needed care
     * ───────────────────────────────────────────────────────────────────────────── */
    describe('GET /api/teams/:slug/relay/log-stream (SSE)', () => {
      it('AsyncLocalStorage survives a DETACHED chained timer after the scope resolves', async () => {
        // The mechanism question, isolated from the database and from the handler.
        //
        // `rls.spec.ts`'s "SSE poll shape" test awaits each tick INSIDE a still-open
        // `withTeamScope`. That is not this handler's shape. Here `withTeamScope`
        // returns as soon as `scheduleNextPoll()` has been called, and the polls fire
        // afterwards, on a chain of timers, with the enclosing `run()` long resolved.
        // If the store did not survive that, every poll would query unscoped, return
        // `[]`, and the feed would silently freeze. Proven, not assumed.
        const observed: (string | undefined)[] = [];
        let done!: () => void;
        const finished = new Promise<void>((resolve) => (done = resolve));

        let scopeResolved = false;
        const observedAfterResolve: boolean[] = [];

        const chain = (n: number) => {
          setTimeout(() => {
            observed.push(currentTeamId());
            observedAfterResolve.push(scopeResolved);
            if (n > 1) chain(n - 1);
            else done();
          }, 20);
        };

        await withTeamScope(TEAM_A, async () => {
          chain(3); // scheduled inside; fires outside
        });
        scopeResolved = true;

        await finished;

        console.log(
          `[RELAY-84] detached chained timers: scope seen = ${JSON.stringify(observed)}, ` +
            `all ticks fired after run() resolved = ${observedAfterResolve.every(Boolean)}`
        );

        expect(observed).toEqual([TEAM_A, TEAM_A, TEAM_A]);
        // If this is ever false the test above proved nothing, so assert it.
        expect(observedAfterResolve.every(Boolean)).toBe(true);
      });

      it('the snapshot carries the team’s rows and none of the other team’s', async () => {
        const req = mockReq({ method: 'GET', query: { slug: TEAM_A } });
        const res = mockRes();

        await logStreamHandler(req, res);

        const events = parseSse(res.written);
        const snapshot = events.find((e) => e.event === 'snapshot');

        console.log(
          `[RELAY-84] log-stream snapshot: ${snapshot?.data.rows.length} rows, mode=${snapshot?.data.mode}`
        );

        expect(res.statusCode).toBe(200);
        expect(snapshot).toBeDefined();
        expect(snapshot!.data.rows.length).toBeGreaterThan(0);
        expect(snapshot!.data.rows.map((r: any) => r.route.id)).toEqual(
          expect.arrayContaining([ROUTE_A])
        );
        expect(snapshot!.data.rows.map((r: any) => r.route.id)).not.toContain(
          ROUTE_B
        );

        req.emit('close'); // stop the poll chain
      });

      it('the POLL — not just the snapshot — still sees the team’s rows two ticks later', async () => {
        // THE test this ticket's SSE requirement asks for, end to end.
        //
        // A row is inserted for team A AFTER the handler has returned and the scope
        // has resolved. If the poll at t+2s had lost the scope it would fetch `[]`,
        // find nothing added, emit no `delta`, and emit no `stream-error` either —
        // the page would look alive and be blind. So the assertion is the arrival of
        // a delta containing the new row, not the absence of an error.
        const req = mockReq({ method: 'GET', query: { slug: TEAM_A } });
        const res = mockRes();

        await logStreamHandler(req, res);
        const framesAfterSnapshot = res.written.length;

        const lateRequestId = `rls-h-late-${RUN}`;
        await withTeamScope(TEAM_A, () =>
          scoped.deliveryLog.create({
            data: {
              routeId: ROUTE_A,
              requestId: lateRequestId,
              status: DeliveryStatus.QUEUED,
              attemptCount: 0,
            },
          })
        );
        // And one for team B in the same window, so the poll has something it must
        // NOT pick up.
        await withTeamScope(TEAM_B, () =>
          scoped.deliveryLog.create({
            data: {
              routeId: ROUTE_B,
              requestId: `rls-h-late-b-${RUN}`,
              status: DeliveryStatus.QUEUED,
              attemptCount: 0,
            },
          })
        );

        // POLL_INTERVAL_MS is 2000; wait for two ticks so this is not a one-tick fluke.
        await new Promise((r) => setTimeout(r, 5_000));
        req.emit('close');

        const events = parseSse(res.written.slice(framesAfterSnapshot));
        const deltas = events.filter((e) => e.event === 'delta');
        const errors = events.filter((e) => e.event === 'stream-error');
        const addedIds = deltas.flatMap((d) =>
          d.data.added.map((row: any) => row.requestId)
        );

        console.log(
          `[RELAY-84] log-stream poll after scope resolved: ${deltas.length} delta event(s), ` +
            `${errors.length} stream-error(s), added requestIds = ${JSON.stringify(addedIds)}`
        );

        expect(errors).toHaveLength(0);
        expect(addedIds).toContain(lateRequestId);
        expect(addedIds).not.toContain(`rls-h-late-b-${RUN}`);
        for (const d of deltas) {
          for (const row of d.data.added) {
            expect(row.route.id).toBe(ROUTE_A);
          }
        }
      });

      it('a stream opened by the OTHER team sees only that team’s rows', async () => {
        actAs(TEAM_B);
        const req = mockReq({ method: 'GET', query: { slug: TEAM_B } });
        const res = mockRes();

        await logStreamHandler(req, res);

        const snapshot = parseSse(res.written).find(
          (e) => e.event === 'snapshot'
        );
        const routeIds = snapshot!.data.rows.map((r: any) => r.route.id);

        expect(snapshot!.data.rows.length).toBeGreaterThan(0);
        expect(routeIds).toContain(ROUTE_B);
        expect(routeIds).not.toContain(ROUTE_A);

        req.emit('close');
      });
    });

    /* ─────────────────────────────────────────────────────────────────────────────
     * 7. lib/relay/consume.ts — the SEVENTH call site, found while verifying the six.
     *
     * `consume.ts` was on the "already wrapped" list, and it is: `withTeamScope` has
     * guarded its writes since RELAY-39. What nobody had checked is the tenant assert
     * that runs BEFORE that scope opens. It reads `Route`, so under `relay_app` it
     * fails closed on a VALID pair — and `consumeEnvelope` turns that into a 400,
     * which QStash treats as permanent. Every delivery rejected, nothing logged,
     * nothing queued, and a 200 already returned to the customer at ingest.
     *
     * This is worse than all six dashboard handlers combined: those degrade a page,
     * this drops the product's actual job on the floor.
     * ───────────────────────────────────────────────────────────────────────────── */
    describe('the QStash consumer path (lib/relay/consume.ts)', () => {
      it('the pre-scope tenant assert fails closed on a VALID pair when unscoped', async () => {
        // The measured regression, pinned. If someone unwraps the assert again this
        // goes red instead of the delivery pipeline going quiet in production.
        expect(currentTeamId()).toBeUndefined();

        let unscopedError: string | null = null;
        try {
          await assertRouteBelongsToTeam(TEAM_A, ROUTE_A);
        } catch (error: any) {
          unscopedError = error?.message ?? String(error);
        }

        console.log(
          `[RELAY-84] assertRouteBelongsToTeam UNSCOPED on a valid pair -> ${JSON.stringify(unscopedError)}`
        );

        // Fails closed — the safe direction, and the reason this was invisible.
        expect(unscopedError).toMatch(/not found/i);

        // ...and the same call inside a scope resolves. This pairing is the proof
        // that the failure above is RLS and not a broken fixture.
        await expect(
          withTeamScope(TEAM_A, () => assertRouteBelongsToTeam(TEAM_A, ROUTE_A))
        ).resolves.toBeUndefined();
      });

      it('consumeEnvelope delivers and writes a real DeliveryLog row under relay_app', async () => {
        const requestId = `rls-h-consume-${RUN}`;
        const res = mockRes();

        await consumeEnvelope(
          {
            requestId,
            routeId: ROUTE_A,
            teamId: TEAM_A,
            destination: 'https://a.example.com/hook',
            maxRetries: 3,
            headers: {},
            body: JSON.stringify({ hello: 'world' }),
            isTest: false,
          } as any,
          0,
          res
        );

        console.log(
          `[RELAY-84] consumeEnvelope -> ${res.statusCode} ${JSON.stringify(res.body)}`
        );

        // Before the fix this was 400 `bad_request` with no row written.
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('delivered');

        const row = await withTeamScope(TEAM_A, () =>
          scoped.deliveryLog.findFirst({ where: { requestId } })
        );
        expect(row).not.toBeNull();
        expect(row!.routeId).toBe(ROUTE_A);
        expect(row!.status).toBe(DeliveryStatus.DELIVERED);
      });

      it('rejects an envelope pairing this team with the OTHER team’s route', async () => {
        // The assert's original job, unchanged by the scoping: scoping to the
        // envelope's claim cannot rescue a route that does not belong to the claim.
        const res = mockRes();

        await consumeEnvelope(
          {
            requestId: `rls-h-consume-cross-${RUN}`,
            routeId: ROUTE_B, // belongs to TEAM_B
            teamId: TEAM_A, // claim
            destination: 'https://a.example.com/hook',
            maxRetries: 3,
            headers: {},
            body: '{}',
            isTest: false,
          } as any,
          0,
          res
        );

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe('bad_request');

        // And nothing was written against the other team's route.
        const leaked = await withTeamScope(TEAM_B, () =>
          scoped.deliveryLog.findFirst({
            where: { requestId: `rls-h-consume-cross-${RUN}` },
          })
        );
        expect(leaked).toBeNull();
      });
    });
  }
);
