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
  /**
   * [RELAY-68, found by the 2026-08-26 CFO review] `channelMrr` was returned as a bare,
   * unit-less number — real, but denominated in whatever `Price.currency` actually is
   * (USD today: `scripts/create-n8n-wedge-price.mjs` creates the n8n-wedge Price in
   * `usd`), while the ratified 90-day bar (`ceo-revenue-call-2026-08-19.md` §4) is
   * written in GBP (£50-200). Reading a bare `57` as "in band against £50" is reading
   * ~£42 as if it were ~£57 — the exact misreading the review caught. This field makes
   * the currency explicit so that mistake requires ignoring the field, not just missing
   * a comment. Deliberately NOT auto-converted to GBP: a live FX lookup is a new
   * dependency (RELAY-62 forbids new deps without cause) and a hardcoded rate would
   * silently drift wrong — the £0.02-per-check trade is doing the mental conversion
   * yourself at review time, informed by this field, rather than trusting a number that
   * quietly lies about its own unit.
   */
  currency: string | null;
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
    return { payingCustomerCount: 0, channelMrr: 0, currency: null };
  }

  const activeSubscriptions = await prisma.subscription.findMany({
    where: {
      customerId: { in: customerIds },
      active: true,
    },
    select: { customerId: true, priceId: true },
  });

  if (activeSubscriptions.length === 0) {
    return { payingCustomerCount: 0, channelMrr: 0, currency: null };
  }

  const priceIds = Array.from(
    new Set(activeSubscriptions.map((sub) => sub.priceId))
  );
  const prices = await prisma.price.findMany({
    where: { id: { in: priceIds } },
    select: { id: true, amount: true, currency: true },
  });
  const priceById = new Map(prices.map((p) => [p.id, p]));

  // Key by customerId, not by subscription row: a team could in principle have more
  // than one active Subscription row on record (e.g. a plan change lands as a new
  // row before the old one's `active` flips false), and that must count as ONE
  // paying customer contributing ONE price to MRR, not two — sync-stripe.js's own
  // amount field (real minor-unit-converted amount, per apps/dashboard/sync-stripe.js's
  // `unit_amount / 100`, never hardcoded here) is only ever summed once per
  // customer, keyed off the first active row seen for them.
  const pricePerCustomer = new Map<string, { amount: number; currency: string | null }>();
  for (const sub of activeSubscriptions) {
    if (!pricePerCustomer.has(sub.customerId)) {
      const price = priceById.get(sub.priceId);
      pricePerCustomer.set(sub.customerId, {
        amount: price?.amount ?? 0,
        currency: price?.currency ?? null,
      });
    }
  }

  const perCustomer = Array.from(pricePerCustomer.values());
  const channelMrr = perCustomer.reduce((sum, p) => sum + p.amount, 0);

  // Every price sold today is the single n8n-wedge Payment Link's USD price
  // (scripts/create-n8n-wedge-price.mjs), so this is always one currency in practice.
  // If that ever stops being true, report null rather than silently summing two
  // currencies together as if they were the same unit — a wrong-but-plausible-looking
  // number is worse here than an honest "can't tell you in one figure."
  const currencies = new Set(perCustomer.map((p) => p.currency));
  const currency = currencies.size === 1 ? Array.from(currencies)[0] : null;

  return {
    payingCustomerCount: pricePerCustomer.size,
    channelMrr,
    currency,
  };
}
