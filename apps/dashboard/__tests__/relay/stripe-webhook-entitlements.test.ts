/**
 * [RELAY-49] Coverage for two of the ticket's own acceptance criteria that had zero
 * test coverage before this ticket:
 *
 *  - AC3 ("the Stripe webhook consumer updates plan entitlements on subscription
 *    events") — before this ticket, `handleSubscriptionCreated` hardcoded
 *    `active: true` regardless of the real Stripe status, and nothing anywhere in
 *    the webhook consumer ever wrote `Team.plan`. RELAY-13's own schema comment on
 *    `Team.plan` says plainly "nothing currently sets this to PRO" — this suite
 *    proves the write side now exists and is correct across created/updated/deleted
 *    events, including the out-of-order-delivery and multi-subscription cases.
 *
 *  - AC5 ("an invalid webhook signature returns 401 with no leak") — before this
 *    ticket, an invalid/missing signature returned 400 with the raw Stripe SDK
 *    error message in the response body (or, for a missing signature header/secret,
 *    a bare `return` with no status set at all). This suite proves the real POST
 *    handler now returns 401 with a fixed, generic body in every failure shape.
 *
 * Real mocked model calls throughout, no live database — this is pure branching
 * logic, matching the existing `stripe-checkout-provisioning.test.ts` suite's own
 * justification for the same choice.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import type Stripe from 'stripe';

const mockConstructEvent = jest.fn();

jest.mock('lib/stripe', () => ({
  stripe: { webhooks: { constructEvent: (...args: any[]) => mockConstructEvent(...args) } },
}));
jest.mock('lib/env', () => ({
  __esModule: true,
  default: { stripe: { webhookSecret: 'whsec_test' } },
}));

jest.mock('models/team', () => ({
  getTeam: jest.fn(),
  getTeams: jest.fn(),
  updateTeam: jest.fn(),
  getByCustomerId: jest.fn(),
}));

jest.mock('models/subscription', () => ({
  createStripeSubscription: jest.fn(),
  deleteStripeSubscription: jest.fn(),
  updateStripeSubscription: jest.fn(),
  getBySubscriptionId: jest.fn(),
  getByCustomerId: jest.fn(),
}));

jest.mock('lib/prisma', () => ({
  prisma: { user: { findUnique: jest.fn() } },
}));

import POST, {
  handleSubscriptionCreated,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  syncTeamPlanForCustomer,
  isEntitledStatus,
} from 'pages/api/webhooks/stripe';
import { getByCustomerId as getTeamByCustomerId, updateTeam } from 'models/team';
import {
  createStripeSubscription,
  deleteStripeSubscription,
  updateStripeSubscription,
  getBySubscriptionId,
  getByCustomerId as getSubscriptionsByCustomerId,
} from 'models/subscription';

const mockGetTeamByCustomerId = getTeamByCustomerId as jest.Mock;
const mockUpdateTeam = updateTeam as jest.Mock;
const mockCreateStripeSubscription = createStripeSubscription as jest.Mock;
const mockDeleteStripeSubscription = deleteStripeSubscription as jest.Mock;
const mockUpdateStripeSubscription = updateStripeSubscription as jest.Mock;
const mockGetBySubscriptionId = getBySubscriptionId as jest.Mock;
const mockGetSubscriptionsByCustomerId = getSubscriptionsByCustomerId as jest.Mock;

function makeSubscriptionEvent(
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Event {
  return {
    id: 'evt_test_1',
    type: 'customer.subscription.created',
    data: {
      object: {
        id: 'sub_test_1',
        customer: 'cus_test_1',
        status: 'active',
        current_period_start: 1_700_000_000,
        current_period_end: 1_702_592_000,
        cancel_at: null,
        items: { data: [{ plan: { id: 'price_1U67d7FxMn2UXI5YBuA94Tcb' } }] },
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

function makeReqRes(body: string, signature: string | undefined) {
  const chunks = [Buffer.from(body)];
  const req = {
    headers: signature !== undefined ? { 'stripe-signature': signature } : {},
    // Next's raw-body reader (`getRawBody` in the module under test) treats the
    // request as an async iterable of chunks — this stub satisfies that contract
    // without needing a real HTTP socket.
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as NextApiRequest;

  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status } as unknown as NextApiResponse;

  return { req, res, status, json };
}

describe('[stripe webhook] AC5 — invalid signature returns 401 with no leak', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns 401 with a fixed, generic body when signature verification throws', async () => {
    const sensitiveDetail =
      'No signatures found matching the expected signature for payload. whsec_REAL_SECRET_LEAK_TEST';
    mockConstructEvent.mockImplementation(() => {
      throw new Error(sensitiveDetail);
    });

    const { req, res, status, json } = makeReqRes('{"id":"evt_1"}', 't=1,v1=bad');
    await POST(req, res);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { message: 'Invalid signature' } });
    // The exact assertion this AC cares about: whatever the real Stripe SDK said
    // about WHY verification failed must never reach the HTTP response body.
    const [responseBody] = json.mock.calls[0];
    expect(JSON.stringify(responseBody)).not.toContain(sensitiveDetail);
    expect(JSON.stringify(responseBody)).not.toContain('whsec_');
  });

  it('returns 401 (not a hang / bare 200) when the stripe-signature header is missing entirely', async () => {
    const { req, res, status, json } = makeReqRes('{"id":"evt_1"}', undefined);
    await POST(req, res);

    expect(mockConstructEvent).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: { message: 'Invalid signature' } });
  });

  it('never returns 200 or 400 for a bad signature — 401 specifically, per the AC', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('bad sig');
    });
    const { req, res, status } = makeReqRes('{}', 't=1,v1=bad');
    await POST(req, res);

    expect(status).not.toHaveBeenCalledWith(200);
    expect(status).not.toHaveBeenCalledWith(400);
    expect(status).toHaveBeenCalledWith(401);
  });

  it('still processes a validly-signed event normally (401 handling did not break the happy path)', async () => {
    mockConstructEvent.mockReturnValue(
      makeSubscriptionEvent({ status: 'active' })
    );
    mockGetTeamByCustomerId.mockResolvedValue({
      id: 'team-x',
      slug: 'team-x',
      plan: 'FREE',
    });
    mockGetSubscriptionsByCustomerId.mockResolvedValue([
      { id: 'sub_test_1', customerId: 'cus_test_1', active: true },
    ]);

    const { req, res, status, json } = makeReqRes('{}', 't=1,v1=good');
    await POST(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ received: true });
  });
});

describe('[stripe webhook] AC3 — plan entitlement sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isEntitledStatus', () => {
    it.each([
      ['active', true],
      ['trialing', true],
      ['canceled', false],
      ['incomplete', false],
      ['incomplete_expired', false],
      ['past_due', false],
      ['paused', false],
      ['unpaid', false],
    ] as const)('%s -> %s', (status, expected) => {
      expect(isEntitledStatus(status)).toBe(expected);
    });
  });

  describe('handleSubscriptionCreated', () => {
    it('derives Subscription.active from the real status, not a hardcoded true', async () => {
      mockGetTeamByCustomerId.mockResolvedValue(undefined);

      await handleSubscriptionCreated(
        makeSubscriptionEvent({ status: 'incomplete' })
      );

      expect(mockCreateStripeSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ active: false })
      );
    });

    it('sets Team.plan to PRO when a newly created subscription is active and a team is already linked', async () => {
      mockGetTeamByCustomerId.mockResolvedValue({
        id: 'team-1',
        slug: 'team-one',
        plan: 'FREE',
      });
      mockGetSubscriptionsByCustomerId.mockResolvedValue([
        { id: 'sub_test_1', customerId: 'cus_test_1', active: true },
      ]);

      await handleSubscriptionCreated(makeSubscriptionEvent({ status: 'active' }));

      expect(mockUpdateTeam).toHaveBeenCalledWith('team-one', { plan: 'PRO' });
    });

    it('does NOT touch Team.plan for a customer with no linked team yet (webhook arrived before checkout.session.completed)', async () => {
      mockGetTeamByCustomerId.mockResolvedValue(undefined);

      await handleSubscriptionCreated(makeSubscriptionEvent({ status: 'active' }));

      expect(mockUpdateTeam).not.toHaveBeenCalled();
    });
  });

  describe('handleSubscriptionUpdated', () => {
    it('flips Team.plan back to FREE when a subscription moves to past_due', async () => {
      mockGetBySubscriptionId.mockResolvedValue({ id: 'sub_test_1' });
      mockGetTeamByCustomerId.mockResolvedValue({
        id: 'team-2',
        slug: 'team-two',
        plan: 'PRO',
      });
      mockGetSubscriptionsByCustomerId.mockResolvedValue([
        { id: 'sub_test_1', customerId: 'cus_test_1', active: false },
      ]);

      await handleSubscriptionUpdated(
        makeSubscriptionEvent({ status: 'past_due' })
      );

      expect(mockUpdateStripeSubscription).toHaveBeenCalledWith(
        'sub_test_1',
        expect.objectContaining({ active: false })
      );
      expect(mockUpdateTeam).toHaveBeenCalledWith('team-two', { plan: 'FREE' });
    });

    it('flips Team.plan to PRO when a subscription recovers from past_due to active', async () => {
      mockGetBySubscriptionId.mockResolvedValue({ id: 'sub_test_1' });
      mockGetTeamByCustomerId.mockResolvedValue({
        id: 'team-3',
        slug: 'team-three',
        plan: 'FREE',
      });
      mockGetSubscriptionsByCustomerId.mockResolvedValue([
        { id: 'sub_test_1', customerId: 'cus_test_1', active: true },
      ]);

      await handleSubscriptionUpdated(makeSubscriptionEvent({ status: 'active' }));

      expect(mockUpdateTeam).toHaveBeenCalledWith('team-three', { plan: 'PRO' });
    });
  });

  describe('handleSubscriptionDeleted', () => {
    it('reverts Team.plan to FREE once the last active subscription is deleted', async () => {
      mockGetTeamByCustomerId.mockResolvedValue({
        id: 'team-4',
        slug: 'team-four',
        plan: 'PRO',
      });
      // The now-deleted row no longer comes back from a fresh DB read.
      mockGetSubscriptionsByCustomerId.mockResolvedValue([]);

      await handleSubscriptionDeleted(makeSubscriptionEvent({ status: 'canceled' }));

      expect(mockDeleteStripeSubscription).toHaveBeenCalledWith('sub_test_1');
      expect(mockUpdateTeam).toHaveBeenCalledWith('team-four', { plan: 'FREE' });
    });

    it('does NOT downgrade a team that still has another active subscription (e.g. a plan-change artifact)', async () => {
      mockGetTeamByCustomerId.mockResolvedValue({
        id: 'team-5',
        slug: 'team-five',
        plan: 'PRO',
      });
      // A second, still-active subscription row survives the deletion of this one.
      mockGetSubscriptionsByCustomerId.mockResolvedValue([
        { id: 'sub_test_other', customerId: 'cus_test_1', active: true },
      ]);

      await handleSubscriptionDeleted(makeSubscriptionEvent());

      expect(mockUpdateTeam).not.toHaveBeenCalled();
    });
  });

  describe('syncTeamPlanForCustomer', () => {
    it('is a silent no-op for a customerId with no linked team', async () => {
      mockGetTeamByCustomerId.mockResolvedValue(undefined);

      await expect(syncTeamPlanForCustomer('cus_unlinked')).resolves.toBeUndefined();
      expect(mockGetSubscriptionsByCustomerId).not.toHaveBeenCalled();
      expect(mockUpdateTeam).not.toHaveBeenCalled();
    });

    it('does not write when the derived plan already matches the current one (idempotent)', async () => {
      mockGetTeamByCustomerId.mockResolvedValue({
        id: 'team-6',
        slug: 'team-six',
        plan: 'PRO',
      });
      mockGetSubscriptionsByCustomerId.mockResolvedValue([
        { id: 'sub_x', customerId: 'cus_test_1', active: true },
      ]);

      await syncTeamPlanForCustomer('cus_test_1');

      expect(mockUpdateTeam).not.toHaveBeenCalled();
    });
  });
});
