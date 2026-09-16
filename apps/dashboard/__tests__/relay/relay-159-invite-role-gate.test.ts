/**
 * @jest-environment node
 */

/**
 * [RELAY-159] ADMIN can escalate to OWNER via the invitation path -- lib/rbac.ts's
 * "Admin can't make anyone an Owner" rule was enforced on the members PATCH path
 * only (via validateMembershipOperation). pages/api/teams/[slug]/invitations.ts
 * POST accepts `role` through inviteViaEmailSchema (z.nativeEnum(Role)) with no
 * equivalent check, so an ADMIN could invite a new account as OWNER, have it
 * accepted, and that account could then demote/remove the real OWNER.
 *
 * This suite proves the fix -- assertCanAssignRole (extracted in lib/rbac.ts from
 * the same inline check validateMembershipOperation already used) is now called
 * from invitations.ts POST, BEFORE any invitation model function runs, using the
 * SAME 403 status and message as the members path.
 *
 * MODELED ON __tests__/relay/rbac-member-write-gate.test.ts: same makeRequest /
 * makeResponse / SENTINEL_STATUS pattern, and the same convention of mocking every
 * module the handler imports by its BARE path ('models/team', not '@/lib/...' or
 * '@/models/...') so this suite needs no database -- jest-resolve treats the bare
 * path and the handler's own `@/`-aliased import as the same file on disk.
 *
 * The "invite via link" branch (sentViaEmail: false) is used throughout so the
 * only model call in play is `createInvitation` -- no countTeamMembers /
 * getInvitationCount / email-domain-allowlist detour to also mock.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { Role } from '@prisma/client';

// ─── models/team mock — role is swapped per test, everything else is fixed. ──────────

jest.mock('models/team', () => ({
  __esModule: true,
  throwIfNoTeamAccess: jest.fn(),
  addTeamMember: jest.fn(),
}));

// ─── models/invitation, models/teamMember — mocked so this suite needs no DB. ────────
// Every export invitations.ts imports must be present, even if a given test never
// reaches it (the gate is expected to stop ADMIN-inviting-OWNER before it does).

jest.mock('models/invitation', () => ({
  __esModule: true,
  createInvitation: jest.fn(),
  deleteInvitation: jest.fn(),
  getInvitation: jest.fn(),
  getInvitationCount: jest.fn(),
  getInvitations: jest.fn(),
  isInvitationExpired: jest.fn(),
}));

jest.mock('models/teamMember', () => ({
  __esModule: true,
  countTeamMembers: jest.fn(),
}));

// `sendTeamInviteEmail` / `sendAudit` / `recordAuditEvent` / `recordMetric` are only
// called on a SUCCESS path this suite never reaches (ADMIN-inviting-OWNER is refused
// before them; the OWNER/ADMIN-allowed controls fail deliberately at the model layer
// -- see SENTINEL_STATUS). Mocked anyway so this suite never touches real
// email/Retraced/metrics code, same convention rbac-member-write-gate.test.ts uses
// for 'lib/audit' / 'lib/metrics'.
// NOTE: mocked by their BARE path -- jest.mock's factory argument is resolved by
// jest-resolve via `moduleDirectories` (jest.config.js includes `<rootDir>/`), not by
// the `@/lib/*` tsconfig path alias SWC rewrites `import` statements with. Both
// resolve to the same file on disk, so invitations.ts's own `@/lib/...` imports pick
// up these same mocks.
jest.mock('lib/email/sendTeamInviteEmail', () => ({
  __esModule: true,
  sendTeamInviteEmail: jest.fn(),
}));
jest.mock('lib/retraced', () => ({
  __esModule: true,
  sendAudit: jest.fn(),
}));
jest.mock('lib/audit', () => ({
  __esModule: true,
  recordAuditEvent: jest.fn(),
}));
jest.mock('lib/metrics', () => ({
  __esModule: true,
  recordMetric: jest.fn(),
}));

import { throwIfNoTeamAccess } from 'models/team';
import * as invitationModel from 'models/invitation';

import invitationsHandler from '../../pages/api/teams/[slug]/invitations';

// ─── req/res doubles — same shape as rbac-member-write-gate.test.ts ──────────────────

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
    end() {
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

const TEAM_ID = 'relay-159-team-id';
const TEAM_SLUG = 'relay-159-team-slug';
const USER = { id: 'relay-159-user-id', email: 'relay-159-caller@example.com', name: 'RELAY-159 Caller' };

/**
 * A distinctive status that is neither 403 (the role gate) nor any status the
 * handler's happy path would produce on its own -- proof that a mocked model
 * function was actually REACHED, not merely that *some* non-403 status came back.
 * Every "gate passes" assertion below checks for this exact number.
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
    team: { id: TEAM_ID, slug: TEAM_SLUG, name: 'RELAY-159 Test Team' },
    user: { ...USER },
  };
  (throwIfNoTeamAccess as jest.Mock).mockResolvedValue(teamMember);
}

// Invite-via-link body: no `email`, so this hits the second branch of
// inviteViaEmailSchema's z.union and skips the countTeamMembers/getInvitationCount/
// email-allowlist detour the invite-via-email branch would take.
const inviteBody = (role: Role) => ({ role, sentViaEmail: false });

beforeEach(() => {
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════════
// invitations.ts POST -- assertCanAssignRole(teamMember.role, role) must refuse an
// ADMIN caller granting OWNER, before createInvitation runs. OWNER inviting OWNER,
// and ADMIN inviting ADMIN/MEMBER, are controls proving the gate is role-specific,
// not a blanket block on the invitation endpoint.
// ═══════════════════════════════════════════════════════════════════════════════════

describe('invitations.ts — POST (invite a new team member) [RELAY-159]', () => {
  it('ADMIN inviting OWNER: 403, and createInvitation is never called', async () => {
    setRole(Role.ADMIN);

    const req = makeRequest('POST', { slug: TEAM_SLUG }, inviteBody(Role.OWNER));
    const res = makeResponse();
    await invitationsHandler(req, res);

    expect(statusOf(res)).toBe(403);
    expect(bodyOf(res)).toEqual({
      error: {
        message:
          'You do not have permission to update the role of this member to Owner.',
      },
    });
    expect(invitationModel.createInvitation).not.toHaveBeenCalled();
  });

  it('OWNER inviting OWNER: gate passes, createInvitation IS called', async () => {
    setRole(Role.OWNER);
    (invitationModel.createInvitation as jest.Mock).mockRejectedValue(
      new SentinelError()
    );

    const req = makeRequest('POST', { slug: TEAM_SLUG }, inviteBody(Role.OWNER));
    const res = makeResponse();
    await invitationsHandler(req, res);

    expect(statusOf(res)).toBe(SENTINEL_STATUS);
    expect(invitationModel.createInvitation).toHaveBeenCalled();
  });

  it('ADMIN inviting ADMIN: unchanged, gate passes and createInvitation IS called', async () => {
    setRole(Role.ADMIN);
    (invitationModel.createInvitation as jest.Mock).mockRejectedValue(
      new SentinelError()
    );

    const req = makeRequest('POST', { slug: TEAM_SLUG }, inviteBody(Role.ADMIN));
    const res = makeResponse();
    await invitationsHandler(req, res);

    expect(statusOf(res)).toBe(SENTINEL_STATUS);
    expect(invitationModel.createInvitation).toHaveBeenCalled();
  });

  it('ADMIN inviting MEMBER: unchanged, gate passes and createInvitation IS called', async () => {
    setRole(Role.ADMIN);
    (invitationModel.createInvitation as jest.Mock).mockRejectedValue(
      new SentinelError()
    );

    const req = makeRequest('POST', { slug: TEAM_SLUG }, inviteBody(Role.MEMBER));
    const res = makeResponse();
    await invitationsHandler(req, res);

    expect(statusOf(res)).toBe(SENTINEL_STATUS);
    expect(invitationModel.createInvitation).toHaveBeenCalled();
  });
});
