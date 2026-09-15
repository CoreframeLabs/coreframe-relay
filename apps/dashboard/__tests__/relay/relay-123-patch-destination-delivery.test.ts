/**
 * @jest-environment node
 */

/**
 * [RELAY-123] The ticket's own end-to-end AC, proven for real: PATCH a route's
 * destination, then a real webhook sent through the same route arrives at the NEW
 * destination and not the old one.
 *
 * WHAT IS REAL HERE
 * ------------------
 *   - A real Postgres write via the actual exported PATCH handler
 *     (`pages/api/teams/[slug]/relay/routes/[routeId]/index.ts`), not a direct
 *     `updateRoute` call — this is the same "call the real exported handler" rigor
 *     `cross-tenant-isolation.spec.ts` uses everywhere else in this suite.
 *   - Two real local HTTP listeners standing in for the OLD and NEW destinations —
 *     same pattern `relay-111.test.ts` uses (a real server, not a mocked timer/fetch).
 *   - The real `fetchRouteBySlugs` — the EXACT function the proxy calls at ingest
 *     time to build a fresh envelope — proving that the next real ingest embeds the
 *     NEW destination, not a cached one.
 *   - The real `consumeEnvelope`/`forwardToDestination` delivery pipeline, fed an
 *     envelope shaped exactly the way a fresh ingest would build it (destination
 *     pinned from the live route row at ingest time — see the comment in
 *     `lib/relay/consume.ts`: "The envelope's `destination` was pinned at
 *     ingestion").
 *
 * WHAT IS NOT REAL HERE, STATED HONESTLY
 * ----------------------------------------
 * This does not start the actual Cloudflare Worker proxy or a real QStash queue —
 * neither is available in this sandbox (no wrangler dev, no QStash credentials).
 * The hop this test does NOT exercise is "a real HTTP POST to the public ingest URL
 * gets picked up by the real proxy and published to real QStash." Everything AFTER
 * that hop — the route lookup that embeds the destination, and the entire forward/
 * SSRF/delivery pipeline — is exercised for real. `scripts/smoke-buffer-remote.sh`
 * (updated by this same ticket) is what proves the missing hop, against real
 * production infrastructure; it is not runnable from this sandbox either (needs a
 * real production deploy + real webhook.site), and is reported separately as still
 * owed rather than claimed here.
 *
 * Same DB-configuration convention as `cross-tenant-isolation.spec.ts`: skips
 * cleanly with a loud warning if no relay_app-capable Postgres is configured.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import type { RelayEnvelope } from '@coreframe-relay/types';
import { PrismaClient } from '@prisma/client';

import { createScopedPrismaClient } from '@/lib/db/scoped-client';
import { withTeamScope } from '@/lib/db/scope';

const DATABASE_URL =
  process.env.RLS_TEST_DATABASE_URL ||
  process.env.RELAY_APP_DATABASE_URL_LOCAL ||
  process.env.RELAY_APP_DATABASE_URL;

const describeIfConfigured = DATABASE_URL ? describe : describe.skip;

if (!DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[RELAY-123] SKIPPED: no RLS_TEST_DATABASE_URL / RELAY_APP_DATABASE_URL_LOCAL / ' +
      'RELAY_APP_DATABASE_URL set. This is the real PATCH -> re-ingest -> new-' +
      'destination delivery proof; see the ticket AC it satisfies.\n'
  );
}

jest.setTimeout(60_000);

// Same loopback waiver relay-111.test.ts uses: delegates to the real SSRF validator
// for everything except this file's own throwaway 127.0.0.1 listeners, so the test
// still proves nothing about SSRF itself (ssrf.forward.spec.ts / RELAY-33 own that)
// but isn't blocked from reaching its own real local servers.
jest.mock('../../lib/relay/ssrfGap', () => {
  const actual = jest.requireActual('../../lib/relay/ssrfGap');
  const loopbackOverride = (raw: string) => {
    try {
      const url = new URL(raw);
      if (url.hostname === '127.0.0.1' && Number(url.port) >= 1024) {
        return { ok: true, url };
      }
    } catch {
      // stays rejected
    }
    return null;
  };
  return {
    ...actual,
    validateDestination: (raw: string) => {
      const verdict = actual.validateDestination(raw);
      return verdict.ok ? verdict : loopbackOverride(raw) ?? verdict;
    },
    resolveAndValidateDestination: async (raw: string) => {
      const verdict = await actual.resolveAndValidateDestination(raw);
      return verdict.ok ? verdict : loopbackOverride(raw) ?? verdict;
    },
  };
});

jest.mock('models/team', () => ({
  __esModule: true,
  throwIfNoTeamAccess: jest.fn(),
  getCurrentUserWithTeam: jest.fn(),
}));

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
  const state = { status: 0, body: undefined as unknown };
  const resBase = {
    setHeader() {
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
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as NextApiResponse & { _status: number; _body: unknown };
  return res;
}

const statusOf = (res: ReturnType<typeof makeResponse>) => (res as any)._status as number;
const bodyOf = <T>(res: ReturnType<typeof makeResponse>) => (res as any)._body as T;

/** A real HTTP listener that records every request it receives and always answers 200. */
function realCatcher(): Promise<{
  port: number;
  requests: () => Array<{ body: string }>;
  close: () => Promise<void>;
}> {
  const seen: Array<{ body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) {
        resolve({
          port: address.port,
          requests: () => seen,
          close: () => new Promise((r) => server.close(() => r())),
        });
      } else {
        reject(new Error('listen() produced a non-TCP address'));
      }
    });
  });
}

