import { NextApiRequest, NextApiResponse } from 'next';

import { getSession } from '@/lib/session';
import { throwIfNoTeamAccess } from 'models/team';
import { getByCustomerId as getSubscriptionsByCustomerId } from 'models/subscription';
import { stripe, getStripeCustomerId } from '@/lib/stripe';
import env from '@/lib/env';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    switch (req.method) {
      case 'POST':
        await handlePOST(req, res);
        break;
      default:
        res.setHeader('Allow', 'POST');
        res.status(405).json({
          error: { message: `Method ${req.method} Not Allowed` },
        });
    }
  } catch (error: any) {
    const message = error.message || 'Something went wrong';
    const status = error.status || 500;

    res.status(status).json({ error: { message } });
  }
}

const handlePOST = async (req: NextApiRequest, res: NextApiResponse) => {
  const teamMember = await throwIfNoTeamAccess(req, res);
  const session = await getSession(req, res);

  // [RELAY-49, AC5] "A Free-tier team is correctly locked out of paid nav" —
  // the Customer Portal's entire purpose is managing an EXISTING paid
  // subscription (upgrade/downgrade/cancel/payment method/invoices). Creating a
  // session for a team with no active subscription either 500s against a
  // brand-new customer with nothing to manage (no billingId yet) or opens a
  // real Stripe portal with an empty subscription list — confusing UX for a
  // free-tier team that was never actually charged. Checked against the real
  // Subscription table (the same source of truth the webhook consumer writes
  // to), not the team's cached billingId alone, so a cancelled-and-never-
  // resubscribed team is caught too.
  if (!teamMember.team.billingId) {
    return res.status(403).json({
      error: {
        message: 'No billing account on this team yet — subscribe first.',
      },
    });
  }

  const subscriptions = await getSubscriptionsByCustomerId(
    teamMember.team.billingId
  );
  const hasActiveSubscription = subscriptions.some((s) => s.active);
  if (!hasActiveSubscription) {
    return res.status(403).json({
      error: { message: 'No active subscription to manage.' },
    });
  }

  const customerId = await getStripeCustomerId(teamMember, session);

  const { url } = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.appUrl}/teams/${teamMember.team.slug}/billing`,
  });

  res.json({ data: { url } });
};
