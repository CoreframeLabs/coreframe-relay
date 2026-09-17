/**
 * @jest-environment node
 */

/**
 * [RELAY-DRAFT-4] RBAC gap-check: does Relay's own feature set (routes, delivery log,
 * DLQ) respect the team-role system BoxyHQ's starter kit already ships (OWNER / ADMIN /
 * MEMBER, `lib/permissions.ts`), or was it built without checking?
 *
 * WHAT THIS PROVES, MEASURED RATHER THAN ASSUMED FROM READING THE HANDLERS
 * -------------------------------------------------------------------------
 * Every Relay write endpoint calls `throwIfNotAllowed(user, 'team', 'update')` — the
 * SAME resource/action pair `pages/api/teams/[slug]/index.ts` uses for updating team
 * settings. `lib/permissions.ts`'s MEMBER entry is `{ resource: 'team', actions: ['read',
 * 'leave'] }` — no `'update'` — so a MEMBER is refused by the pre-existing BoxyHQ
 * permission table with zero Relay-specific code. This suite calls the real exported
 * handlers with a MEMBER-role session and proves the 403 actually fires, and — the
 * negative case that matters just as much — that a MEMBER is refused BEFORE any
 * tenant-scoped model function runs, not after a partial side effect. An ADMIN caller is
 * used as the control: same request, same handler, proven to reach past the gate.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `cross-tenant-isolation.spec.ts`
 * ------------------------------------------------------------------------
 * That suite fixes `role: 'OWNER'` for both attacker and victim throughout — it proves
 * team-id scoping, not role scoping, and explicitly says so in its own header comment.
 * Before this file, there was no automated coverage anywhere in the Relay test suite for
 * "a MEMBER of the CORRECT team, hitting a Relay write endpoint" — confirmed by grepping
 * `__tests__/relay/**` and `tests/e2e/**` for the literal string `MEMBER`, which appears
 * nowhere outside the generic BoxyHQ members-settings fixtures.
 *
 * WHY `models/team` IS MOCKED BUT `models/route` / `models/dlq` / `models/delivery` ARE
 * MOCKED TOO, UNLIKE `cross-tenant-isolation.spec.ts`
 * ------------------------------------------------------------------------
 * That suite needs a real (relay_app) Postgres connection because tenant *scoping* is a
 * database-level property (RLS). Role gating is not: `throwIfNotAllowed` is a pure
 * function over `permissions.ts` and the caller's `role` string, decided before any
 * model function is called. So the model layer is mocked here purely to make this suite
 * runnable with no database at all (it must never join the flaky, DB-dependent suite),
 * and each mock's return/rejection is the signal that proves whether the gate let the
 * call through — see `SENTINEL_STATUS` below.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { Role } from '@prisma/client';

// ─── models/team mock — role is swapped per test, everything else is fixed. ──────────

jest.mock('models/team', () => ({
  __esModule: true,
  throwIfNoTeamAccess: jest.fn(),
  getCurrentUserWithTeam: jest.fn(),
}));

// ─── models/route, models/dlq, models/delivery — mocked so this suite needs no DB. ───
// Every export the handlers under test import must be present, even if a given test
// never reaches it (the gate is expected to stop MEMBER before it does).

jest.mock('models/route', () => ({
  __esModule: true,
  fetchRoute: jest.fn(),
  fetchRoutes: jest.fn(),
  createRoute: jest.fn(),
  rotateIngestToken: jest.fn(),
  setRouteDestinationHeaders: jest.fn(),
  fetchRouteBySlugs: jest.fn(),
  updateRoute: jest.fn(),
  // [RELAY-122] Interpolates its real third argument (rather than returning a fixed
  // string) so a test can tell, from the response body alone, whether the CALLER
  // passed the live ingestToken or a redacted placeholder — see
  // 'GET /routes redacts the ingest token for MEMBER, reveals it for ADMIN' below.
  relayUrlFor: jest.fn(
    (teamSlug: string, routeSlug: string, token: string) =>
      `https://relay.example.test/in/${teamSlug}/${routeSlug}/${token}`
  ),
}));

jest.mock('models/dlq', () => ({
  __esModule: true,
  fetchDlqItemForTeam: jest.fn(),
  fetchDlqItemsForTeam: jest.fn(),
  claimDlqRetry: jest.fn(),
  releaseDlqRetryClaim: jest.fn(),
  readStoredBody: jest.fn(),
  readStoredHeaders: jest.fn(() => ({})),
}));

jest.mock('models/delivery', () => ({
  __esModule: true,
  fetchTeamDeliveryFeed: jest.fn(),
  DELIVERY_FEED_MAX_ROWS: 100,
}));

// `recordAuditEvent` / `recordMetric` are only called on a SUCCESS path this suite never
// reaches (MEMBER is refused before them; the ADMIN control fails deliberately at the
// model layer — see SENTINEL_STATUS). Mocked anyway so a future success-path addition to
// this file does not silently hit real Retraced/metrics code.
// NOTE: mocked by their BARE path ('lib/audit', not '@/lib/audit') -- jest.mock's
// factory argument is resolved by jest-resolve via `moduleDirectories`
// (jest.config.js includes `<rootDir>/`), not by the `@/lib/*` tsconfig path alias
// SWC rewrites `import` statements with. Both resolve to the same file on disk, so
// the handlers' own `@/lib/...` imports pick up this same mock -- same convention
// `__tests__/relay/relay-63-cross-team-404.test.ts` uses for `lib/prisma` / `lib/session`.
jest.mock('lib/audit', () => ({
  __esModule: true,
  recordAuditEvent: jest.fn(),
}));
jest.mock('lib/metrics', () => ({
  __esModule: true,
  recordMetric: jest.fn(),
}));

import { throwIfNoTeamAccess, getCurrentUserWithTeam } from 'models/team';
import * as routeModel from 'models/route';
import * as dlqModel from 'models/dlq';
import * as deliveryModel from 'models/delivery';

import dlqRetryHandler from '../../pages/api/teams/[slug]/relay/dlq/[id]/retry';
import dlqIndexHandler from '../../pages/api/teams/[slug]/relay/dlq/index';
import routesIndexHandler from '../../pages/api/teams/[slug]/relay/routes/index';
import routePatchHandler from '../../pages/api/teams/[slug]/relay/routes/[routeId]/index';
import rotateTokenHandler from '../../pages/api/teams/[slug]/relay/routes/[routeId]/rotate-token';
import destinationHeadersHandler from '../../pages/api/teams/[slug]/relay/routes/[routeId]/destination-headers';
import testSendHandler from '../../pages/api/teams/[slug]/relay/routes/[routeId]/test-send';
import logHandler from '../../pages/api/teams/[slug]/relay/log';

// ─── req/res doubles — same shape as cross-tenant-isolation.spec.ts / relay-63 ───────

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────────────

const TEAM_ID = 'rbac-team-id';
const TEAM_SLUG = 'rbac-team-slug';
const USER = { id: 'rbac-user-id', email: 'rbac-caller@example.com', name: 'RBAC Caller' };

/**
 * A distinctive status that is neither 403 (the role gate) nor any status a handler's
 * happy path would produce on its own — proof that a mocked model function was actually
 * REACHED, not merely that *some* non-403 status came back. Every "ADMIN gets past the
 * gate" assertion below checks for this exact number, not just `!== 403`.
 */
