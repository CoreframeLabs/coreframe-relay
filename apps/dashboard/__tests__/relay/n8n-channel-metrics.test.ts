/**
 * [RELAY-68] Coverage for getN8nChannelMetrics (models/n8nChannelMetrics.ts) — the
 * count that gates the 90-day n8n-wedge goal (3-5 paying customers acquired
 * specifically through the n8n channel by 2026-11-17).
 *
 * Follows the bare-path/mocked-model pattern from
 * __tests__/relay/stripe-checkout-provisioning.test.ts: no real Postgres, `lib/prisma`
 * mocked, imported via bare `'models/n8nChannelMetrics'` (this repo's jest config does
 * not resolve `@/lib/*`).
 *
 * The mock for each prisma call actually APPLIES the `where` clause it was called with
 * against a small in-memory fixture, rather than just returning a hardcoded array —
 * this is what proves the model's own WHERE clauses are correct (the exclusions really
 * do exclude), not just that the JS after the query does the right thing with whatever
 * it's handed.
 *
 * Four seeded teams, one per case from the ticket:
 *   (a) team-a: attributed + paying                       → counts
 *   (b) team-b: paying, attributionSource null             → excluded (no attribution)
 *   (c) team-c: attributed, no active Subscription          → excluded (not paying)
 *   (d) team-d: isInternal=true + attributed + paying       → excluded (internal)
 */

import { getN8nChannelMetrics } from 'models/n8nChannelMetrics';
import { prisma } from 'lib/prisma';

jest.mock('lib/prisma', () => ({
  prisma: {
    team: { findMany: jest.fn() },
    subscription: { findMany: jest.fn() },
    price: { findMany: jest.fn() },
  },
}));

const mockTeamFindMany = prisma.team.findMany as jest.Mock;
const mockSubscriptionFindMany = prisma.subscription.findMany as jest.Mock;
const mockPriceFindMany = prisma.price.findMany as jest.Mock;

const TEAMS = [
  {
    id: 'team-a',
    billingId: 'cus_a',
    billingProvider: 'stripe',
    isInternal: false,
    attributionSource: 'n8n_community',
  },
  {
    id: 'team-b',
    billingId: 'cus_b',
    billingProvider: 'stripe',
    isInternal: false,
    attributionSource: null,
  },
  {
    id: 'team-c',
    billingId: 'cus_c',
    billingProvider: 'stripe',
    isInternal: false,
    attributionSource: 'devto',
  },
  {
    id: 'team-d',
    billingId: 'cus_d',
    billingProvider: 'stripe',
    isInternal: true,
    attributionSource: 'r_n8n',
  },
];

const SUBSCRIPTIONS = [
  { customerId: 'cus_a', priceId: 'price_19', active: true },
  { customerId: 'cus_b', priceId: 'price_19', active: true },
  { customerId: 'cus_d', priceId: 'price_19', active: true },
  // cus_c has no Subscription row at all — this is what makes case (c) "not paying".
];

const PRICES = [{ id: 'price_19', amount: 19, currency: 'usd' }];

function installMocks() {
  // Simulates Postgres applying the model's own `where` against the fixture.
  mockTeamFindMany.mockImplementation(({ where }) => {
    const allowlist: string[] = where.attributionSource.in;
    return Promise.resolve(
      TEAMS.filter(
        (t) =>
          t.billingProvider === where.billingProvider &&
          t.billingId !== null &&
          t.isInternal === where.isInternal &&
          t.attributionSource !== null &&
          allowlist.includes(t.attributionSource)
      ).map((t) => ({ billingId: t.billingId }))
    );
  });

  mockSubscriptionFindMany.mockImplementation(({ where }) => {
    const ids: string[] = where.customerId.in;
    return Promise.resolve(
      SUBSCRIPTIONS.filter(
        (s) => ids.includes(s.customerId) && s.active === where.active
      )
    );
  });

  mockPriceFindMany.mockImplementation(({ where }) => {
    const ids: string[] = where.id.in;
    return Promise.resolve(PRICES.filter((p) => ids.includes(p.id)));
  });
}

