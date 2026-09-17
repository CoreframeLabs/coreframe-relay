/**
 * @jest-environment node
 */

/**
 * [RELAY-119] `GET /api/relay/deliveries?requestId=` — the bearer-authenticated,
 * token-scoped delivery-status read.
 *
 * DB-INDEPENDENT ON PURPOSE. The properties under test are decided in the handler and
 * in `lib/relay/readToken.ts` before or independently of Postgres: which bearers are
 * refused without a lookup, that every dead token state produces ONE 401 body, that
 * the tenant and route come from the token row and never from the request, that a
 * cross-tenant `requestId` and a nonexistent one are indistinguishable (404 both
 * ways, RELAY-63), that the rate floor answers 429, and that the hash compare is
 * `timingSafeEqual`. The real RLS half of the story — that Postgres itself denies
 * the row even if the application filter were removed — is a property of the policy
 * in `supabase/migrations/20260917120000_relay_119_read_token_rls.sql` and belongs to
 * the `cross-tenant-isolation.spec.ts` family, which needs a real `relay_app`
 * connection and is not run here.
 *
 * What is mocked: `models/readToken` (the lookup + the atomic rate-floor UPDATE) and
 * `lib/prisma` (the two model reads). `lib/db/scope` runs FOR REAL — it is
 * AsyncLocalStorage, not a database — and the mocked `deliveryLog.findFirst` records
 * `currentTeamId()` at call time to prove the read ran inside the TOKEN's scope.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';

// Partial mock: everything real except `timingSafeEqual`, which is wrapped so the
// suite can assert the compare actually went through it.
jest.mock('node:crypto', () => {
  const actual = jest.requireActual('node:crypto');
  return {
    ...actual,
    timingSafeEqual: jest.fn(actual.timingSafeEqual),
  };
});

jest.mock('models/readToken', () => ({
  __esModule: true,
  lookupReadTokenByHash: jest.fn(),
  admitReadTokenUse: jest.fn(),
}));

jest.mock('lib/prisma', () => ({
  __esModule: true,
  prisma: {
    deliveryLog: { findFirst: jest.fn() },
    route: { findFirst: jest.fn() },
  },
  unscopedPrisma: {},
}));

import { timingSafeEqual } from 'node:crypto';
import * as scope from 'lib/db/scope';
import { prisma } from 'lib/prisma';
import * as readTokenModel from 'models/readToken';
import {
  generateReadToken,
  isWellFormedReadToken,
  readTokenDigestHex,
  readTokenDigestMatches,
} from 'lib/relay/readToken';

import deliveriesHandler from '../../pages/api/relay/deliveries';

const mockLookup = readTokenModel.lookupReadTokenByHash as jest.Mock;
const mockAdmit = readTokenModel.admitReadTokenUse as jest.Mock;
const mockDeliveryFindFirst = (prisma as any).deliveryLog.findFirst as jest.Mock;
const mockRouteFindFirst = (prisma as any).route.findFirst as jest.Mock;

// ─── req/res doubles ──────────────────────────────────────────────────────────────────

function makeRequest(
  method: string,
  query: Record<string, string | string[]>,
  headers: Record<string, string> = {}
): NextApiRequest {
  const raw = Readable.from([]);
  return Object.assign(raw, { method, headers, query }) as unknown as NextApiRequest;
}

function makeResponse() {
  const state = {
    status: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  const resBase = {
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
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
      if (prop === '_headers') return state.headers;
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as NextApiResponse;
  return res;
}

const statusOf = (res: NextApiResponse) => (res as any)._status as number;
const bodyOf = <T>(res: NextApiResponse) => (res as any)._body as T;
const headersOf = (res: NextApiResponse) =>
  (res as any)._headers as Record<string, string>;

// ─── Fixtures: two tenants, one token each, pinned to one route each ─────────────────

const TEAM_A = 'team-a-id';
const TEAM_B = 'team-b-id';
const ROUTE_A1 = 'route-a1';
const ROUTE_A2 = 'route-a2';
const ROUTE_B1 = 'route-b1';

const TOKEN_A = generateReadToken();
const TOKEN_B = generateReadToken();

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 1000);

function tokenRow(overrides: Partial<readTokenModel.ReadTokenRow> = {}) {
  return {
    id: 'tok-a',
    teamId: TEAM_A,
    routeId: ROUTE_A1,
    name: 'n8n',
    hashedToken: readTokenDigestHex(TOKEN_A),
    prefix: 'relay_rt_',
    lastFour: TOKEN_A.slice(-4),
    scopes: ['delivery:read'],
    expiresAt: FUTURE,
    lastUsedAt: null,
    revokedAt: null,
    createdByUserId: 'user-a',
    createdAt: new Date('2026-09-17T00:00:00Z'),
    ...overrides,
  } satisfies readTokenModel.ReadTokenRow;
}

const DELIVERY_A1 = {
  requestId: 'req-a1',
  status: 'DELIVERED',
  attemptCount: 1,
  responseCode: 200,
  latencyMs: 87,
  payloadSizeB: 512,
  isTest: false,
  createdAt: new Date('2026-09-17T10:00:00Z'),
  deliveredAt: new Date('2026-09-17T10:00:01Z'),
  route: { id: ROUTE_A1, name: 'Orders', slug: 'orders' },
};

/**
 * A `deliveryLog.findFirst` double that behaves like the real team-and-route-scoped
 * query: it only answers for the (requestId, routeId) pairs that "exist", so a
 * cross-tenant or cross-route ask returns null exactly as Postgres + the `where` would.
 */