const SENTINEL_STATUS = 418;
class SentinelError extends Error {
  status = SENTINEL_STATUS;
  constructor() {
    super('sentinel: reached the model layer');
  }
}

function setRole(role: (typeof Role)[keyof typeof Role]) {
  const teamMember = {
    teamId: TEAM_ID,
    userId: USER.id,
    role,
    team: { id: TEAM_ID, slug: TEAM_SLUG, name: 'RBAC Test Team' },
    user: { ...USER },
  };
  const userWithTeam = {
    ...USER,
    role,
    team: { id: TEAM_ID, slug: TEAM_SLUG, name: 'RBAC Test Team' },
  };
  (throwIfNoTeamAccess as jest.Mock).mockResolvedValue(teamMember);
  (getCurrentUserWithTeam as jest.Mock).mockResolvedValue(userWithTeam);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════════
// WRITE ENDPOINTS — every one of these calls throwIfNotAllowed(user, 'team', 'update').
// MEMBER's only 'team' permissions are ['read', 'leave'], so MEMBER must be refused,
// and refused BEFORE the model layer runs. ADMIN is the control that proves the gate
// is real (not just an accidentally-permissive mock).
// ═══════════════════════════════════════════════════════════════════════════════════

describe('dlq/[id]/retry.ts — POST (republish a dead webhook)', () => {
  const DLQ_ID = '11111111-1111-4111-8111-111111111111';

  it('MEMBER: 403, and fetchDlqItemForTeam is never called', async () => {
    setRole(Role.MEMBER);
    const req = makeRequest('POST', { slug: TEAM_SLUG, id: DLQ_ID });
    const res = makeResponse();
    await dlqRetryHandler(req, res);

    expect(statusOf(res)).toBe(403);
    expect(bodyOf(res)).toEqual({
      error: { message: 'You are not allowed to perform update on team' },
    });
    expect(dlqModel.fetchDlqItemForTeam).not.toHaveBeenCalled();
  });

  it('ADMIN: gate passes, fetchDlqItemForTeam IS called', async () => {
    setRole(Role.ADMIN);
    (dlqModel.fetchDlqItemForTeam as jest.Mock).mockRejectedValue(new SentinelError());

    const req = makeRequest('POST', { slug: TEAM_SLUG, id: DLQ_ID });
    const res = makeResponse();
    await dlqRetryHandler(req, res);

    expect(statusOf(res)).toBe(SENTINEL_STATUS);
    expect(dlqModel.fetchDlqItemForTeam).toHaveBeenCalledWith(TEAM_ID, DLQ_ID);
  });
});

describe('routes/[routeId]/rotate-token.ts — POST (rotate a live ingest credential)', () => {
  const ROUTE_ID = 'route-1';

  it('MEMBER: 403, and rotateIngestToken is never called', async () => {
    setRole(Role.MEMBER);
    const req = makeRequest('POST', { slug: TEAM_SLUG, routeId: ROUTE_ID });
    const res = makeResponse();
    await rotateTokenHandler(req, res);

    expect(statusOf(res)).toBe(403);
    expect(routeModel.rotateIngestToken).not.toHaveBeenCalled();
  });

  it('ADMIN: gate passes, rotateIngestToken IS called', async () => {
    setRole(Role.ADMIN);
    (routeModel.rotateIngestToken as jest.Mock).mockRejectedValue(new SentinelError());

    const req = makeRequest('POST', { slug: TEAM_SLUG, routeId: ROUTE_ID });
    const res = makeResponse();
    await rotateTokenHandler(req, res);

    expect(statusOf(res)).toBe(SENTINEL_STATUS);
    expect(routeModel.rotateIngestToken).toHaveBeenCalledWith(TEAM_ID, ROUTE_ID);
  });
});

describe('routes/[routeId]/index.ts — PATCH (edit destination/maxRetries/status) [RELAY-123]', () => {
  const ROUTE_ID = 'route-1';
  const PATCH_BODY = { destination: 'https://new-dest.example.com/hook' };

  it('MEMBER: 403, and fetchRoute is never called', async () => {
    setRole(Role.MEMBER);
    const req = makeRequest('PATCH', { slug: TEAM_SLUG, routeId: ROUTE_ID }, PATCH_BODY);
    const res = makeResponse();
    await routePatchHandler(req, res);

    expect(statusOf(res)).toBe(403);
    expect(routeModel.fetchRoute).not.toHaveBeenCalled();
    expect(routeModel.updateRoute).not.toHaveBeenCalled();
  });

  it('ADMIN: gate passes, fetchRoute IS called', async () => {
    setRole(Role.ADMIN);
    (routeModel.fetchRoute as jest.Mock).mockRejectedValue(new SentinelError());

    const req = makeRequest('PATCH', { slug: TEAM_SLUG, routeId: ROUTE_ID }, PATCH_BODY);
    const res = makeResponse();
    await routePatchHandler(req, res);

    expect(statusOf(res)).toBe(SENTINEL_STATUS);
    expect(routeModel.fetchRoute).toHaveBeenCalledWith(TEAM_ID, ROUTE_ID);
  });
});

describe('routes/[routeId]/destination-headers.ts — GET/PUT/DELETE (destination auth headers)', () => {
  const ROUTE_ID = 'route-1';

  it.each(['GET', 'PUT', 'DELETE'] as const)(
    'MEMBER: %s is refused with 403, and fetchRoute is never called',
    async (method) => {
      setRole(Role.MEMBER);
      const body = method === 'PUT' ? { headers: { authorization: 'x' } } : undefined;
      const req = makeRequest(method, { slug: TEAM_SLUG, routeId: ROUTE_ID }, body);
      const res = makeResponse();
      await destinationHeadersHandler(req, res);

      expect(statusOf(res)).toBe(403);
      expect(routeModel.fetchRoute).not.toHaveBeenCalled();
    }
  );

  it.each(['GET', 'PUT', 'DELETE'] as const)(
    'ADMIN: %s gate passes, fetchRoute IS called',
    async (method) => {
      setRole(Role.ADMIN);
      (routeModel.fetchRoute as jest.Mock).mockRejectedValue(new SentinelError());
      const body = method === 'PUT' ? { headers: { authorization: 'x' } } : undefined;
      const req = makeRequest(method, { slug: TEAM_SLUG, routeId: ROUTE_ID }, body);
      const res = makeResponse();
      await destinationHeadersHandler(req, res);

      expect(statusOf(res)).toBe(SENTINEL_STATUS);
      expect(routeModel.fetchRoute).toHaveBeenCalledWith(TEAM_ID, ROUTE_ID);
    }
  );
});

describe('routes/index.ts — POST (create a route / ingestion endpoint)', () => {
  it('MEMBER: 403, and createRoute is never called', async () => {
    setRole(Role.MEMBER);
    const req = makeRequest(
      'POST',
      { slug: TEAM_SLUG },
      { name: 'r', destination: 'https://dest.example.com/hook' }
    );
    const res = makeResponse();
    await routesIndexHandler(req, res);

    expect(statusOf(res)).toBe(403);
    expect(routeModel.createRoute).not.toHaveBeenCalled();
  });

  it('ADMIN: gate passes, createRoute IS called', async () => {
    setRole(Role.ADMIN);
    (routeModel.createRoute as jest.Mock).mockRejectedValue(new SentinelError());

    const req = makeRequest(
      'POST',
      { slug: TEAM_SLUG },
      { name: 'r', destination: 'https://dest.example.com/hook' }
    );
    const res = makeResponse();
    await routesIndexHandler(req, res);

    expect(statusOf(res)).toBe(SENTINEL_STATUS);
    expect(routeModel.createRoute).toHaveBeenCalled();
  });
});

describe('routes/[routeId]/test-send.ts — POST (fire a real webhook at the destination)', () => {
  const ROUTE_ID = 'route-1';

  it('MEMBER: 403, and fetchRoute is never called, and fetch is never called', async () => {
    setRole(Role.MEMBER);
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));
    try {
      const req = makeRequest('POST', { slug: TEAM_SLUG, routeId: ROUTE_ID }, {});
      const res = makeResponse();
      await testSendHandler(req, res);

      expect(statusOf(res)).toBe(403);
      expect(routeModel.fetchRoute).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('ADMIN: gate passes, fetchRoute IS called', async () => {
    setRole(Role.ADMIN);
    (routeModel.fetchRoute as jest.Mock).mockRejectedValue(new SentinelError());

    const req = makeRequest('POST', { slug: TEAM_SLUG, routeId: ROUTE_ID }, {});
    const res = makeResponse();
    await testSendHandler(req, res);

    expect(statusOf(res)).toBe(SENTINEL_STATUS);
    expect(routeModel.fetchRoute).toHaveBeenCalledWith(TEAM_ID, ROUTE_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// READ ENDPOINTS — deliberately open to every role via throwIfNotAllowed(x, 'team',
// 'read'), which MEMBER does have. These are POSITIVE controls: they prove this suite
// is testing the MUTATE/READ line specifically, not just "MEMBER is blocked from
// Relay", which would be a different (and wrong) product behaviour.
// ═══════════════════════════════════════════════════════════════════════════════════

describe('read endpoints — MEMBER is NOT blocked (reads are open to every team role)', () => {
  it('dlq/index.ts GET reaches fetchDlqItemsForTeam for a MEMBER', async () => {
    setRole(Role.MEMBER);
    (dlqModel.fetchDlqItemsForTeam as jest.Mock).mockResolvedValue([]);

    const req = makeRequest('GET', { slug: TEAM_SLUG });
    const res = makeResponse();
    await dlqIndexHandler(req, res);

    expect(statusOf(res)).toBe(200);
    expect(dlqModel.fetchDlqItemsForTeam).toHaveBeenCalledWith(TEAM_ID, 200);
  });

  it('routes/index.ts GET reaches fetchRoutes for a MEMBER', async () => {
    setRole(Role.MEMBER);
    (routeModel.fetchRoutes as jest.Mock).mockResolvedValue([]);

    const req = makeRequest('GET', { slug: TEAM_SLUG });
    const res = makeResponse();
    await routesIndexHandler(req, res);

    expect(statusOf(res)).toBe(200);
    expect(routeModel.fetchRoutes).toHaveBeenCalledWith(TEAM_ID);
  });

  // [RELAY-122] `GET /routes` stays open to MEMBER (`team:read`), but the ingest
  // token — the live bearer credential a sender would need — must never reach a
  // MEMBER's browser. `TOKEN_SENTINEL` stands in for the real value: its absence from
  // the MEMBER body, and presence in the ADMIN body, is the actual proof; a raw
  // "200 with some string" assertion would pass even if redaction were never wired up.
  describe('routes/index.ts GET redacts the ingest token for MEMBER, reveals it for ADMIN', () => {
    const TOKEN_SENTINEL = 'TOKEN_SENTINEL';
    const ROUTE = {
      id: 'route-1',
      teamId: TEAM_ID,
      name: 'Orders webhook',
      slug: 'orders',
      destination: 'https://dest.example.com/hook',
      maxRetries: 7,
      status: 'ACTIVE',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ingestToken: TOKEN_SENTINEL,
    };

    it('MEMBER: 200, body omits the sentinel in both ingestUrlRedacted fields', async () => {
      setRole(Role.MEMBER);
      (routeModel.fetchRoutes as jest.Mock).mockResolvedValue([ROUTE]);

      const req = makeRequest('GET', { slug: TEAM_SLUG });
      const res = makeResponse();
      await routesIndexHandler(req, res);

      expect(statusOf(res)).toBe(200);
      const body = bodyOf<{ data: Array<{ relayUrl: string; ingestUrlRedacted: boolean }> }>(
        res
      );
      const row = body.data[0];
      expect(row.ingestUrlRedacted).toBe(true);
      expect(row.relayUrl).not.toContain(TOKEN_SENTINEL);
      // The placeholder must never equal, nor contain, the real token.
      expect(row.relayUrl.endsWith(`/${TOKEN_SENTINEL}`)).toBe(false);
      const bodyText = JSON.stringify(body);
      expect(bodyText).not.toContain(TOKEN_SENTINEL);
    });

    it('ADMIN: 200, body carries the real token', async () => {
      setRole(Role.ADMIN);
      (routeModel.fetchRoutes as jest.Mock).mockResolvedValue([ROUTE]);

      const req = makeRequest('GET', { slug: TEAM_SLUG });
      const res = makeResponse();
      await routesIndexHandler(req, res);

      expect(statusOf(res)).toBe(200);
      const body = bodyOf<{ data: Array<{ relayUrl: string; ingestUrlRedacted: boolean }> }>(
        res
      );
      const row = body.data[0];
      expect(row.ingestUrlRedacted).toBe(false);
      expect(row.relayUrl).toContain(TOKEN_SENTINEL);
      expect(row.relayUrl.endsWith(`/${TOKEN_SENTINEL}`)).toBe(true);
    });
  });

  it('log.ts GET reaches fetchTeamDeliveryFeed for a MEMBER', async () => {
    setRole(Role.MEMBER);
    (deliveryModel.fetchTeamDeliveryFeed as jest.Mock).mockResolvedValue([]);

    const req = makeRequest('GET', { slug: TEAM_SLUG });
    const res = makeResponse();
    await logHandler(req, res);

    expect(statusOf(res)).toBe(200);
    expect(deliveryModel.fetchTeamDeliveryFeed).toHaveBeenCalled();
  });
});