describe('[n8n channel metrics] getN8nChannelMetrics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installMocks();
  });

  it('(a) counts a team that is attributed to an allowlisted UTM source and paying', async () => {
    const result = await getN8nChannelMetrics();

    expect(result.payingCustomerCount).toBe(1);
    expect(result.channelMrr).toBe(19);
    expect(result.currency).toBe('usd');
  });

  it('[CFO review, 2026-08-26] currency is null (not silently mixed) when active subscriptions span more than one currency', async () => {
    mockPriceFindMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
      Promise.resolve([
        { id: 'price_19', amount: 19, currency: 'usd' },
        { id: 'price_20_eur', amount: 20, currency: 'eur' },
      ].filter((p) => where.id.in.includes(p.id)))
    );
    mockSubscriptionFindMany.mockResolvedValueOnce([
      { customerId: 'cus_a', priceId: 'price_19', active: true },
      { customerId: 'cus_c', priceId: 'price_20_eur', active: true },
    ]);

    const result = await getN8nChannelMetrics();

    expect(result.payingCustomerCount).toBe(2);
    expect(result.channelMrr).toBe(39);
    expect(result.currency).toBeNull();
  });

  it('(b) excludes a paying team with attributionSource=null — never reaches the eligible-teams result', async () => {
    await getN8nChannelMetrics();

    const eligibleTeams = await mockTeamFindMany.mock.results[0].value;
    expect(eligibleTeams.map((t: { billingId: string }) => t.billingId)).not.toContain(
      'cus_b'
    );

    const subscriptionCallArgs = mockSubscriptionFindMany.mock.calls[0][0];
    expect(subscriptionCallArgs.where.customerId.in).not.toContain('cus_b');
  });

  it('(c) excludes an attributed, non-internal team with no active Subscription', async () => {
    const result = await getN8nChannelMetrics();

    // cus_c IS in the eligible-teams result (attributed, non-internal, stripe) —
    // it's the subscription fixture (no row for cus_c) that excludes it from paying.
    const eligibleTeams = await mockTeamFindMany.mock.results[0].value;
    expect(eligibleTeams.map((t: { billingId: string }) => t.billingId)).toContain(
      'cus_c'
    );
    // Only cus_a actually counts.
    expect(result.payingCustomerCount).toBe(1);
    expect(result.channelMrr).toBe(19);
  });

  it('(d) excludes an internal team even when attributed and paying', async () => {
    await getN8nChannelMetrics();

    const eligibleTeams = await mockTeamFindMany.mock.results[0].value;
    expect(eligibleTeams.map((t: { billingId: string }) => t.billingId)).not.toContain(
      'cus_d'
    );

    const subscriptionCallArgs = mockSubscriptionFindMany.mock.calls[0][0];
    expect(subscriptionCallArgs.where.customerId.in).not.toContain('cus_d');
  });

  it('returns zero metrics and skips downstream queries when no team is eligible', async () => {
    mockTeamFindMany.mockResolvedValueOnce([]);

    const result = await getN8nChannelMetrics();

    expect(result).toEqual({ payingCustomerCount: 0, channelMrr: 0, currency: null });
    expect(mockSubscriptionFindMany).not.toHaveBeenCalled();
    expect(mockPriceFindMany).not.toHaveBeenCalled();
  });

  it('counts one paying customer once even with more than one active Subscription row for the same customerId', async () => {
    mockSubscriptionFindMany.mockResolvedValueOnce([
      { customerId: 'cus_a', priceId: 'price_19', active: true },
      { customerId: 'cus_a', priceId: 'price_19', active: true },
    ]);

    const result = await getN8nChannelMetrics();

    expect(result.payingCustomerCount).toBe(1);
    expect(result.channelMrr).toBe(19);
  });
});
