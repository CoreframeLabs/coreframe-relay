/**
 * @jest-environment node
 */

/**
 * [Launch sprint L3] Cross-tenant isolation, at the HTTP-handler boundary, across every
 * team-scoped Relay API route.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS SEPARATE FROM __tests__/lib/rls.spec.ts
 * ----------------------------------------------------------------------------
 * `rls.spec.ts` proves the RLS MECHANISM: the Prisma extension sets
 * `app.current_team_id` correctly, Postgres enforces it, and the setting cannot leak
 * across a pooled connection. It talks to `models/route.ts` and the scoped client
 * directly. It does NOT call a single `pages/api/**` handler.
 *
 * This file proves the PRODUCT CLAIM: "logged in as Team A, can I ever see, mutate, or
 * trigger a side effect against Team B's data by asking a real API route for Team B's
 * id?" That is the one bug class that ends the company (per the launch decision sheet,
 * §9) and it currently has ZERO automated coverage — nothing calls the actual exported
 * `handler` functions under `pages/api/teams/[slug]/relay/**` with one team's session and
 * another team's resource id.
 *
 * WHY IT CONNECTS AS `relay_app`, NOT THE AMBIENT `DATABASE_URL`
 * ----------------------------------------------------------------
 * Two concurrent branches are changing the ground under this suite as it is written:
 *   - `relay/rls-wrap` is wrapping the six remaining handlers below in `withTeamScope`
 *     (RELAY-84).
 *   - `relay/sec-criticals` is fixing five criticals on the ingest/forward path.
 * Neither has merged, and the `DATABASE_URL` flip to `relay_app` (G2a) has not
 * happened. Running this suite against the ambient `postgres` connection would only
 * prove today's app-layer `where teamId` filters work — which they already do, and
 * which is *not* the property RELAY-39/RELAY-84 add. Running it against an EXPLICIT
 * `relay_app` connection (by repointing `process.env.DATABASE_URL` before the handler
 * modules are loaded, then restoring it) makes this suite the thing that goes green the
 * DAY `relay/rls-wrap` merges and `DATABASE_URL` flips — independent of either landing
 * first.
 *
 * WHAT IS EXPECTED TO BE RED TODAY, AND WHY THAT IS CORRECT
 * -------------------------------------------------------------
 * Six of the ten units below are NOT YET wrapped in `withTeamScope` (RELAY-84,
 * `relay/rls-wrap`, in flight). Under `relay_app` with RLS FORCED and no ambient scope,
 * `current_setting('app.current_team_id', true)` is NULL, and `"teamId" = NULL` is never
 * true — so a query on an unwrapped handler returns ZERO rows, including for the
 * CALLER'S OWN team. That is G2a's documented "silent zero rows" failure mode: safe
 * (nothing leaks) but broken (nothing works). The POSITIVE-CONTROL tests below
 * (`own-team access still works`) are the ones that catch this, and they are expected
 * to FAIL today on the six unwrapped handlers and PASS on the four already wrapped
 * (`dlq/index.ts`, `dlq/[id]/retry.ts`, `lib/relay/consume.ts`'s `consumeEnvelope`,
 * `models/route.ts`'s `fetchRouteBySlugs`). Every `it()` below states which ticket makes
 * it green. See docs/launch-test-plan.md for the current measured pass/fail table.
 *
 * `consumeEnvelope` and `fetchRouteBySlugs` are not `pages/api/**` handlers -- they are
 * the two non-HTTP units the brief calls out by name alongside the eight handlers,
 * exercised directly rather than through a req/res double. `consumeEnvelope` has an
 * ordering quirk worth flagging in advance: its tenant check (`assertRouteBelongsToTeam`)
 * runs BEFORE `withTeamScope` is established, by design (see the comment in
 * `lib/relay/consume.ts`), which means that first query is itself unscoped. Under
 * `relay_app` with RLS forced, an unscoped query denies every row, including a genuinely
 * matching pair -- so a red positive-control here would be a functional gap in
 * `consume.ts` distinct from RELAY-84's six handlers, not a leak (the negative control
 * proves no leak independently). Measured, not assumed -- see the test itself.
 *
 * The NEGATIVE-CONTROL tests ("Team A can never see/mutate/trigger Team B's row") are
 * the priority ones and are expected to PASS TODAY regardless of RLS-wrap status,
 * because `models/route.ts` / `models/delivery.ts` / `models/dlq.ts` already filter every
 * query by `teamId` at the application layer (see the file-header comments there). RLS
 * is defence in depth on top of that, not a replacement for it yet. A negative-control
 * failure would be the sev-1 this suite exists to catch.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

import { PrismaClient } from '@prisma/client';
import type { RelayEnvelope } from '@coreframe-relay/types';
import { createScopedPrismaClient } from '@/lib/db/scoped-client';
import { withTeamScope } from '@/lib/db/scope';
import { encryptDestinationHeaders } from '@/lib/relay/destinationAuth';

// ─── DB resolution — same convention as __tests__/lib/rls.spec.ts ────────────────────

const DATABASE_URL =
  process.env.RLS_TEST_DATABASE_URL ||
  process.env.RELAY_APP_DATABASE_URL_LOCAL ||
  process.env.RELAY_APP_DATABASE_URL;

const describeIfConfigured = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[isolation] SKIPPED: no RLS_TEST_DATABASE_URL / RELAY_APP_DATABASE_URL_LOCAL / ' +
      'RELAY_APP_DATABASE_URL set. This is the ONLY automated cross-tenant isolation ' +
      'coverage this product has. Do not merge a launch without this suite reporting a ' +
      'real pass/fail count.\n'
  );
}

jest.setTimeout(120_000);

// ─── models/team mock — bypasses NextAuth session lookup, not the tenant boundary ────
//
// `throwIfNoTeamAccess` / `getCurrentUserWithTeam` resolve `user.team.id` from the
// SESSION plus the `:slug` in the URL. That resolution (cookie -> session -> team
// membership) is BoxyHQ's own machinery and is exercised elsewhere; it is not the
// property under test here. What IS under test is: given a caller legitimately
// authenticated as Team A (slug = Team A's own slug), can the `routeId` / `id` in the
// REST of the URL or query string pull Team B's row anyway? So the mock below is
// faithful to the real function's CONTRACT (resolve team strictly from `req.query.slug`,
// never from any other field) and nothing else is stubbed.

jest.mock('models/team', () => ({
  __esModule: true,
  throwIfNoTeamAccess: jest.fn(),
  getCurrentUserWithTeam: jest.fn(),
}));

// ─── req/res doubles — same shape as __tests__/relay/relay-50.test.ts ────────────────

function makeRequest(
  method: string,
  query: Record<string, string>,
  body?: unknown
): NextApiRequest {
  const raw = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  );
  return Object.assign(raw, {
    method,
    headers: { 'content-type': 'application/json' },
    query,
    body,
  }) as unknown as NextApiRequest;
}

function makeResponse() {
  const headers: Record<string, string> = {};
  const state = { status: 0, body: undefined as unknown };
  const resBase = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  } as unknown as NextApiResponse;
  const res = new Proxy(resBase, {
    get(target, prop) {
      if (prop === '_status') return state.status;
      if (prop === '_body') return state.body;
      if (prop === 'headers') return headers;
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as NextApiResponse & { _status: number; _body: unknown; headers: Record<string, string> };
  return res;
}

const statusOf = (res: ReturnType<typeof makeResponse>) => (res as any)._status as number;
const bodyOf = <T>(res: ReturnType<typeof makeResponse>) => (res as any)._body as T;

/** A req double for the SSE handler: a real EventEmitter so `.on('close', cb)` works. */
function makeSseRequest(query: Record<string, string>): NextApiRequest {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { method: 'GET', headers: {}, query }) as unknown as NextApiRequest;
}

