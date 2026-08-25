/**
 * @jest-environment node
 */

/**
 * [RELAY-63] Cross-team requests return a clean 404, not a 500 carrying a raw Prisma
 * error.
 *
 * ROOT CAUSE, MEASURED (by reading, then proven below)
 * -----------------------------------------------------
 * `models/team.ts`'s `getTeamMember` called `prisma.teamMember.findFirstOrThrow`.
 * When an authenticated user asks for a team they are NOT a member of, Prisma throws
 * `PrismaClientKnownRequestError` (P2025, "An operation failed because it depends on
 * one or more records that were required but not found. No TeamMember found").
 * `throwIfNoTeamAccess`'s own `if (!teamMember) throw ...` branch was DEAD CODE --
 * the `findFirstOrThrow` rejection happens first -- so every team-scoped handler's
 * generic `catch (error: any) { status: error.status || 500 }` had no `.status` to
 * read and the raw Prisma message reached the response body as an unhandled 500.
 * "it is BoxyHQ's `getTeamMember` behaving this way across every team-scoped route"
 * (ticket text) is exactly this function.
 *
 * WHY `models/team` IS NOT MOCKED HERE (unlike cross-tenant-isolation.spec.ts)
 * ------------------------------------------------------------------------------
 * `__tests__/relay/cross-tenant-isolation.spec.ts` deliberately mocks `models/team`
 * out, because that suite is about RESOURCE-id scoping (a routeId/dlqId belonging to
 * another team), not team resolution -- see its own file-header comment. Here the
 * team-resolution layer IS the thing under test, so `throwIfNoTeamAccess` /
 * `getTeamMember` / `getCurrentUserWithTeam` run for real, unmocked. Only
 * `@/lib/prisma` (no real Postgres in a jest process) and `@/lib/session` (no real
 * NextAuth session) are mocked -- the same minimal-mock shape
 * `__tests__/lib/rls-handlers.spec.ts` documents, for the same reason: the module
 * registry is keyed by resolved path, so mocking the module here also intercepts the
 * handlers' own `@/lib/prisma` / `@/lib/session` imports.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';

jest.mock('lib/prisma', () => ({
  prisma: {
    teamMember: { findFirst: jest.fn() },
  },
  unscopedPrisma: {},
}));

jest.mock('lib/session', () => ({
  getSession: jest.fn(),
}));

import { prisma } from 'lib/prisma';
import { getSession } from 'lib/session';

const mockFindFirst = (
  prisma as unknown as { teamMember: { findFirst: jest.Mock } }
).teamMember.findFirst;
const mockGetSession = getSession as jest.Mock;

// ─── req/res doubles — same shape __tests__/relay/cross-tenant-isolation.spec.ts uses ──

function makeRequest(method: string, query: Record<string, string>): NextApiRequest {
  const raw = Readable.from([]);
  return Object.assign(raw, {
    method,
    headers: { 'content-type': 'application/json' },
    query,
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

function loadHandler(
  path: string
): (req: NextApiRequest, res: NextApiResponse) => Promise<void> {
  let handler: ((req: NextApiRequest, res: NextApiResponse) => Promise<void>) | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    handler = require(path).default;
  });
  if (!handler) throw new Error(`${path} failed to load`);
  return handler;
}

// Substrings that would only appear in the response body if a raw Prisma error (or
// its stack) reached it. Not the full message -- just enough that any of Prisma's own
// error vocabulary failing to appear proves nothing ORM-shaped leaked.
const ORM_LEAK_MARKERS = ['Prisma', 'findFirstOrThrow', 'P2025', 'No TeamMember found'];

describe('[RELAY-63] cross-team request -> clean 404, no raw Prisma error', () => {
  const ATTACKER = { id: 'attacker-user-id', email: 'attacker@example.com', name: 'Attacker' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: ATTACKER });
  });

  describe('routes/index.ts GET — the endpoint the ticket was found on', () => {
    it('returns 404 with a fixed body, not 500 with a raw Prisma error', async () => {
      // Authenticated, real session -- just no TeamMember row for this slug. Post-fix,
      // findFirst answers null. Pre-fix, findFirstOrThrow would reject here instead,
      // and this assertion is what catches a regression back to that behaviour.
      mockFindFirst.mockResolvedValue(null);

      const handler = loadHandler('../../pages/api/teams/[slug]/relay/routes/index');
      const req = makeRequest('GET', { slug: 'team-the-attacker-does-not-belong-to' });
      const res = makeResponse();
      await handler(req, res);

      expect(statusOf(res)).toBe(404);
      expect(bodyOf(res)).toEqual({ error: { message: 'Team not found.' } });
      const raw = JSON.stringify(bodyOf(res));
      for (const marker of ORM_LEAK_MARKERS) {
        expect(raw).not.toContain(marker);
      }
    });
  });

  describe('dlq/index.ts GET — a second, independent endpoint (AC: at least two)', () => {
    it('returns 404 with a fixed body, not 500 with a raw Prisma error', async () => {
      mockFindFirst.mockResolvedValue(null);

      const handler = loadHandler('../../pages/api/teams/[slug]/relay/dlq/index');
      const req = makeRequest('GET', { slug: 'team-the-attacker-does-not-belong-to' });
      const res = makeResponse();
      await handler(req, res);

      expect(statusOf(res)).toBe(404);
      expect(bodyOf(res)).toEqual({ error: { message: 'Team not found.' } });
      const raw = JSON.stringify(bodyOf(res));
      for (const marker of ORM_LEAK_MARKERS) {
        expect(raw).not.toContain(marker);
      }
    });
  });

  describe('a genuine fault is still a 500 (AC: the fix must not hide real faults)', () => {
    it('an unrelated database failure surfaces as 500, not a swallowed 404', async () => {
      // Not the "no row" case -- an unrelated failure (dropped connection, timeout).
      // `findFirst` propagates this exactly as `findFirstOrThrow` always did; the fix
      // only changes what happens on NOT FOUND, never on a real error.
      mockFindFirst.mockRejectedValue(new Error('Connection terminated unexpectedly'));

      const handler = loadHandler('../../pages/api/teams/[slug]/relay/routes/index');
      const req = makeRequest('GET', { slug: 'any-team' });
      const res = makeResponse();
      await handler(req, res);

      expect(statusOf(res)).toBe(500);
    });
  });

  describe('models/team.ts getTeamMember() directly — the unit the ticket names', () => {
    it('resolves to null instead of throwing when no membership row exists', async () => {
      mockFindFirst.mockResolvedValue(null);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getTeamMember } = require('../../models/team');
      await expect(getTeamMember(ATTACKER.id, 'some-slug')).resolves.toBeNull();
    });
  });
});
