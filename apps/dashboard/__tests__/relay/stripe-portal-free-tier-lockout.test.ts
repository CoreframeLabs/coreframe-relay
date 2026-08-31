/**
 * [RELAY-49, AC5] "A Free-tier team is correctly locked out of paid nav."
 *
 * The Customer Portal's whole purpose is managing an EXISTING paid subscription.
 * Before this ticket, `create-portal-link.ts` would happily call
 * `stripe.billingPortal.sessions.create()` for ANY team, including one with no
 * `billingId` (which `getStripeCustomerId` would silently paper over by minting a
 * brand-new, empty Stripe customer) or one whose subscription had been cancelled.
 * Either way, a Free-tier team got a real Stripe portal session with nothing to
 * manage — this suite proves the API now refuses both cases with 403 instead,
 * and only ever calls Stripe for a team with a real, currently-active
 * subscription.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

const mockThrowIfNoTeamAccess = jest.fn();
const mockGetSession = jest.fn();
const mockGetSubscriptionsByCustomerId = jest.fn();
const mockGetStripeCustomerId = jest.fn();
const mockCreatePortalSession = jest.fn();

jest.mock('models/team', () => ({
  throwIfNoTeamAccess: (...args: any[]) => mockThrowIfNoTeamAccess(...args),
}));
jest.mock('lib/session', () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
}));
jest.mock('models/subscription', () => ({
  getByCustomerId: (...args: any[]) => mockGetSubscriptionsByCustomerId(...args),
}));
jest.mock('lib/stripe', () => ({
  stripe: {
    billingPortal: {
      sessions: { create: (...args: any[]) => mockCreatePortalSession(...args) },
    },
  },
  getStripeCustomerId: (...args: any[]) => mockGetStripeCustomerId(...args),
}));
jest.mock('lib/env', () => ({
  __esModule: true,
  default: { appUrl: 'http://localhost:4002' },
}));

import handler from 'pages/api/teams/[slug]/payments/create-portal-link';

function makeReqRes() {
  const req = { method: 'POST' } as unknown as NextApiRequest;
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status, json } as unknown as NextApiResponse;
  return { req, res, status, json };
}

describe('[create-portal-link] AC5 — Free-tier team locked out of the Customer Portal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('403s a team with no billingId at all — never mints a blank Stripe customer just to open a portal', async () => {
    mockThrowIfNoTeamAccess.mockResolvedValue({
      team: { slug: 'free-team', billingId: null },
    });
    mockGetSession.mockResolvedValue({ user: { email: 'owner@example.com' } });

    const { req, res, status, json } = makeReqRes();
    await handler(req, res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String) }) })
    );
    expect(mockGetSubscriptionsByCustomerId).not.toHaveBeenCalled();
    expect(mockCreatePortalSession).not.toHaveBeenCalled();
  });

  it('403s a team with a billingId but no active subscription (e.g. cancelled) — checked against the real Subscription table, not the cached billingId alone', async () => {
    mockThrowIfNoTeamAccess.mockResolvedValue({
      team: { slug: 'lapsed-team', billingId: 'cus_lapsed' },
    });
    mockGetSession.mockResolvedValue({ user: { email: 'owner@example.com' } });
    mockGetSubscriptionsByCustomerId.mockResolvedValue([
      { id: 'sub_old', customerId: 'cus_lapsed', active: false },
    ]);

    const { req, res, status } = makeReqRes();
    await handler(req, res);

    expect(mockGetSubscriptionsByCustomerId).toHaveBeenCalledWith('cus_lapsed');
    expect(status).toHaveBeenCalledWith(403);
    expect(mockCreatePortalSession).not.toHaveBeenCalled();
  });

  it('creates a real portal session for a team with a currently-active subscription — the paying-team path, unaffected', async () => {
    mockThrowIfNoTeamAccess.mockResolvedValue({
      team: { slug: 'paying-team', billingId: 'cus_paying' },
    });
    mockGetSession.mockResolvedValue({ user: { email: 'owner@example.com' } });
    mockGetSubscriptionsByCustomerId.mockResolvedValue([
      { id: 'sub_active', customerId: 'cus_paying', active: true },
    ]);
    mockGetStripeCustomerId.mockResolvedValue('cus_paying');
    mockCreatePortalSession.mockResolvedValue({ url: 'https://billing.stripe.com/session/test_123' });

    const { req, res, json } = makeReqRes();
    await handler(req, res);

    expect(mockCreatePortalSession).toHaveBeenCalledWith({
      customer: 'cus_paying',
      return_url: 'http://localhost:4002/teams/paying-team/billing',
    });
    expect(json).toHaveBeenCalledWith({
      data: { url: 'https://billing.stripe.com/session/test_123' },
    });
  });
});