/** A res double that captures SSE `write()` calls without ever opening a real socket. */
function makeSseResponse() {
  const chunks: string[] = [];
  let ended = false;
  const resBase = {
    writeHead: jest.fn(() => resBase),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      ended = true;
    }),
    on: jest.fn(),
    socket: { setKeepAlive: jest.fn(), setTimeout: jest.fn() },
    setHeader: jest.fn(() => resBase),
    status: jest.fn(() => resBase),
    json: jest.fn(() => resBase),
  };
  return new Proxy(resBase, {
    get(target, prop) {
      if (prop === 'writableEnded') return ended;
      if (prop === '_chunks') return chunks;
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as unknown as NextApiResponse & { _chunks: string[] };
}

/** Pull the `snapshot` event's JSON payload out of the captured SSE chunks. */
function snapshotPayload(chunks: string[]): { rows: Array<{ requestId: string }> } {
  const snapshotChunk = chunks.find((c) => c.startsWith('event: snapshot'));
  if (!snapshotChunk) throw new Error('no snapshot event was written');
  const dataLine = snapshotChunk.split('\n').find((l) => l.startsWith('data: '));
  if (!dataLine) throw new Error('snapshot event carried no data line');
  return JSON.parse(dataLine.slice('data: '.length));
}

// ─── Fixtures ──────────────────────────────────────────────────────────────────────

const RUN = randomUUID().slice(0, 8);
const TEAM_A_ID = `iso-team-a-${RUN}`;
const TEAM_B_ID = `iso-team-b-${RUN}`;
const TEAM_A_SLUG = `iso-a-${RUN}`;
const TEAM_B_SLUG = `iso-b-${RUN}`;
const ROUTE_A_SLUG = `route-a-${RUN}`;
const ROUTE_B_SLUG = `route-b-${RUN}`;
const ATTACKER = { id: `iso-user-a-${RUN}`, email: `attacker-${RUN}@iso-test.local`, name: 'Attacker' };

describeIfConfigured('[cross-tenant isolation] every team-scoped Relay handler', () => {
  let base: PrismaClient;
  let scoped: ReturnType<typeof createScopedPrismaClient>['scoped'];
  let originalDatabaseUrl: string | undefined;

  let ROUTE_A: string;
  let ROUTE_B: string;
  let DLQ_A: string;
  let DLQ_B: string;
  let DELIVERY_A_REQUEST_ID: string;
  let DELIVERY_B_REQUEST_ID: string;
  let ROUTE_B_TOKEN_BEFORE: string;

  // Handlers, loaded fresh AFTER DATABASE_URL is repointed at relay_app (see beforeAll).
  type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  let routesIndex: Handler;
  let destinationHeaders: Handler;
  let rotateToken: Handler;
  let testSend: Handler;
  let logHandler: Handler;
  let logStream: Handler;
  let dlqIndex: Handler;
  let dlqRetry: Handler;
  // Not `pages/api/**` handlers -- exercised directly, so their own shapes rather than
  // `Handler`.
  let consumeEnvelope: (
    envelope: RelayEnvelope,
    retriedRaw: number,
    res: NextApiResponse
  ) => Promise<void>;
  let fetchRouteBySlugs: (
    teamSlug: string,
    routeSlug: string
  ) => Promise<{
    id: string;
    teamId: string;
    destination: string;
    maxRetries: number;
    status: string;
    ingestToken: string;
  } | null>;

  const registry: Record<string, { id: string; slug: string; name: string }> = {};

  beforeAll(async () => {
    // ── 1. Fixtures, via an EXPLICIT relay_app connection, independent of app wiring ──
    const clients = createScopedPrismaClient(DATABASE_URL as string);
    base = clients.base;
    scoped = clients.scoped;

    await base.team.createMany({
      data: [
        { id: TEAM_A_ID, name: 'Isolation Test A', slug: TEAM_A_SLUG },
        { id: TEAM_B_ID, name: 'Isolation Test B', slug: TEAM_B_SLUG },
      ],
      skipDuplicates: true,
    });
    registry[TEAM_A_SLUG] = { id: TEAM_A_ID, slug: TEAM_A_SLUG, name: 'Isolation Test A' };
    registry[TEAM_B_SLUG] = { id: TEAM_B_ID, slug: TEAM_B_SLUG, name: 'Isolation Test B' };

    ROUTE_A = randomUUID();
    ROUTE_B = randomUUID();
    ROUTE_B_TOKEN_BEFORE = `iso-token-b-${RUN}`;

    await withTeamScope(TEAM_A_ID, () =>
      scoped.route.create({
        data: {
          id: ROUTE_A,
          teamId: TEAM_A_ID,
          name: 'Route A',
          slug: ROUTE_A_SLUG,
          destination: 'https://a.example.com/hook',
          ingestToken: `iso-token-a-${RUN}`,
        },
      })
    );
    await withTeamScope(TEAM_B_ID, () =>
      scoped.route.create({
        data: {
          id: ROUTE_B,
          teamId: TEAM_B_ID,
          name: 'Route B — the victim',
          slug: ROUTE_B_SLUG,
          destination: 'https://b-victim.example.com/hook',
          ingestToken: ROUTE_B_TOKEN_BEFORE,
          // Real encrypted destination-auth headers on the VICTIM route, so the
          // destination-headers PUT/DELETE cross-tenant test has something real to
          // prove was left untouched, not just an absence.
          destinationHeadersEncrypted: encryptDestinationHeaders({
            authorization: 'Bearer victim-real-secret-do-not-leak',
          }) as any,
        },
      })
    );

    DELIVERY_A_REQUEST_ID = randomUUID();
    DELIVERY_B_REQUEST_ID = randomUUID();
    await withTeamScope(TEAM_A_ID, () =>
      scoped.deliveryLog.create({
        data: { routeId: ROUTE_A, requestId: DELIVERY_A_REQUEST_ID, status: 'DELIVERED', attemptCount: 1 },
      })
    );
    await withTeamScope(TEAM_B_ID, () =>
      scoped.deliveryLog.create({
        data: { routeId: ROUTE_B, requestId: DELIVERY_B_REQUEST_ID, status: 'DELIVERED', attemptCount: 1 },
      })
    );

    DLQ_A = randomUUID();
    DLQ_B = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await withTeamScope(TEAM_A_ID, () =>
      scoped.dlqItem.create({
        data: {
          id: DLQ_A,
          routeId: ROUTE_A,
          requestId: randomUUID(),
          failReason: 'isolation fixture A',
          attemptCount: 1,
          payload: '{"a":true}',
          expiresAt,
        },
      })
    );
    await withTeamScope(TEAM_B_ID, () =>
      scoped.dlqItem.create({
        data: {
          id: DLQ_B,
          routeId: ROUTE_B,
          requestId: randomUUID(),
          failReason: 'isolation fixture B — the victim item',
          attemptCount: 1,
          payload: '{"victim":true}',
          expiresAt,
        },
      })
    );

    // ── 2. Repoint DATABASE_URL, THEN load the handlers fresh. ──────────────────────
    // Import statements are hoisted, so the handlers-under-test are loaded with
    // `require()` inside `jest.isolateModules`, after the env var is changed — the
    // same technique __tests__/relay/relay-50.test.ts uses for the catcher/qstash-test
    // handlers, applied here so `lib/prisma.ts`'s singleton binds to `relay_app`
    // rather than whatever DATABASE_URL the rest of the suite is using.
    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = DATABASE_URL;
    jest.resetModules();

    jest.isolateModules(() => {
      // ── 3. Configure the models/team mock INSIDE this same isolated registry. ─────
      // This has to happen in here, not via the top-level `import` binding: that
      // binding was resolved from the module registry that existed BEFORE
      // `jest.resetModules()` ran, so it is a DIFFERENT `jest.fn()` instance from the
      // one the freshly-`require()`d handlers below actually call. Measured the hard
      // way: configuring the outer binding left the handlers talking to an
      // unconfigured stub that resolved to `undefined`, which read as
      // "Cannot read properties of undefined (reading 'role')" — a crash, not a
      // security failure, but not the test either.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const teamMock = require('models/team');
      teamMock.throwIfNoTeamAccess.mockImplementation(async (req: NextApiRequest) => {
        const slug = req.query.slug as string;
        const team = registry[slug];
        if (!team) throw Object.assign(new Error('You do not have access to this team'), { status: 403 });
        return { teamId: team.id, userId: ATTACKER.id, role: 'OWNER' };
      });
      teamMock.getCurrentUserWithTeam.mockImplementation(async (req: NextApiRequest) => {
        const slug = req.query.slug as string;
        const team = registry[slug];
        if (!team) throw Object.assign(new Error('You do not have access to this team'), { status: 403 });
        return { id: ATTACKER.id, email: ATTACKER.email, name: ATTACKER.name, role: 'OWNER', team };
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      routesIndex = require('../../pages/api/teams/[slug]/relay/routes/index').default;
      destinationHeaders =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../pages/api/teams/[slug]/relay/routes/[routeId]/destination-headers').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      rotateToken = require('../../pages/api/teams/[slug]/relay/routes/[routeId]/rotate-token').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      testSend = require('../../pages/api/teams/[slug]/relay/routes/[routeId]/test-send').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      logHandler = require('../../pages/api/teams/[slug]/relay/log').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      logStream = require('../../pages/api/teams/[slug]/relay/log-stream').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      dlqIndex = require('../../pages/api/teams/[slug]/relay/dlq/index').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      dlqRetry = require('../../pages/api/teams/[slug]/relay/dlq/[id]/retry').default;
      // Relative path, not the `@/lib/...` tsconfig alias: `@/` is rewritten to a
      // resolvable specifier only on parsed `import` declarations by the SWC transform;
      // a bare string handed to `require()` never goes through that rewrite and 404s in
      // jest-resolve. Measured the hard way, same category of gotcha as the
      // `models/team` mock-binding note above.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      consumeEnvelope = require('../../lib/relay/consume').consumeEnvelope;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fetchRouteBySlugs = require('models/route').fetchRouteBySlugs;
    });
  });

  afterAll(async () => {
    if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await base.team.deleteMany({ where: { slug: { startsWith: 'iso-' } } });
    await base.$disconnect();
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // NEGATIVE CONTROLS — priority. Team A, authenticated as itself, reaches for Team
  // B's resource id. None of these may return Team B's data or let Team A mutate or
  // trigger a side effect against it. Expected GREEN today.
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('routes/index.ts — GET list', () => {
    it('never lists another team\'s route', async () => {
      const req = makeRequest('GET', { slug: TEAM_A_SLUG });
      const res = makeResponse();
      await routesIndex(req, res);

      expect(statusOf(res)).toBe(200);
      const ids = bodyOf<{ data: Array<{ id: string }> }>(res).data.map((r) => r.id);
      expect(ids).not.toContain(ROUTE_B);
    });
  });

  describe('destination-headers.ts — GET/PUT/DELETE on another team\'s routeId', () => {
    it('GET 404s and never returns the victim route\'s header names', async () => {
      const req = makeRequest('GET', { slug: TEAM_A_SLUG, routeId: ROUTE_B });
      const res = makeResponse();
      await destinationHeaders(req, res);

      expect(statusOf(res)).toBe(404);
      expect(JSON.stringify(bodyOf(res))).not.toContain('authorization');
    });

    it('PUT 404s and the victim route\'s real stored headers are unchanged', async () => {
      const req = makeRequest(
        'PUT',
        { slug: TEAM_A_SLUG, routeId: ROUTE_B },
        { headers: { authorization: 'attacker-supplied-value' } }
      );
      const res = makeResponse();
      await destinationHeaders(req, res);
      expect(statusOf(res)).toBe(404);

      // Read back as TEAM B's own scope — the attacker's PUT must not have landed.
      const row = await withTeamScope(TEAM_B_ID, () =>
        scoped.route.findFirst({ where: { id: ROUTE_B }, select: { destinationHeadersEncrypted: true } })
      );
      const stored = JSON.stringify(row?.destinationHeadersEncrypted ?? {});
      expect(stored).not.toContain('attacker-supplied-value');
    });

    it('DELETE 404s and does not clear the victim route\'s headers', async () => {
      const req = makeRequest('DELETE', { slug: TEAM_A_SLUG, routeId: ROUTE_B });
      const res = makeResponse();
      await destinationHeaders(req, res);
      expect(statusOf(res)).toBe(404);

      const row = await withTeamScope(TEAM_B_ID, () =>
        scoped.route.findFirst({ where: { id: ROUTE_B }, select: { destinationHeadersEncrypted: true } })
      );
      // Still present — the attacker's DELETE must not have nulled it out.
      expect(row?.destinationHeadersEncrypted).not.toBeNull();
    });
  });

  describe('rotate-token.ts — POST on another team\'s routeId', () => {
    it('404s and the victim route\'s ingestToken is byte-identical before and after', async () => {
      const req = makeRequest('POST', { slug: TEAM_A_SLUG, routeId: ROUTE_B });
      const res = makeResponse();
      await rotateToken(req, res);
      expect(statusOf(res)).toBe(404);

      const row = await withTeamScope(TEAM_B_ID, () =>
        scoped.route.findFirst({ where: { id: ROUTE_B }, select: { ingestToken: true } })
      );
      // This is the write-safety proof, not just a status code: did the attacker's
      // request actually revoke the victim's live credential?
      expect(row?.ingestToken).toBe(ROUTE_B_TOKEN_BEFORE);
    });
  });

  describe('test-send.ts — POST on another team\'s routeId', () => {
    it('404s and never fires a request toward the victim\'s real destination', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
      try {
        const req = makeRequest('POST', { slug: TEAM_A_SLUG, routeId: ROUTE_B }, {});
        const res = makeResponse();
        await testSend(req, res);

        expect(statusOf(res)).toBe(404);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('log.ts — GET filtered by another team\'s routeId', () => {
    it('never returns the victim\'s delivery row', async () => {
      const req = makeRequest('GET', { slug: TEAM_A_SLUG, routeId: ROUTE_B });
      const res = makeResponse();
      await logHandler(req, res);

      expect(statusOf(res)).toBe(200);
      const rows = bodyOf<{ data: Array<{ requestId: string }> }>(res).data;
      expect(rows.map((r) => r.requestId)).not.toContain(DELIVERY_B_REQUEST_ID);
    });
  });

  describe('log-stream.ts — SSE snapshot filtered by another team\'s routeId', () => {
    it('the snapshot event never includes the victim\'s delivery row', async () => {
      const req = makeSseRequest({ slug: TEAM_A_SLUG, routeId: ROUTE_B });
      const res = makeSseResponse();
      await logStream(req, res);

      const snapshot = snapshotPayload((res as any)._chunks);
      expect(snapshot.rows.map((r) => r.requestId)).not.toContain(DELIVERY_B_REQUEST_ID);

      // Close the stream so its poll timer does not outlive the test.
      (req as unknown as EventEmitter).emit('close');
    });
  });

  describe('dlq/index.ts — GET list (already wrapped, RELAY-39/RELAY-8)', () => {
    it('never lists the victim team\'s DLQ item', async () => {
      const req = makeRequest('GET', { slug: TEAM_A_SLUG });
      const res = makeResponse();
      await dlqIndex(req, res);

      expect(statusOf(res)).toBe(200);
      const ids = bodyOf<{ data: { items: Array<{ id: string }> } }>(res).data.items.map((i) => i.id);
      expect(ids).not.toContain(DLQ_B);
    });
  });

  describe('dlq/[id]/retry.ts — POST on another team\'s DLQ item id (already wrapped)', () => {
    it('404s and never attempts a QStash publish for the victim\'s payload', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
      try {
        const req = makeRequest('POST', { slug: TEAM_A_SLUG, id: DLQ_B });
        const res = makeResponse();
        await dlqRetry(req, res);

        expect(statusOf(res)).toBe(404);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('lib/relay/consume.ts — consumeEnvelope() on a forged cross-tenant (teamId, routeId) pair', () => {
    it('denies before any forward attempt or DeliveryLog write, under either team\'s scope', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
      const forgedRequestId = randomUUID();
      try {
        const res = makeResponse();
        // The shape the file-header comment on consume.ts calls out by name: "a bug [in
        // the proxy] that paired one team's id with another team's route" -- teamId
        // claims Team A, routeId is Team B's route.
        await consumeEnvelope(
          {
            requestId: forgedRequestId,
            routeId: ROUTE_B,
            teamId: TEAM_A_ID,
            destination: 'https://b-victim.example.com/hook',
            maxRetries: 3,
            receivedAt: new Date().toISOString(),
            headers: {},
            body: '{"attack":true}',
            isTest: true,
          },
          0,
          res
        );

        expect(statusOf(res)).toBe(400);
        expect(bodyOf(res)).toEqual({ error: 'bad_request' });
        // The tenant check runs BEFORE the outbound request -- never fired at the victim.
        expect(fetchSpy).not.toHaveBeenCalled();

        // And no DeliveryLog row landed under EITHER team's scope for this request id.
        const asA = await withTeamScope(TEAM_A_ID, () =>
          scoped.deliveryLog.findFirst({ where: { requestId: forgedRequestId } })
        );
        const asB = await withTeamScope(TEAM_B_ID, () =>
          scoped.deliveryLog.findFirst({ where: { requestId: forgedRequestId } })
        );
        expect(asA).toBeNull();
        expect(asB).toBeNull();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('models/route.ts — fetchRouteBySlugs(teamSlug, routeSlug), the proxy\'s only lookup', () => {
    it('never resolves another team\'s route slug under the caller\'s own team slug', async () => {
      const route = await fetchRouteBySlugs(TEAM_A_SLUG, ROUTE_B_SLUG);
      expect(route).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // POSITIVE CONTROLS — proves the suite is not vacuous, and is the part that tracks
  // RELAY-84 (relay/rls-wrap). Each `it()` names the ticket that must land for it to
  // go green. See docs/launch-test-plan.md for the measured pass/fail table this
  // produces on a given run.
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('positive controls — a team can still read its own data', () => {
    // Expected RED today: routes/index.ts is not yet wrapped in withTeamScope
    // (RELAY-84). Under relay_app with RLS forced and no ambient scope, this query
    // returns zero rows — including Team A's own route. Goes green when
    // relay/rls-wrap merges and DATABASE_URL flips (G2a).
    it('[RELAY-84] routes/index.ts still lists the caller\'s OWN route', async () => {
      const req = makeRequest('GET', { slug: TEAM_A_SLUG });
      const res = makeResponse();
      await routesIndex(req, res);

      expect(statusOf(res)).toBe(200);
      const ids = bodyOf<{ data: Array<{ id: string }> }>(res).data.map((r) => r.id);
      expect(ids).toContain(ROUTE_A);
    });

    // Expected RED today, same reason and same ticket.
    it('[RELAY-84] destination-headers.ts GET still reads the caller\'s OWN route', async () => {
      const req = makeRequest('GET', { slug: TEAM_A_SLUG, routeId: ROUTE_A });
      const res = makeResponse();
      await destinationHeaders(req, res);
      expect(statusOf(res)).toBe(200);
    });

    // Expected RED today, same reason and same ticket.
    it('[RELAY-84] log.ts still returns the caller\'s OWN delivery row', async () => {
      const req = makeRequest('GET', { slug: TEAM_A_SLUG, routeId: ROUTE_A });
      const res = makeResponse();
      await logHandler(req, res);

      expect(statusOf(res)).toBe(200);
      const rows = bodyOf<{ data: Array<{ requestId: string }> }>(res).data;
      expect(rows.map((r) => r.requestId)).toContain(DELIVERY_A_REQUEST_ID);
    });

    // Expected GREEN today — dlq/index.ts is ALREADY wrapped in withTeamScope. This is
    // the end-to-end (HTTP handler, not raw Prisma) proof that the pattern RELAY-84 is
    // about to apply six more times actually works.
    it('dlq/index.ts still lists the caller\'s OWN DLQ item', async () => {
      const req = makeRequest('GET', { slug: TEAM_A_SLUG });
      const res = makeResponse();
      await dlqIndex(req, res);

      expect(statusOf(res)).toBe(200);
      const ids = bodyOf<{ data: { items: Array<{ id: string }> } }>(res).data.items.map((i) => i.id);
      expect(ids).toContain(DLQ_A);
    });

    // Expected GREEN today -- fetchRouteBySlugs resolves the Team row unscoped (Team
    // carries no RLS policy) and THEN wraps the Route lookup in withTeamScope derived
    // from that row, never from the request. See the [RELAY-39 wiring] comment on the
    // function itself.
    it('fetchRouteBySlugs still resolves the caller\'s OWN route by its own slug pair', async () => {
      const route = await fetchRouteBySlugs(TEAM_A_SLUG, ROUTE_A_SLUG);
      expect(route?.id).toBe(ROUTE_A);
      expect(route?.teamId).toBe(TEAM_A_ID);
    });

    // NOT gated by RELAY-84 -- consume.ts is one of the four already-wrapped units. But
    // see the file-header note: its tenant check runs before scope is established, so
    // this positive control is the one place that ordering quirk would show up as a red
    // test rather than as a leak. Measured here rather than assumed from reading the code.
    it('consumeEnvelope still delivers and records a real DeliveryLog row for the caller\'s own route', async () => {
      // [RELAY-33] forwardToDestination now calls resolveAndValidateDestination, which
      // itself calls `fetch` (a DoH lookup against cloudflare-dns.com) before the real
      // outbound forward fetch. A blanket mock answering every call with `{}`/200 makes
      // the DoH call return an unparseable "DNS" response (Status is undefined, not 0),
      // which the resolver correctly treats as zero records and fails closed — the SSRF
      // layer is behaving exactly as designed, the test fixture just didn't distinguish
      // the two `fetch` calls. Route on URL: DoH calls get a real DoH-shaped answer
      // resolving to a safe public IP (93.184.216.34, example.com's own address), the
      // actual forward call gets the original stub response.
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
        if (url.includes('cloudflare-dns.com')) {
          return new Response(
            JSON.stringify({ Status: 0, Answer: [{ name: 'a.example.com', type: 1, TTL: 60, data: '93.184.216.34' }] }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      });
      const requestId = randomUUID();
      try {
        const res = makeResponse();
        await consumeEnvelope(
          {
            requestId,
            routeId: ROUTE_A,
            teamId: TEAM_A_ID,
            destination: 'https://a.example.com/hook',
            maxRetries: 3,
            receivedAt: new Date().toISOString(),
            headers: {},
            body: '{"ok":true}',
            isTest: true,
          },
          0,
          res
        );

        expect(statusOf(res)).toBe(200);
        expect(bodyOf(res)).toEqual({ status: 'delivered', requestId });

        const log = await withTeamScope(TEAM_A_ID, () =>
          scoped.deliveryLog.findFirst({ where: { requestId } })
        );
        expect(log?.status).toBe('DELIVERED');
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
