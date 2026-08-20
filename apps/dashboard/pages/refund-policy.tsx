/**
 * [RELAY-82] Refund and Cancellation Policy.
 *
 * Grounded in the actual current billing shape, not an invented enterprise-style
 * refund ladder: `scripts/create-n8n-wedge-price.mjs` creates exactly one Stripe
 * Price — a flat $19.00/month recurring subscription via a Payment Link, no trial
 * configured, no annual option. Cancellation is self-serve through the Stripe
 * Customer Portal (`components/billing/LinkToPortal.tsx` →
 * `pages/api/teams/[slug]/payments/create-portal-link.ts`), which today creates a
 * portal session with no explicit cancellation-behaviour override, i.e. it defers
 * to whatever the Stripe account's portal configuration says. This policy states
 * the intended, honest position (cancel any time, access continues to the end of
 * the paid period, no automatic pro-rata refund) — the director should confirm
 * the live Stripe Customer Portal configuration actually matches this before
 * real customers cancel through it; see the commit message and final report for
 * this flagged as an open item this pass could not verify from code alone.
 *
 * Companion document to `/terms` (RELAY-79); this page is a Section 5/9
 * cross-reference target from that page, not a duplicate of it.
 */
import type { GetStaticPropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import Link from 'next/link';

import LegalPage, { legalGetLayout } from '@/components/legal/LegalPage';
import type { LegalSection } from '@/components/legal/LegalPage';
import type { NextPageWithLayout } from 'types';

const SECTIONS: LegalSection[] = [
  {
    id: 'overview',
    title: 'Overview',
    body: [
      <>
        This policy explains how billing, cancellation and refunds work for
        Coreframe Relay&rsquo;s paid subscription, and forms part of our{' '}
        <Link
          href="/terms"
          className="text-teal-300 underline underline-offset-2 hover:text-teal-200"
        >
          Terms of Service
        </Link>
        . It is deliberately short: at our current scale we run one flat-rate
        monthly plan, billed through Stripe, with no annual contracts, no
        multi-tier ladder and no usage-based charges — so there is no complex
        refund matrix to publish, and we have not invented one.
      </>,
    ],
  },
  {
    id: 'how-billing-works',
    title: 'How billing works',
    body: [
      'Coreframe Relay currently offers a single flat monthly subscription, shown and charged at checkout via Stripe. There is no free trial on this plan today — payment is taken when you complete checkout, and your subscription then renews automatically every month on the same date until you cancel. We do not currently offer an annual or multi-month plan.',
    ],
  },
  {
    id: 'cancelling',
    title: 'Cancelling your subscription',
    body: [
      'You can cancel at any time, with no minimum term and no cancellation fee, using the self-serve billing portal linked from your team’s Billing page in the dashboard (powered by Stripe’s Customer Portal), or by emailing info@coreframe-labs.dev and asking us to cancel on your behalf.',
      'Cancelling stops future renewal charges. You keep access to the paid functionality until the end of the billing period you have already paid for, unless we tell you otherwise at the time; we do not automatically refund the unused portion of a part-used period — see Refunds below.',
    ],
  },
  {
    id: 'refunds',
    title: 'Refunds',
    body: [
      'As a general rule, fees already charged are non-refundable, including for a part-used monthly period after you cancel. We think this is fair for a low-cost, no-minimum-term monthly plan with self-serve cancellation.',
      <>
        That said, this is a very new product run by a very small team, and we
        would rather make it right than hide behind a policy. If, within{' '}
        <strong className="text-landing-primary">14 days</strong> of your first
        payment, you are not satisfied with the Service, or it did not work
        as described — including the limitations we set out plainly in
        Section 3 of our{' '}
        <Link
          href="/terms"
          className="text-teal-300 underline underline-offset-2 hover:text-teal-200"
        >
          Terms of Service
        </Link>{' '}
        — email info@coreframe-labs.dev and we will consider a full or
        partial refund on a case-by-case basis. We aim to respond within 5
        business days.
      </>,
      'Outside that 14-day window, we will still look at refund requests case by case where something has clearly gone wrong on our side — for example a billing error, a duplicate charge, or an extended outage — but we do not commit to a refund as of right after the 14-day window has passed.',
    ],
  },
  {
    id: 'failed-payments',
    title: 'Failed or disputed payments',
    body: [
      'If a renewal payment fails, Stripe may automatically retry it. If payment continues to fail, we may suspend or downgrade access to the paid functionality until payment succeeds or you cancel.',
      'If you believe a charge is wrong, please contact us at info@coreframe-labs.dev before raising a chargeback with your bank or card provider — we can usually resolve a billing issue faster directly, and a chargeback can result in your account being suspended while it is investigated.',
    ],
  },
  {
    id: 'price-changes',
    title: 'Price changes',
    body: [
      'If we change the price of the plan you are subscribed to, we will give you reasonable advance notice (by email or in the dashboard) before the new price applies to your next renewal. Continuing your subscription after that point means you accept the new price; if you do not, you can cancel before the change takes effect.',
    ],
  },
  {
    id: 'contact',
    title: 'Contact',
    body: [
      'Questions about billing, cancellation or a refund: info@coreframe-labs.dev — Coreframe Labs Ltd, a company registered in England and Wales.',
    ],
  },
];

const RefundPolicyPage: NextPageWithLayout = () => (
  <LegalPage
    eyebrow="Legal"
    title="Refund and Cancellation Policy"
    lastUpdated="19 August 2026"
    metaTitle="Refund and Cancellation Policy — Coreframe Relay"
    metaDescription="How billing, cancellation and refunds work for Coreframe Relay's flat monthly subscription."
    sections={SECTIONS}
  />
);

export const getStaticProps = async ({ locale }: GetStaticPropsContext) => {
  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
};

RefundPolicyPage.getLayout = legalGetLayout;

export default RefundPolicyPage;
