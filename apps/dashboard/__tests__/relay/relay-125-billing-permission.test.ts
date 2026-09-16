/**
 * @jest-environment node
 */

/**
 * [RELAY-125] The three Stripe billing handlers never consulted `lib/permissions.ts`.
 * `team_payments` is OWNER-only there, and the UI already hides Billing from every other
 * role (`components/team/TeamTab.tsx`, `pages/teams/[slug]/billing.tsx`), but the server
 * only ever called `throwIfNoTeamAccess` — any team MEMBER could open the live Billing
 * Portal, and merely GETting `products` lazily created the team's Stripe Customer with
 * the MEMBER's own email (`lib/stripe.ts getStripeCustomerId`).
 *
 * Director decision 2026-09-16: OWNER-only is correct; the table stays, the handlers gain
 * the check. This suite proves it the same way `rbac-member-write-gate.test.ts` does —
 * no database, the model layer mocked, and a SENTINEL status thrown from the FIRST
 * Stripe-touching call so "the gate let the caller through" is a distinct, measurable
 * outcome rather than "some non-403 status came back".
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { Role } from '@prisma/client';

jest.mock('models/team', () => ({
  __esModule: true,
  throwIfNoTeamAccess: jest.fn(),
}));

// The first Stripe-touching call in every handler under test. Throwing the sentinel here
// proves the role gate was passed AND that nothing Stripe-side ran for refused roles.
jest.mock('lib/stripe', () => ({
  __esModule: true,
  getStripeCustomerId: jest.fn(),
  stripe: {},
}));

jest.mock('lib/session', () => ({
  __esModule: true,
  getSession: jest.fn(async () => ({
    user: { id: 'u1', email: 'caller@example.com', name: 'Caller' },
  })),
}));

jest.mock('models/subscription', () => ({
  __esModule: true,
  getByCustomerId: jest.fn(),
}));
jest.mock('models/service', () => ({ __esModule: true, getAllServices: jest.fn() }));
jest.mock('models/price', () => ({ __esModule: true, getAllPrices: jest.fn() }));

import { throwIfNoTeamAccess } from 'models/team';
import { getStripeCustomerId } from 'lib/stripe';
import { getByCustomerId } from 'models/subscription';

import productsHandler from '../../pages/api/teams/[slug]/payments/products';
import portalHandler from '../../pages/api/teams/[slug]/payments/create-portal-link';
import checkoutHandler from '../../pages/api/teams/[slug]/payments/create-checkout-session';

const SENTINEL_STATUS = 418;
class SentinelError extends Error {
  status = SENTINEL_STATUS;
  constructor() {
    super('sentinel: reached the Stripe layer');
  }
}

function makeRequest(method: string, body?: unknown): NextApiRequest {
  const raw = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  );
  return Object.assign(raw, {
    method,
    headers: { 'content-type': 'application/json' },
    query: { slug: 'team-slug' },
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
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as NextApiResponse & { _status: number };
  return res;
}

const statusOf = (res: ReturnType<typeof makeResponse>) => (res as any)._status as number;

function setRole(role: (typeof Role)[keyof typeof Role]) {
  (throwIfNoTeamAccess as jest.Mock).mockResolvedValue({
    teamId: 't1',
    userId: 'u1',
    role,
    // A billingId + active subscription so create-portal-link's own, pre-existing
    // RELAY-49 free-tier lockout (which runs AFTER the role gate) doesn't mask the
    // gate result for the OWNER case. The refused-role cases never get that far.
    team: { id: 't1', slug: 'team-slug', billingId: 'cus_test' },
  });
}

const CASES: Array<[string, (req: NextApiRequest, res: NextApiResponse) => Promise<void>, string, unknown]> = [
  ['GET products', productsHandler, 'GET', undefined],
  ['POST create-portal-link', portalHandler, 'POST', {}],
  ['POST create-checkout-session', checkoutHandler, 'POST', { price: 'price_x', quantity: 1 }],
];

beforeEach(() => {
  jest.clearAllMocks();
  (getStripeCustomerId as jest.Mock).mockRejectedValue(new SentinelError());
  (getByCustomerId as jest.Mock).mockResolvedValue([{ active: true }]);
});

describe('[RELAY-125] team_payments is enforced server-side, OWNER-only', () => {
  describe.each(CASES)('%s', (_label, handler, method, body) => {
    it('MEMBER is refused with 403 before any Stripe call', async () => {
      setRole(Role.MEMBER);
      const res = makeResponse();
      await handler(makeRequest(method, body), res);
      expect(statusOf(res)).toBe(403);
      expect(getStripeCustomerId).not.toHaveBeenCalled();
    });

    it('ADMIN is refused with 403 before any Stripe call (table is OWNER-only by decision)', async () => {
      setRole(Role.ADMIN);
      const res = makeResponse();
      await handler(makeRequest(method, body), res);
      expect(statusOf(res)).toBe(403);
      expect(getStripeCustomerId).not.toHaveBeenCalled();
    });

    it('OWNER passes the gate and reaches the Stripe layer (sentinel)', async () => {
      setRole(Role.OWNER);
      const res = makeResponse();
      await handler(makeRequest(method, body), res);
      expect(statusOf(res)).toBe(SENTINEL_STATUS);
      expect(getStripeCustomerId).toHaveBeenCalledTimes(1);
    });
  });
});
