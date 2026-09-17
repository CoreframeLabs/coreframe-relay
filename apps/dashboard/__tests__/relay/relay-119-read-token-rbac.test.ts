/**
 * @jest-environment node
 */

/**
 * [RELAY-119] Role gate on the delivery read-token mint / list / revoke endpoints.
 *
 * Same shape and same reasoning as `rbac-member-write-gate.test.ts`: `throwIfNotAllowed`
 * is a pure function over `lib/permissions.ts` and the caller's role, decided BEFORE any
 * model function runs, so this suite needs no database. The model layer is mocked and
 * each mock's rejection with `SENTINEL_STATUS` is the proof that the gate let the
 * ADMIN control through — not merely that "some non-403" came back.
 *
 * What is proven here, per the decision (§1 "Roles"):
 *   - MEMBER cannot mint, cannot LIST (a credential list is itself gated on `update`,
 *     consistent with `api-keys/index.ts` and `destination-headers.ts`), cannot revoke —
 *     403 with the standard permission body, and `fetchRoute` / models/readToken are
 *     never called.
 *   - ADMIN and OWNER reach the model layer on all three.
 *   - A cross-team routeId (team-scoped `fetchRoute` → null) is 404 before any token
 *     row is touched — the RELAY-63 convention, and the reason the endpoints are
 *     mounted under the route.
 *   - The mint response carries the plain token exactly once under `no-store`, and the
 *     audit metadata does NOT carry it.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { Role } from '@prisma/client';

jest.mock('models/team', () => ({
  __esModule: true,
  throwIfNoTeamAccess: jest.fn(),
  getCurrentUserWithTeam: jest.fn(),
}));

jest.mock('models/route', () => ({
  __esModule: true,
  fetchRoute: jest.fn(),
}));

jest.mock('models/readToken', () => ({
  __esModule: true,
  createReadToken: jest.fn(),
  fetchReadTokensForRoute: jest.fn(),
  revokeReadToken: jest.fn(),
}));

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
import * as readTokenModel from 'models/readToken';
import { recordAuditEvent } from 'lib/audit';

import readTokensIndexHandler from '../../pages/api/teams/[slug]/relay/routes/[routeId]/read-tokens/index';
import readTokenRevokeHandler from '../../pages/api/teams/[slug]/relay/routes/[routeId]/read-tokens/[tokenId]';

// ─── req/res doubles — same shape as rbac-member-write-gate.test.ts ─────────────────

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────────────

const TEAM_ID = 'rt-team-id';
const TEAM_SLUG = 'rt-team-slug';
const ROUTE_ID = 'rt-route-id';
const TOKEN_ID = 'rt-token-id';
const USER = { id: 'rt-user-id', email: 'rt-caller@example.com', name: 'RT Caller' };

const ROUTE = {
  id: ROUTE_ID,
  teamId: TEAM_ID,
  name: 'Orders',
  slug: 'orders',
  destination: 'https://example.test/hook',
  maxRetries: 7,
  status: 'ACTIVE',
  ingestToken: 'INGEST_SENTINEL',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};

const SENTINEL_STATUS = 418;
class SentinelError extends Error {
  status = SENTINEL_STATUS;
  constructor() {
    super('sentinel: reached the model layer');
  }
}

const FORBIDDEN_BODY = {
  error: { message: 'You are not allowed to perform update on team' },
};

function setRole(role: (typeof Role)[keyof typeof Role]) {
  (throwIfNoTeamAccess as jest.Mock).mockResolvedValue({
    teamId: TEAM_ID,
    userId: USER.id,
    role,
    team: { id: TEAM_ID, slug: TEAM_SLUG, name: 'RT Team' },
    user: { ...USER },
  });
  (getCurrentUserWithTeam as jest.Mock).mockResolvedValue({
    ...USER,
    role,
    team: { id: TEAM_ID, slug: TEAM_SLUG, name: 'RT Team' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════════

describe('read-tokens/index.ts — POST (mint)', () => {
  const BODY = { name: 'n8n orders workflow' };

  it('MEMBER: 403, and neither fetchRoute nor createReadToken is called', async () => {
    setRole(Role.MEMBER);
    const res = makeResponse();
    await readTokensIndexHandler(
      makeRequest('POST', { slug: TEAM_SLUG, routeId: ROUTE_ID }, BODY),
      res
    );
    expect(statusOf(res)).toBe(403);
    expect(bodyOf(res)).toEqual(FORBIDDEN_BODY);
    expect(routeModel.fetchRoute).not.toHaveBeenCalled();
    expect(readTokenModel.createReadToken).not.toHaveBeenCalled();
  });

  it.each([Role.ADMIN, Role.OWNER])(
    '%s: gate passes, fetchRoute IS called with the verified teamId',
    async (role) => {
      setRole(role);
      (routeModel.fetchRoute as jest.Mock).mockRejectedValue(new SentinelError());
      const res = makeResponse();
      await readTokensIndexHandler(
        makeRequest('POST', { slug: TEAM_SLUG, routeId: ROUTE_ID }, BODY),
        res
      );
      expect(statusOf(res)).toBe(SENTINEL_STATUS);
      expect(routeModel.fetchRoute).toHaveBeenCalledWith(TEAM_ID, ROUTE_ID);
    }
  );

  it('ADMIN + cross-team routeId: 404 before createReadToken (RELAY-63)', async () => {
    setRole(Role.ADMIN);
    (routeModel.fetchRoute as jest.Mock).mockResolvedValue(null);
    const res = makeResponse();
    await readTokensIndexHandler(
      makeRequest('POST', { slug: TEAM_SLUG, routeId: 'someone-elses-route' }, BODY),
      res
    );
    expect(statusOf(res)).toBe(404);
    expect(readTokenModel.createReadToken).not.toHaveBeenCalled();
  });

  it('ADMIN happy path: 201, token shown once under no-store, absent from audit', async () => {
    setRole(Role.ADMIN);
    (routeModel.fetchRoute as jest.Mock).mockResolvedValue(ROUTE);
    const PLAIN = 'relay_rt_' + 'A'.repeat(32);
    (readTokenModel.createReadToken as jest.Mock).mockResolvedValue({
      token: PLAIN,
      row: {
        id: TOKEN_ID,
        teamId: TEAM_ID,
        routeId: ROUTE_ID,
        name: BODY.name,
        prefix: 'relay_rt_',
        lastFour: 'AAAA',
        scopes: ['delivery:read'],
        expiresAt: new Date('2027-09-17T00:00:00Z'),
        lastUsedAt: null,
        revokedAt: null,
        createdByUserId: USER.id,
        createdAt: new Date('2026-09-17T00:00:00Z'),
      },
    });

    const res = makeResponse();
    await readTokensIndexHandler(
      makeRequest('POST', { slug: TEAM_SLUG, routeId: ROUTE_ID }, BODY),
      res
    );

    expect(statusOf(res)).toBe(201);
    expect(headersOf(res)['cache-control']).toBe('no-store');
    const body = bodyOf<{ data: Record<string, unknown> }>(res);
    expect(body.data.token).toBe(PLAIN);
    expect(body.data).not.toHaveProperty('hashedToken');
    expect(readTokenModel.createReadToken).toHaveBeenCalledWith({
      teamId: TEAM_ID,
      routeId: ROUTE_ID,
      name: BODY.name,
      createdByUserId: USER.id,
    });

    // The credential must not be in the audit row — in any field, at any depth.
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    const auditArg = (recordAuditEvent as jest.Mock).mock.calls[0][0];
    expect(auditArg.event).toBe('relay.read_token.created');
    expect(JSON.stringify(auditArg)).not.toContain(PLAIN);
  });

  it('ADMIN + empty name: 422 from schema validation, createReadToken not called', async () => {
    setRole(Role.ADMIN);
    (routeModel.fetchRoute as jest.Mock).mockResolvedValue(ROUTE);
    const res = makeResponse();
    await readTokensIndexHandler(
      makeRequest('POST', { slug: TEAM_SLUG, routeId: ROUTE_ID }, { name: '   ' }),
      res
    );
    expect(statusOf(res)).toBe(422);
    expect(readTokenModel.createReadToken).not.toHaveBeenCalled();
  });
});

describe('read-tokens/index.ts — GET (list)', () => {
  it('MEMBER: 403 — may not even list credentials', async () => {
    setRole(Role.MEMBER);
    const res = makeResponse();
    await readTokensIndexHandler(
      makeRequest('GET', { slug: TEAM_SLUG, routeId: ROUTE_ID }),
      res
    );
    expect(statusOf(res)).toBe(403);
    expect(bodyOf(res)).toEqual(FORBIDDEN_BODY);
    expect(routeModel.fetchRoute).not.toHaveBeenCalled();
    expect(readTokenModel.fetchReadTokensForRoute).not.toHaveBeenCalled();
  });

  it('ADMIN: gate passes, fetchReadTokensForRoute IS called, team+route scoped', async () => {
    setRole(Role.ADMIN);
    (routeModel.fetchRoute as jest.Mock).mockResolvedValue(ROUTE);
    (readTokenModel.fetchReadTokensForRoute as jest.Mock).mockRejectedValue(
      new SentinelError()
    );
    const res = makeResponse();
    await readTokensIndexHandler(
      makeRequest('GET', { slug: TEAM_SLUG, routeId: ROUTE_ID }),
      res
    );
    expect(statusOf(res)).toBe(SENTINEL_STATUS);
    expect(readTokenModel.fetchReadTokensForRoute).toHaveBeenCalledWith(TEAM_ID, ROUTE_ID);
  });

  it('rejects PUT with 405', async () => {
    setRole(Role.OWNER);
    const res = makeResponse();
    await readTokensIndexHandler(
      makeRequest('PUT', { slug: TEAM_SLUG, routeId: ROUTE_ID }),
      res
    );
    expect(statusOf(res)).toBe(405);
  });
});

describe('read-tokens/[tokenId].ts — DELETE (revoke)', () => {
  it('MEMBER: 403, revokeReadToken never called', async () => {
    setRole(Role.MEMBER);
    const res = makeResponse();
    await readTokenRevokeHandler(
      makeRequest('DELETE', { slug: TEAM_SLUG, routeId: ROUTE_ID, tokenId: TOKEN_ID }),
      res
    );
    expect(statusOf(res)).toBe(403);
    expect(bodyOf(res)).toEqual(FORBIDDEN_BODY);
    expect(routeModel.fetchRoute).not.toHaveBeenCalled();
    expect(readTokenModel.revokeReadToken).not.toHaveBeenCalled();
  });

  it.each([Role.ADMIN, Role.OWNER])(
    '%s: gate passes, revokeReadToken IS called with team, route and token ids',
    async (role) => {
      setRole(role);
      (routeModel.fetchRoute as jest.Mock).mockResolvedValue(ROUTE);
      (readTokenModel.revokeReadToken as jest.Mock).mockRejectedValue(new SentinelError());
      const res = makeResponse();
      await readTokenRevokeHandler(
        makeRequest('DELETE', { slug: TEAM_SLUG, routeId: ROUTE_ID, tokenId: TOKEN_ID }),
        res
      );
      expect(statusOf(res)).toBe(SENTINEL_STATUS);
      expect(readTokenModel.revokeReadToken).toHaveBeenCalledWith(TEAM_ID, ROUTE_ID, TOKEN_ID);
    }
  );

  it('OWNER + cross-team tokenId: 404 (updateMany matched nothing), no audit row', async () => {
    setRole(Role.OWNER);
    (routeModel.fetchRoute as jest.Mock).mockResolvedValue(ROUTE);
    (readTokenModel.revokeReadToken as jest.Mock).mockResolvedValue(null);
    const res = makeResponse();
    await readTokenRevokeHandler(
      makeRequest('DELETE', { slug: TEAM_SLUG, routeId: ROUTE_ID, tokenId: 'not-ours' }),
      res
    );
    expect(statusOf(res)).toBe(404);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it('OWNER + cross-team routeId: 404 before revokeReadToken', async () => {
    setRole(Role.OWNER);
    (routeModel.fetchRoute as jest.Mock).mockResolvedValue(null);
    const res = makeResponse();
    await readTokenRevokeHandler(
      makeRequest('DELETE', { slug: TEAM_SLUG, routeId: 'not-ours', tokenId: TOKEN_ID }),
      res
    );
    expect(statusOf(res)).toBe(404);
    expect(readTokenModel.revokeReadToken).not.toHaveBeenCalled();
  });
});