const DELIVERIES: Record<string, { routeId: string; row: typeof DELIVERY_A1 }> = {
  'req-a1': { routeId: ROUTE_A1, row: DELIVERY_A1 },
  'req-a2': {
    routeId: ROUTE_A2,
    row: { ...DELIVERY_A1, requestId: 'req-a2', route: { id: ROUTE_A2, name: 'Other', slug: 'other' } },
  },
  'req-b1': {
    routeId: ROUTE_B1,
    row: { ...DELIVERY_A1, requestId: 'req-b1', route: { id: ROUTE_B1, name: 'B', slug: 'b' } },
  },
};

const UNAUTHORIZED = { error: { message: 'Unauthorized' } };
/** `currentTeamId()` as observed inside each `deliveryLog.findFirst` call. */
const scopeSeenByQuery: Array<string | undefined> = [];
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeEach(() => {
  jest.clearAllMocks();
  mockAdmit.mockResolvedValue(true);
  scopeSeenByQuery.length = 0;
  mockDeliveryFindFirst.mockImplementation(async ({ where }: any) => {
    // Record the ambient RLS scope at the moment the query runs — this is what the
    // Prisma extension would turn into `set_config('app.current_team_id', …)`.
    scopeSeenByQuery.push(scope.currentTeamId());
    const hit = DELIVERIES[where.requestId];
    return hit && hit.routeId === where.routeId ? hit.row : null;
  });
  mockRouteFindFirst.mockResolvedValue({ id: ROUTE_A1, slug: 'orders', name: 'Orders' });
});

// ═══════════════════════════════════════════════════════════════════════════════════

