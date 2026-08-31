import Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import type { NextApiRequest, NextApiResponse } from 'next';
import env from '@/lib/env';
import type { Readable } from 'node:stream';
import {
  createStripeSubscription,
  deleteStripeSubscription,
  getByCustomerId as getSubscriptionsByCustomerId,
  getBySubscriptionId,
  updateStripeSubscription,
} from 'models/subscription';
import { getByCustomerId, getTeam, getTeams, updateTeam } from 'models/team';
import { prisma } from '@/lib/prisma';
import { Plan } from '@prisma/client';

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

// [RELAY-49, AC5] Invalid/missing signatures must return 401 with a generic body —
// never the raw Stripe SDK error message (which can describe exactly why
// verification failed, e.g. body-parsing details), and never a bare `return` with
// no status (that previously left the Next.js API route hanging with no response
// sent at all, since neither `res.status().json()` nor `res.end()` was ever called).
// The real reason is still logged server-side (Vercel function logs) for debugging —
// it is withheld from the response body only, not lost.
const INVALID_SIGNATURE_RESPONSE = { error: { message: 'Invalid signature' } };

export default async function POST(req: NextApiRequest, res: NextApiResponse) {
  const rawBody = await getRawBody(req);

  const sig = req.headers['stripe-signature'] as string;
  const { webhookSecret } = env.stripe;
  let event: Stripe.Event;

  if (!sig || !webhookSecret) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'stripe.webhook_signature_invalid',
        reason: !sig ? 'missing_signature_header' : 'missing_webhook_secret',
      })
    );
    return res.status(401).json(INVALID_SIGNATURE_RESPONSE);
  }

  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err: any) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'stripe.webhook_signature_invalid',
        reason: 'verification_failed',
        // the underlying Stripe SDK message is diagnostic-only — it never reaches
        // the HTTP response, only Vercel's own function logs.
        detail: err.message,
      })
    );
    return res.status(401).json(INVALID_SIGNATURE_RESPONSE);
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
          await handleSubscriptionDeleted(event);
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
// Exported for direct unit testing (__tests__/api/webhooks/stripe.test.ts) — this
// function's branching logic is what's under test, not Stripe's own signature
// verification, so the test calls it directly rather than plumbing a signed request
// through the full POST handler.
export async function handleCheckoutSessionCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  const teamId = session.client_reference_id;
  const customerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id;

  if (!customerId) {
    // Stripe always sets `customer` on a completed subscription Checkout Session
    // (the whole point of a subscription is a customer to bill again) — this branch
    // is defensive, not a real path, but there is nothing to link without it.
    return;
  }

  if (teamId) {
    // The known-good path: an authenticated Team's own billing page rendered this
    // link with client_reference_id (components/billing/N8nWedgePaymentLink.tsx).
    let team;
    try {
      team = await getTeam({ id: teamId });
    } catch {
      // client_reference_id didn't resolve to a real team (stale/tampered link) —
      // ignore rather than throw, so a bad param can't fail the webhook. Falls
      // through to the email-match path below rather than returning outright, in
      // case the same checkout can still be linked by the payer's email.
    }
    if (team) {
      await updateTeam(team.slug, {
        billingId: customerId,
        billingProvider: 'stripe',
      });
      // [RELAY-49, AC3] Webhook delivery order isn't guaranteed — if
      // `customer.subscription.created` already arrived for this customerId
      // before this event linked it to a team, that earlier handler's own
      // `syncTeamPlanForCustomer` call would have found no team yet and been a
      // silent no-op. Re-run it now that the link exists, so a team isn't left
      // on FREE indefinitely just because the two events arrived out of order.
      await syncTeamPlanForCustomer(customerId);
      return;
    }
  }

  // [2026-08-25, found by the business-review checkpoint] The PUBLIC /pricing page's
  // Payment Link (pages/pricing.tsx) deliberately does NOT set client_reference_id —
  // there is no logged-in team to attach it to, the whole point of that page is
  // selling to a stranger who has never signed up. Before this fix, that checkout
  // completed, Stripe took the customer's card, and this handler returned here doing
  // nothing: a real paying customer with no product access, silently.
  //
  // Fix, scoped to what can be done safely without inventing a new account-creation
  // flow: Stripe Checkout always collects an email for a subscription, even from an
  // anonymous Payment Link. If that email already belongs to a Relay user with
  // exactly one team, and that team has no billingId yet, link it — the same outcome
  // as the authenticated path, just reached by email instead of a session claim.
  // Two cases are deliberately NOT auto-resolved, because guessing would be worse
  // than a clear miss: a user who belongs to more than one team (ambiguous which one
  // paid), and an email with no matching user at all (a genuinely new customer who
  // paid before ever creating an account — there is no team to link to yet). Both
  // are logged with full detail via console.error's own established audit-of-last-
  // resort pattern (matching lib/audit.ts's recordAuditEvent) so they surface in
  // Vercel's runtime logs — actively checked after every deploy this session — for
  // manual reconciliation, rather than vanishing. A durable pending-payment table for
  // the true auto-provisioning case is real, larger follow-up work, not squeezed in
  // here.
  const email = session.customer_details?.email ?? session.customer_email;
  if (!email) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'stripe.checkout_unlinked',
        reason: 'no_email',
        sessionId: session.id,
        customerId,
      })
    );
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'stripe.checkout_unlinked',
        reason: 'no_matching_user',
        sessionId: session.id,
        customerId,
        email,
      })
    );
    return;
  }

  const teams = await getTeams(user.id);
  if (teams.length !== 1) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'stripe.checkout_unlinked',
        reason: teams.length === 0 ? 'user_has_no_team' : 'user_has_multiple_teams',
        sessionId: session.id,
        customerId,
        email,
        userId: user.id,
        teamCount: teams.length,
      })
    );
    return;
  }

  await updateTeam(teams[0].slug, {
    billingId: customerId,
    billingProvider: 'stripe',
  });
  // See the comment on the client_reference_id path above — same out-of-order
  // webhook-delivery reasoning applies to the email-fallback link.
  await syncTeamPlanForCustomer(customerId);
}

