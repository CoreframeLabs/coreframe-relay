import Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import type { NextApiRequest, NextApiResponse } from 'next';
import env from '@/lib/env';
import type { Readable } from 'node:stream';
import {
  createStripeSubscription,
  deleteStripeSubscription,
  getBySubscriptionId,
  updateStripeSubscription,
} from 'models/subscription';
import { getByCustomerId, getTeam, updateTeam } from 'models/team';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Get raw body as string
async function getRawBody(readable: Readable): Promise<Buffer> {
  const chunks: any[] = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

const relevantEvents: Stripe.Event.Type[] = [
  // the n8n-wedge Payment Link's completion event. Kept separate
  // from RELAY-49's general Checkout Session flow below — see handleCheckoutSessionCompleted.
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

export default async function POST(req: NextApiRequest, res: NextApiResponse) {
  const rawBody = await getRawBody(req);

  const sig = req.headers['stripe-signature'] as string;
  const { webhookSecret } = env.stripe;
  let event: Stripe.Event;

  try {
    if (!sig || !webhookSecret) {
      return;
    }
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: any) {
    return res.status(400).json({ error: { message: err.message } });
  }

  if (relevantEvents.includes(event.type)) {
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(event);
          break;
        case 'customer.subscription.created':
          await handleSubscriptionCreated(event);
          break;
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event);
          break;
        case 'customer.subscription.deleted':
          await deleteStripeSubscription(
            (event.data.object as Stripe.Subscription).id
          );
          break;
        default:
          throw new Error('Unhandled relevant event!');
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      return res.status(400).json({
        error: {
          message: 'Webhook handler failed. View your nextjs function logs.',
        },
      });
    }
  }
  return res.status(200).json({ received: true });
}

// Marks a team as paying after a Payment Link checkout.
//
// Unlike RELAY-49's in-app Checkout Session flow (create-checkout-session.ts),
// which already knows the team via the logged-in session and pre-creates the
// Stripe customer via getStripeCustomerId before checkout starts, a Payment
// Link is a static, unauthenticated URL. The only way it carries the team's
// identity is the `client_reference_id` query param appended when the link is
// rendered (see components/billing/N8nWedgePaymentLink.tsx) — Stripe echoes it
// back on the resulting Checkout Session untouched.
//
// This handler's ONLY job is linking Team.billingId to the Stripe customer
// that just paid. It deliberately does not touch Subscription rows: the
// existing handleSubscriptionCreated/Updated handlers below already do that
// for every customerId, Payment-Link-originated or not, once
// `customer.subscription.created` arrives (Stripe fires it automatically for
// a Payment Link using a recurring price). Re-running with the same session is
// idempotent — updateTeam just writes the same billingId again.
async function handleCheckoutSessionCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  const teamId = session.client_reference_id;
  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id;

  if (!teamId || !customerId) {
    // Not a Relay-initiated Payment Link checkout (no client_reference_id) —
    // nothing to link. Other Checkout Sessions (e.g. the in-app flow) already
    // set billingId for themselves before the session is even created.
    return;
  }

  let team;
  try {
    team = await getTeam({ id: teamId });
  } catch {
    // client_reference_id didn't resolve to a real team (stale/tampered link)
    // — ignore rather than throw, so a bad param can't fail the webhook.
    return;
  }

  await updateTeam(team.slug, {
    billingId: customerId,
    billingProvider: 'stripe',
  });
}

async function handleSubscriptionUpdated(event: Stripe.Event) {
  const {
    cancel_at,
    id,
    status,
    current_period_end,
    current_period_start,
    customer,
    items,
  } = event.data.object as Stripe.Subscription;

  const subscription = await getBySubscriptionId(id);
  if (!subscription) {
    const teamExists = await getByCustomerId(customer as string);
    if (!teamExists) {
      return;
    } else {
      await handleSubscriptionCreated(event);
    }
  } else {
    const priceId = items.data.length > 0 ? items.data[0].plan?.id : '';
    //type Stripe.Subscription.Status = "active" | "canceled" | "incomplete" | "incomplete_expired" | "past_due" | "paused" | "trialing" | "unpaid"
    await updateStripeSubscription(id, {
      active: status === 'active',
      endDate: current_period_end
        ? new Date(current_period_end * 1000)
        : undefined,
      startDate: current_period_start
        ? new Date(current_period_start * 1000)
        : undefined,
      cancelAt: cancel_at ? new Date(cancel_at * 1000) : undefined,
      priceId,
    });
  }
}

async function handleSubscriptionCreated(event: Stripe.Event) {
  const { customer, id, current_period_start, current_period_end, items } =
    event.data.object as Stripe.Subscription;

  await createStripeSubscription({
    customerId: customer as string,
    id,

    active: true,
    startDate: new Date(current_period_start * 1000),
    endDate: new Date(current_period_end * 1000),
    priceId: items.data.length > 0 ? items.data[0].plan?.id : '',
  });
}