describe('lib/relay/readToken — the pure parts', () => {
  it('mints relay_rt_ + 32 base64url chars (192 bits), unique per call', () => {
    const a = generateReadToken();
    const b = generateReadToken();
    expect(a).toMatch(/^relay_rt_[A-Za-z0-9_-]{32}$/);
    expect(isWellFormedReadToken(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('rejects shapes that are not a read token without any crypto', () => {
    for (const bad of [
      '',
      'relay_rt_',
      'relay_rt_' + 'A'.repeat(31),
      'relay_rt_' + 'A'.repeat(33),
      'relay_rt_' + 'A'.repeat(31) + '=',
      'A'.repeat(32), // a bare ingest token
      'sk_live_' + 'A'.repeat(32),
    ]) {
      expect(isWellFormedReadToken(bad)).toBe(false);
    }
  });

  it('digest matches its own token, not another, and uses timingSafeEqual', () => {
    const t = generateReadToken();
    const h = readTokenDigestHex(t);
    (timingSafeEqual as jest.Mock).mockClear();
    expect(readTokenDigestMatches(t, h)).toBe(true);
    expect(readTokenDigestMatches(generateReadToken(), h)).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    // A malformed stored digest is a mismatch, never a throw.
    expect(readTokenDigestMatches(t, 'not-hex')).toBe(false);
    expect(readTokenDigestMatches(t, h.slice(0, 10))).toBe(false);
  });
});

describe('GET /api/relay/deliveries — authentication', () => {
  it('405 for non-GET', async () => {
    const res = makeResponse();
    await deliveriesHandler(makeRequest('POST', { requestId: 'req-a1' }, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(405);
  });

  it.each([
    ['no Authorization header', {}],
    ['Basic scheme', { authorization: 'Basic abc' }],
    ['empty bearer', { authorization: 'Bearer ' }],
    ['ingest-token-shaped bearer', { authorization: `Bearer ${'A'.repeat(32)}` }],
    ['wrong length', { authorization: 'Bearer relay_rt_' + 'A'.repeat(31) }],
  ])('401 and NO lookup for %s', async (_label, headers) => {
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a1' }, headers), res);
    expect(statusOf(res)).toBe(401);
    expect(bodyOf(res)).toEqual(UNAUTHORIZED);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockAdmit).not.toHaveBeenCalled();
  });

  it('401 for a well-formed token that is not in the table; same body', async () => {
    mockLookup.mockResolvedValue(null);
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a1' }, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(401);
    expect(bodyOf(res)).toEqual(UNAUTHORIZED);
    expect(mockLookup).toHaveBeenCalledWith(readTokenDigestHex(TOKEN_A));
    expect(mockDeliveryFindFirst).not.toHaveBeenCalled();
  });

  it('401 for a revoked token; identical body to unknown', async () => {
    mockLookup.mockResolvedValue(tokenRow({ revokedAt: PAST }));
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a1' }, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(401);
    expect(bodyOf(res)).toEqual(UNAUTHORIZED);
    expect(mockAdmit).not.toHaveBeenCalled();
    expect(mockDeliveryFindFirst).not.toHaveBeenCalled();
  });

  it('401 for an expired token; identical body to unknown', async () => {
    mockLookup.mockResolvedValue(tokenRow({ expiresAt: PAST }));
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a1' }, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(401);
    expect(bodyOf(res)).toEqual(UNAUTHORIZED);
    expect(mockDeliveryFindFirst).not.toHaveBeenCalled();
  });

  it('401 when the row found by hash does not re-verify in constant time (tampered store)', async () => {
    // The lookup "finds" a row whose stored hash is for a DIFFERENT token: the DB
    // equality was somehow satisfied, the constant-time compare must still refuse.
    mockLookup.mockResolvedValue(tokenRow({ hashedToken: readTokenDigestHex(TOKEN_B) }));
    (timingSafeEqual as jest.Mock).mockClear();
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a1' }, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(401);
    expect(bodyOf(res)).toEqual(UNAUTHORIZED);
    expect(timingSafeEqual).toHaveBeenCalled();
    expect(mockDeliveryFindFirst).not.toHaveBeenCalled();
  });

  it('403 (not 401) for a live token without delivery:read', async () => {
    mockLookup.mockResolvedValue(tokenRow({ scopes: [] }));
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a1' }, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(403);
    expect(mockDeliveryFindFirst).not.toHaveBeenCalled();
  });

  it('every successful auth goes through timingSafeEqual', async () => {
    mockLookup.mockResolvedValue(tokenRow());
    (timingSafeEqual as jest.Mock).mockClear();
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a1' }, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(200);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/relay/deliveries — tenant and route come from the token', () => {
  beforeEach(() => {
    mockLookup.mockResolvedValue(tokenRow());
  });

  it("Team A's token, own requestId on the pinned route: 200 with the row, no sourceIp", async () => {
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a1' }, bearer(TOKEN_A)), res);

    expect(statusOf(res)).toBe(200);
    expect(headersOf(res)['cache-control']).toBe('no-store');
    const body = bodyOf<{ data: Record<string, unknown> }>(res);
    expect(body.data).toMatchObject({
      requestId: 'req-a1',
      status: 'DELIVERED',
      terminal: true,
      attemptCount: 1,
      responseCode: 200,
      route: { id: ROUTE_A1, slug: 'orders' },
    });
    expect(body.data).not.toHaveProperty('sourceIp');

    // Scope entered with the TOKEN's team, and the delivery filter pinned to the
    // TOKEN's route — both from the row, neither from the request.
    expect(scopeSeenByQuery).toEqual([TEAM_A]);
    expect(mockDeliveryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { requestId: 'req-a1', routeId: ROUTE_A1 },
      })
    );
  });

  it("Team A's token asking for Team B's requestId: 404, same body as nonexistent", async () => {
    const resCross = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-b1' }, bearer(TOKEN_A)), resCross);
    const resMissing = makeResponse();
    await deliveriesHandler(
      makeRequest('GET', { requestId: 'req-never-existed' }, bearer(TOKEN_A)),
      resMissing
    );

    expect(statusOf(resCross)).toBe(404);
    expect(statusOf(resMissing)).toBe(404);
    expect(bodyOf(resCross)).toEqual(bodyOf(resMissing));
    // The query was still pinned to A's route — B's row was never askable.
    expect(mockDeliveryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { requestId: 'req-b1', routeId: ROUTE_A1 } })
    );
  });

  it('token pinned to route A1 asking for a requestId on route A2 (same team): 404', async () => {
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a2' }, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(404);
  });

  it('teamId / routeId / slug in the query string are ignored, never trusted', async () => {
    const res = makeResponse();
    await deliveriesHandler(
      makeRequest(
        'GET',
        { requestId: 'req-b1', teamId: TEAM_B, routeId: ROUTE_B1, slug: 'team-b' },
        bearer(TOKEN_A)
      ),
      res
    );
    expect(statusOf(res)).toBe(404);
    expect(scopeSeenByQuery).toEqual([TEAM_A]);
    expect(mockDeliveryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { requestId: 'req-b1', routeId: ROUTE_A1 } })
    );
  });

  it('400 for an array or over-long requestId, before any delivery read', async () => {
    const res = makeResponse();
    await deliveriesHandler(
      makeRequest('GET', { requestId: ['req-a1', 'req-b1'] }, bearer(TOKEN_A)),
      res
    );
    expect(statusOf(res)).toBe(400);
    expect(mockDeliveryFindFirst).not.toHaveBeenCalled();
  });

  it('no requestId: 200 introspection naming only the pinned route (credential test)', async () => {
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', {}, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(200);
    expect(bodyOf(res)).toEqual({
      data: {
        ok: true,
        scope: 'delivery:read',
        tokenName: 'n8n',
        expiresAt: FUTURE,
        route: { id: ROUTE_A1, slug: 'orders', name: 'Orders' },
      },
    });
    expect(mockRouteFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ROUTE_A1, teamId: TEAM_A } })
    );
    expect(mockDeliveryFindFirst).not.toHaveBeenCalled();
  });
});

describe('GET /api/relay/deliveries — per-token rate floor', () => {
  it('429 + Retry-After when admitReadTokenUse refuses; no delivery read', async () => {
    mockLookup.mockResolvedValue(tokenRow());
    mockAdmit.mockResolvedValue(false);
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a1' }, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(429);
    expect(headersOf(res)['retry-after']).toBe('1');
    expect(mockAdmit).toHaveBeenCalledWith(TEAM_A, 'tok-a');
    expect(mockDeliveryFindFirst).not.toHaveBeenCalled();
  });
});

describe('GET /api/relay/deliveries — failure hygiene', () => {
  it('a model error becomes a generic 500, never the raw message', async () => {
    mockLookup.mockRejectedValue(new Error('relation "RelayReadToken" does not exist'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = makeResponse();
    await deliveriesHandler(makeRequest('GET', { requestId: 'req-a1' }, bearer(TOKEN_A)), res);
    expect(statusOf(res)).toBe(500);
    expect(JSON.stringify(bodyOf(res))).not.toContain('RelayReadToken');
    spy.mockRestore();
  });
});