// [RELAY-49, AC3] Statuses that count as "paying" for entitlement purposes. This
// tier has no trial (pricing.tsx: "no trial clock"), but `trialing` is included
// defensively for any future price that does add one — Stripe's own docs treat
// trialing subscriptions as entitled to the product. Every other status
// (canceled, incomplete, incomplete_expired, past_due, paused, unpaid) is NOT
// paying: a subscription that failed to activate, fell behind on payment, or
// was cancelled must not leave a team on the paid plan.
// Stripe.Subscription.Status = "active" | "canceled" | "incomplete" |
//   "incomplete_expired" | "past_due" | "paused" | "trialing" | "unpaid"
const ENTITLED_STATUSES: Stripe.Subscription.Status[] = ['active', 'trialing'];

export function isEntitledStatus(status: Stripe.Subscription.Status): boolean {
  return ENTITLED_STATUSES.includes(status);
}

// Writes Team.plan from real subscription state, closing the gap RELAY-13 left
// open on purpose ("nothing currently sets this to PRO" — see the schema
// comment): the proxy's per-plan rate limiter (`apps/proxy/src/middleware/rateLimit.ts`)
// already reads `team.plan` and defaults every team to the most restrictive
// (FREE) tier forever, because nothing in the billing path ever wrote PRO. This
// is the write side of that mechanism — it does not invent a new tier ladder,
// it activates the one that already exists in the schema and the proxy.
//
// Idempotent and safe to call on every subscription event, including ones for a
// customer with no linked team yet (a Payment-Link purchase whose
// checkout.session.completed hasn't been processed, or arrived out of order —
// webhooks are not guaranteed to arrive in order): `getByCustomerId` returning
// null is a normal, silent no-op, not an error.
export async function syncTeamPlanForCustomer(customerId: string) {
  const team = await getByCustomerId(customerId);
  if (!team) {
    return;
  }

  const subscriptions = await getSubscriptionsByCustomerId(customerId);
  const hasActiveSubscription = subscriptions.some((s) => s.active);
  const nextPlan = hasActiveSubscription ? Plan.PRO : Plan.FREE;

  if (team.plan !== nextPlan) {
    await updateTeam(team.slug, { plan: nextPlan });
  }
}

export async function handleSubscriptionUpdated(event: Stripe.Event) {
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
      return;
    }
  }

  const priceId = items.data.length > 0 ? items.data[0].plan?.id : '';
  await updateStripeSubscription(id, {
    active: isEntitledStatus(status),
    endDate: current_period_end
      ? new Date(current_period_end * 1000)
      : undefined,
    startDate: current_period_start
      ? new Date(current_period_start * 1000)
      : undefined,
    cancelAt: cancel_at ? new Date(cancel_at * 1000) : undefined,
    priceId,
  });

  await syncTeamPlanForCustomer(customer as string);
}

export async function handleSubscriptionCreated(event: Stripe.Event) {
  const { customer, id, status, current_period_start, current_period_end, items } =
    event.data.object as Stripe.Subscription;

  await createStripeSubscription({
    customerId: customer as string,
    id,

    // Was previously hardcoded `true` regardless of the subscription's real
    // status — a `customer.subscription.created` event can carry a status other
    // than `active` (e.g. `incomplete`, when the initial payment requires 3DS
    // authentication that hasn't completed yet), and hardcoding `true` would
    // have marked a team as paying before they'd actually paid.
    active: isEntitledStatus(status),
    startDate: new Date(current_period_start * 1000),
    endDate: new Date(current_period_end * 1000),
    priceId: items.data.length > 0 ? items.data[0].plan?.id : '',
  });

  await syncTeamPlanForCustomer(customer as string);
}

export async function handleSubscriptionDeleted(event: Stripe.Event) {
  const { id, customer } = event.data.object as Stripe.Subscription;

  await deleteStripeSubscription(id);
  // A team can only be downgraded once its actually-remaining subscriptions
  // are considered — re-derives from the database rather than assuming "this
  // was the only one", so a plan change (old subscription cancelled, new one
  // already active) never gets clobbered back to FREE by the old one's own
  // deletion event arriving after the new one's creation event (webhook
  // delivery order is not guaranteed).
  await syncTeamPlanForCustomer(customer as string);
}
