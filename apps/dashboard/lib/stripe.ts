import Stripe from 'stripe';
import env from '@/lib/env';
import { updateTeam } from 'models/team';

/**
 * [RELAY-161] Constructed lazily, on first property access, NOT at import time.
 *
 * `new Stripe('')` throws "Neither apiKey nor config.authenticator provided", and
 * this module used to call it at the top level — so on any deployment without
 * `STRIPE_SECRET_KEY` (production today: only `STRIPE_WEBHOOK_SECRET` is set), every
 * API route that merely IMPORTED this file crashed at module load, before its own
 * feature-flag check or role gate could run. Callers got a bare 500 HTML page
 * instead of the `env.teamFeatures.payments` 404 those handlers are written to
 * return. Found 2026-09-16 by exercising RELAY-125's gate against real production
 * with a real MEMBER session: the request never reached the gate.
 *
 * A Proxy keeps the `stripe.customers.create(...)` call shape every importer already
 * uses; the SDK is built once, on first use, and only then does a missing key throw —
 * inside the handler's own try/catch, where it becomes a JSON error, not a crash.
 */
let client: Stripe | null = null;
function getClient(): Stripe {
  if (!client) {
    if (!env.stripe.secretKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured on this deployment');
    }
    client = new Stripe(env.stripe.secretKey);
  }
  return client;
}
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const instance = getClient();
    const value = (instance as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(instance)
      : value;
  },
});

export async function getStripeCustomerId(teamMember, session?: any) {
  let customerId = '';
  if (!teamMember.team.billingId) {
    const customerData: {
      metadata: { teamId: string };
      email?: string;
    } = {
      metadata: {
        teamId: teamMember.teamId,
      },
    };
    if (session?.user?.email) {
      customerData.email = session?.user?.email;
    }
    const customer = await stripe.customers.create({
      ...customerData,
      name: session?.user?.name as string,
    });
    await updateTeam(teamMember.team.slug, {
      billingId: customer.id,
      billingProvider: 'stripe',
    });
    customerId = customer.id;
  } else {
    customerId = teamMember.team.billingId;
  }
  return customerId;
}