const RUN = randomUUID().slice(0, 8);
const TEAM_ID = `relay123-team-${RUN}`;
const TEAM_SLUG = `relay123-${RUN}`;
const ROUTE_ID = randomUUID();
const ROUTE_SLUG = `relay123-route-${RUN}`;
const USER = { id: `relay123-user-${RUN}`, email: `relay123-${RUN}@test.local`, name: 'RELAY-123 Tester' };

describeIfConfigured('[RELAY-123] PATCH destination -> next real webhook arrives at the NEW destination', () => {
  let base: PrismaClient;
  let scoped: ReturnType<typeof createScopedPrismaClient>['scoped'];
  let originalDatabaseUrl: string | undefined;
  let oldCatcher: Awaited<ReturnType<typeof realCatcher>>;
  let newCatcher: Awaited<ReturnType<typeof realCatcher>>;

  type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  let routePatch: Handler;
  let fetchRouteBySlugs: (
    teamSlug: string,
    routeSlug: string
  ) => Promise<{ id: string; destination: string } | null>;
  let consumeEnvelope: (
    envelope: RelayEnvelope,
    retriedRaw: number,
    res: NextApiResponse
  ) => Promise<void>;

  beforeAll(async () => {
    oldCatcher = await realCatcher();
    newCatcher = await realCatcher();

    const clients = createScopedPrismaClient(DATABASE_URL as string);
    base = clients.base;
    scoped = clients.scoped;

    await base.team.create({
      data: { id: TEAM_ID, name: 'RELAY-123 Test Team', slug: TEAM_SLUG },
    });
    await withTeamScope(TEAM_ID, () =>
      scoped.route.create({
        data: {
          id: ROUTE_ID,
          teamId: TEAM_ID,
          name: 'RELAY-123 route',
          slug: ROUTE_SLUG,
          destination: `http://127.0.0.1:${oldCatcher.port}/hook`,
          ingestToken: `relay123-token-${RUN}`,
        },
      })
    );

    originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = DATABASE_URL;
    jest.resetModules();

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const teamMock = require('models/team');
      teamMock.throwIfNoTeamAccess.mockResolvedValue({ teamId: TEAM_ID, userId: USER.id, role: 'OWNER' });
      teamMock.getCurrentUserWithTeam.mockResolvedValue({
        id: USER.id,
        email: USER.email,
        name: USER.name,
        role: 'OWNER',
        team: { id: TEAM_ID, slug: TEAM_SLUG },
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      routePatch = require('../../pages/api/teams/[slug]/relay/routes/[routeId]/index').default;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fetchRouteBySlugs = require('models/route').fetchRouteBySlugs;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      consumeEnvelope = require('../../lib/relay/consume').consumeEnvelope;
    });
  });

  afterAll(async () => {
    if (originalDatabaseUrl !== undefined) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await base.team.deleteMany({ where: { id: TEAM_ID } });
    await base.$disconnect();
    await oldCatcher.close();
    await newCatcher.close();
  });

  it('confirms the ORIGINAL destination is real and reachable before any change', async () => {
    const before = await fetchRouteBySlugs(TEAM_SLUG, ROUTE_SLUG);
    expect(before?.destination).toBe(`http://127.0.0.1:${oldCatcher.port}/hook`);

    // A direct probe of the old catcher — it really answers, not a stub.
    const probe = await fetch(`http://127.0.0.1:${oldCatcher.port}/hook`, { method: 'POST', body: '{}' });
    expect(probe.status).toBe(200);
  });

  it('PATCHes the destination through the real handler, persisted via real Prisma', async () => {
    const newDestination = `http://127.0.0.1:${newCatcher.port}/hook`;
    const req = makeRequest('PATCH', { slug: TEAM_SLUG, routeId: ROUTE_ID }, { destination: newDestination });
    const res = makeResponse();
    await routePatch(req, res);

    expect(statusOf(res)).toBe(200);
    expect(bodyOf<{ data: { destination: string } }>(res).data.destination).toBe(newDestination);

    // Independent read-back, bypassing the handler entirely.
    const row = await withTeamScope(TEAM_ID, () =>
      scoped.route.findFirst({ where: { id: ROUTE_ID }, select: { destination: true } })
    );
    expect(row?.destination).toBe(newDestination);
  });

  it('the NEXT real ingest lookup (fetchRouteBySlugs, exactly what the proxy calls) now embeds the NEW destination', async () => {
    const after = await fetchRouteBySlugs(TEAM_SLUG, ROUTE_SLUG);
    expect(after?.destination).toBe(`http://127.0.0.1:${newCatcher.port}/hook`);
  });

  it('a real webhook built from that fresh lookup is delivered to the NEW destination, never the old one', async () => {
    const route = await fetchRouteBySlugs(TEAM_SLUG, ROUTE_SLUG);
    const requestId = randomUUID();
    // Baseline AFTER the earlier reachability probe (test 1 above deliberately POSTed
    // to the old catcher to prove it was real and reachable before any change) -- the
    // decisive assertion below is "no NEW request arrived here for THIS send", not
    // "this server has never seen any request ever".
    const oldRequestsBefore = oldCatcher.requests().length;

    const res = makeResponse();
    await consumeEnvelope(
      {
        requestId,
        routeId: ROUTE_ID,
        teamId: TEAM_ID,
        // Exactly what a fresh proxy ingest would embed post-PATCH -- the route's
        // CURRENT destination, per fetchRouteBySlugs above.
        destination: route!.destination,
        maxRetries: 3,
        receivedAt: new Date().toISOString(),
        headers: {},
        body: JSON.stringify({ relay123: 'post-patch-webhook', stamp: RUN }),
        isTest: true,
      },
      0,
      res
    );

    expect(statusOf(res)).toBe(200);
    expect(bodyOf(res)).toEqual({ status: 'delivered', requestId });

    const newRequests = newCatcher.requests();
    expect(newRequests).toHaveLength(1);
    expect(newRequests[0].body).toContain('post-patch-webhook');

    // The decisive negative: the OLD destination received NOTHING for THIS send.
    expect(oldCatcher.requests().length).toBe(oldRequestsBefore);

    const log = await withTeamScope(TEAM_ID, () =>
      scoped.deliveryLog.findFirst({ where: { requestId } })
    );
    expect(log?.status).toBe('DELIVERED');
  });
});
