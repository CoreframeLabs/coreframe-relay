/**
 * @jest-environment node
 */

/**
 * [RELAY-165] The webhook handler read `current_period_start/end` off the top of the
 * Subscription object. The production endpoint is pinned to Stripe API
 * `2025-05-28.basil`, where those fields exist ONLY on each subscription item — so
 * every real `customer.subscription.created` built an Invalid Date, Prisma threw, the
 * handler answered 400, and Stripe kept the event pending forever. The existing
 * `stripe-webhook-entitlements.test.ts` fakes the OLD shape (top-level fields), which
 * is exactly why 31 passing tests never caught it.
 *
 * The fixture below is the real shape captured from production on 2026-09-17
 * (`evt_1UGk6sFxMn2UXI5YfJacSM8P`, ids and timestamps kept, secrets none): no
 * `current_period_*` at the top level, both on `items.data[0]`.
 */

import type Stripe from 'stripe';

jest.mock('lib/stripe', () => ({ stripe: { webhooks: { constructEvent: jest.fn() } } }));
jest.mock('lib/env', () => ({ __esModule: true, default: { stripe: { webhookSecret: 'whsec_test' } } }));
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
jest.mock('lib/prisma', () => ({ prisma: { user: { findUnique: jest.fn() } } }));

import { handleSubscriptionCreated, handleSubscriptionUpdated } from '../../pages/api/webhooks/stripe';
import {
  createStripeSubscription,
  updateStripeSubscription,
  getBySubscriptionId,
  getByCustomerId as getSubscriptionsByCustomerId,
} from 'models/subscription';
import { getByCustomerId as getTeamByCustomerId } from 'models/team';

const START = 1789669956;
const END = 1792261956;

function basilEvent(type: string, overrides: Record<string, unknown> = {}): Stripe.Event {
  return {
    id: 'evt_1UGk6sFxMn2UXI5YfJacSM8P',
    type,
    api_version: '2025-05-28.basil',
    data: {
      object: {
        id: 'sub_1UGk6qFxMn2UXI5Yh1Qghasy',
        object: 'subscription',
        customer: 'cus_VHIiR8OIUptnDE',
        status: 'active',
        cancel_at: null,
        // NOTE: deliberately no current_period_start / current_period_end here.
        items: {
          data: [
            {
              id: 'si_test',
              current_period_start: START,
              current_period_end: END,
              plan: { id: 'price_1U67d7FxMn2UXI5YBuA94Tcb' },
              price: { id: 'price_1U67d7FxMn2UXI5YBuA94Tcb' },
            },
          ],
        },
        ...overrides,
      },
    },
  } as unknown as Stripe.Event;
}

beforeEach(() => {
  jest.clearAllMocks();
  (getTeamByCustomerId as jest.Mock).mockResolvedValue({ id: 't1', slug: 'team' });
  (getSubscriptionsByCustomerId as jest.Mock).mockResolvedValue([{ active: true, priceId: 'price_1U67d7FxMn2UXI5YBuA94Tcb' }]);
});

describe('[RELAY-165] Basil-shaped subscription events (period on the item)', () => {
  it('customer.subscription.created writes a real, valid period from the item', async () => {
    await handleSubscriptionCreated(basilEvent('customer.subscription.created'));
    expect(createStripeSubscription).toHaveBeenCalledTimes(1);
    const arg = (createStripeSubscription as jest.Mock).mock.calls[0][0];
    expect(arg.startDate).toBeInstanceOf(Date);
    expect(Number.isNaN(arg.startDate.getTime())).toBe(false);
    expect(arg.startDate.getTime()).toBe(START * 1000);
    expect(arg.endDate.getTime()).toBe(END * 1000);
    expect(arg.active).toBe(true);
    expect(arg.priceId).toBe('price_1U67d7FxMn2UXI5YBuA94Tcb');
  });

  it('still accepts the pre-Basil top-level shape', async () => {
    await handleSubscriptionCreated(
      basilEvent('customer.subscription.created', {
        current_period_start: 1_700_000_000,
        current_period_end: 1_702_592_000,
        items: { data: [{ plan: { id: 'price_x' } }] },
      })
    );
    const arg = (createStripeSubscription as jest.Mock).mock.calls[0][0];
    expect(arg.startDate.getTime()).toBe(1_700_000_000 * 1000);
  });

  it('throws (so the handler 400s and Stripe retries) rather than writing an Invalid Date when no period exists anywhere', async () => {
    await expect(
      handleSubscriptionCreated(
        basilEvent('customer.subscription.created', { items: { data: [{ plan: { id: 'price_x' } }] } })
      )
    ).rejects.toThrow(/no billing period/);
    expect(createStripeSubscription).not.toHaveBeenCalled();
  });

  it('customer.subscription.updated reads the period from the item too', async () => {
    (getBySubscriptionId as jest.Mock).mockResolvedValue({ id: 'sub_1UGk6qFxMn2UXI5Yh1Qghasy' });
    await handleSubscriptionUpdated(basilEvent('customer.subscription.updated'));
    expect(updateStripeSubscription).toHaveBeenCalledTimes(1);
    const [, data] = (updateStripeSubscription as jest.Mock).mock.calls[0];
    expect(data.startDate.getTime()).toBe(START * 1000);
    expect(data.endDate.getTime()).toBe(END * 1000);
  });
});
