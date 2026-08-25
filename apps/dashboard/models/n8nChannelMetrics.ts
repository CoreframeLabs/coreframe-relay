import { prisma } from '@/lib/prisma';

/**
 * [RELAY-68] The six UTM `utm_source` values RELAY-70's marketing content (n8n
 * community posts, the n8n workflow/node registry listing, devto/IndieHackers
 * articles, the n8n docs integration page, this repo's own README) is tagged with.
 * Must stay in sync with whatever RELAY-70 actually ships — this is the allowlist
 * side of that contract, not the content side.
 */
export const N8N_CHANNEL_UTM_SOURCES = [
  'n8n_community',
  'r_n8n',
  'indiehackers',
  'devto',
  'n8n_registry',
  'n8n_docs',
] as const;

export type N8nChannelUtmSource = (typeof N8N_CHANNEL_UTM_SOURCES)[number];

export type N8nChannelMetrics = {
  payingCustomerCount: number;
  channelMrr: number;
};

/**
 * [RELAY-68] Counts teams that are both attributed to the n8n channel and actually
 * paying, and sums their MRR.
 *
 * "Paying" is defined the way models/subscription.ts already reads it — an active
 * Subscription row for the team's billingId — NOT Team.plan. schema.prisma's own
 * doc-comment on Team.plan records why: nothing in this codebase ever writes
 * PRO/ENTERPRISE to that column (pages/api/webhooks/stripe.ts's
 * handleCheckoutSessionCompleted only ever sets billingId/billingProvider), so a
 * query keyed on Team.plan would find zero paying teams regardless of reality.
 *
 * "The n8n-wedge tier" is, for now, simply "any active Subscription at all":
 * scripts/create-n8n-wedge-price.mjs's Payment Link is the only Stripe product this
 * app currently sells (pages/pricing.tsx renders exactly one Payment Link), so any
 * matching active Subscription is by construction that tier. FOLLOW-UP: this
 * assumption breaks the day RELAY-49 ships a general tier ladder with more than one
 * sellable price — at that point this query needs an explicit price/product filter,
 * not just a wider read, or it will count non-n8n-wedge subscriptions as channel MRR.
 */
export async function getN8nChannelMetrics(): Promise<N8nChannelMetrics> {
  const teams = await prisma.team.findMany({
    where: {
      billingProvider: 'stripe',
      billingId: { not: null },
      isInternal: false,
      attributionSource: { in: [...N8N_CHANNEL_UTM_SOURCES] },
    },
    select: { billingId: true },
  });

  const customerIds = teams
    .map((team) => team.billingId)
    .filter((id): id is string => Boolean(id));

  if (customerIds.length === 0) {
    return { payingCustomerCount: 0, channelMrr: 0 };
  }

  const activeSubscriptions = await prisma.subscription.findMany({
    where: {
      customerId: { in: customerIds },
      active: true,
    },
    select: { customerId: true, priceId: true },
  });

  if (activeSubscriptions.length === 0) {
    return { payingCustomerCount: 0, channelMrr: 0 };
  }

  const priceIds = Array.from(
    new Set(activeSubscriptions.map((sub) => sub.priceId))
  );
  const prices = await prisma.price.findMany({
    where: { id: { in: priceIds } },
    select: { id: true, amount: true },
  });
  const amountByPriceId = new Map(prices.map((p) => [p.id, p.amount ?? 0]));

  // Key by customerId, not by subscription row: a team could in principle have more
  // than one active Subscription row on record (e.g. a plan change lands as a new
  // row before the old one's `active` flips false), and that must count as ONE
  // paying customer contributing ONE price to MRR, not two — sync-stripe.js's own
  // amount field (real dollars, per apps/dashboard/sync-stripe.js's
  // `unit_amount / 100`, never hardcoded here) is only ever summed once per
  // customer, keyed off the first active row seen for them.
  const pricePerCustomer = new Map<string, number>();
  for (const sub of activeSubscriptions) {
    if (!pricePerCustomer.has(sub.customerId)) {
      pricePerCustomer.set(
        sub.customerId,
        amountByPriceId.get(sub.priceId) ?? 0
      );
    }
  }

  const channelMrr = Array.from(pricePerCustomer.values()).reduce(
    (sum, amount) => sum + amount,
    0
  );

  return {
    payingCustomerCount: pricePerCustomer.size,
    channelMrr,
  };
}
