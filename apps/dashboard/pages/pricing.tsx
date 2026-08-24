/**
 * [RELAY-108] Public `/pricing` page — the reachable pay path the audit found missing.
 *
 * `growth/product/relay-gtm-readiness-audit-2026-08-21.md` §3.2 traced the only
 * existing Payment Link surface (`components/billing/N8nWedgePaymentLink.tsx`) and
 * found it rendered exclusively inside `pages/teams/[slug]/billing.tsx`, behind
 * signup + email verification + team creation + a `team_payments` access check —
 * four steps deep, with nothing on the public site even hinting a paid tier exists.
 * This page puts the same, real, already-live Stripe test-mode Payment Link
 * (`https://buy.stripe.com/test_dRmcN50tTf5H58E8BH4Vy00`, confirmed live in
 * `relay-sprint-plan.md`'s RELAY-108 entry, created via
 * `scripts/create-n8n-wedge-price.mjs`) one click from `/` (nav, hero, the n8n
 * section, and the Founding Access section all link here) and one more click to
 * Stripe's checkout — 1-2 clicks total, not 4 steps behind signup.
 *
 * No `client_reference_id` is appended here, unlike the billing-page rendering: that
 * param exists so `pages/api/webhooks/stripe.ts`'s `checkout.session.completed`
 * handler knows which *existing team* just paid. A visitor on this public,
 * pre-signup page has no team yet — Stripe collects their email at checkout and a
 * team gets attached after they sign up, same as any other pay-then-provision flow.
 * `env.stripe.n8nWedgePaymentLink` is a `NEXT_PUBLIC_` var, so reading it directly in
 * this component (rather than threading it through `getServerSideProps` the way
 * `billing.tsx` does) is safe — Next.js inlines `NEXT_PUBLIC_*` reads at build time
 * either way, and `components/defaultLanding/LandingNav.tsx` already reads
 * `env.darkModeEnabled` the same direct way from a client component.
 */
import type { GetStaticPropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import Head from 'next/head';
import Link from 'next/link';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import type { ReactElement } from 'react';

import {
  Card,
  Eyebrow,
  focusRing,
} from '@/components/defaultLanding/LandingPrimitives';
import env from '@/lib/env';
import type { NextPageWithLayout } from 'types';

const CONTACT_EMAIL = 'info@coreframe-labs.dev';
const extLinkClass = `rounded text-landing-accent-text underline underline-offset-2 hover:text-landing-accent-text-hover ${focusRing}`;

const included = [
  'Real webhook receipt, retry with backoff, and a delivery log against your n8n Production Webhook URL',
  'DLQ replay by hand for anything that permanently fails, headers included (see the setup guide for the one edge case)',
  'Destination auth headers encrypted at rest (AES-256-GCM)',
  'Unlimited routes on this tier — no metering, no usage-based add-ons',
];

const PricingHeader = () => (
  <header className="sticky top-0 z-20 border-b border-landing-border/80 bg-landing-base/90 backdrop-blur">
    <nav
      aria-label="Primary"
      className="mx-auto flex w-full max-w-6xl items-center gap-4 px-5 py-3 sm:px-8"
    >
      <Link
        href="/"
        className={`flex items-center gap-2 rounded ${focusRing}`}
        aria-label="Coreframe Relay home"
      >
        <span
          aria-hidden="true"
          className="h-5 w-1.5 shrink-0 rounded-full bg-landing-accent"
        />
        <span className="text-sm font-semibold tracking-tight text-landing-primary">
          Coreframe Relay
        </span>
      </Link>
      <ul className="ml-auto flex items-center gap-5">
        <li>
          <Link
            href="/docs/integrations/n8n"
            className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
          >
            Docs
          </Link>
        </li>
        <li>
          <Link
            href="/auth/login"
            className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
          >
            Sign in
          </Link>
        </li>
      </ul>
    </nav>
  </header>
);

const PricingFooter = () => (
  <footer className="border-t border-landing-border/80">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-10 text-sm text-landing-secondary sm:px-8">
      <p>
        Coreframe Labs Ltd — registered in England &amp; Wales. Questions
        about pricing:{' '}
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className={`rounded text-landing-accent-text underline underline-offset-2 hover:text-landing-accent-text-hover ${focusRing}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>
      <p>
        <Link
          href="/"
          className={`rounded underline underline-offset-2 hover:text-landing-primary ${focusRing}`}
        >
          Back to coreframe-labs.dev
        </Link>
      </p>
    </div>
  </footer>
);

const PricingPage: NextPageWithLayout = () => {
  const paymentLinkUrl = env.stripe.n8nWedgePaymentLink || null;

  return (
    <>
      <Head>
        <title>Pricing — Coreframe Relay</title>
        <meta
          name="description"
          content="Coreframe Relay's n8n Reliability tier: $19/month flat, no metering, no usage caps. Point a Relay route at your n8n Production Webhook URL and get retry-with-backoff plus a dead letter queue for anything n8n doesn't answer for."
        />
      </Head>
      <div className="min-h-screen bg-landing-base text-landing-secondary antialiased">
        <PricingHeader />

        <main className="mx-auto w-full max-w-4xl px-5 py-16 sm:px-8 sm:py-24">
          <Eyebrow>Pricing</Eyebrow>
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-landing-primary sm:text-4xl">
            n8n Reliability — $19/month flat.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-landing-secondary">
            One tier, no metering, no usage caps, no trial clock. Point a
            Relay route at your n8n workflow&rsquo;s Production Webhook URL
            and Relay queues, retries with backoff, and holds anything n8n
            doesn&rsquo;t answer for in a dead letter queue instead of
            letting it vanish — the same pipeline documented in the{' '}
            <Link
              href="/docs/integrations/n8n"
              className={`rounded text-landing-accent-text underline underline-offset-2 hover:text-landing-accent-text-hover ${focusRing}`}
            >
              n8n setup guide
            </Link>
            .
          </p>

          <Card className="relay-reveal mt-10 max-w-md">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-4xl font-semibold tracking-tight text-landing-primary">
                $19
                <span className="text-base font-medium text-landing-secondary">
                  {' '}
                  / month
                </span>
              </p>
              <p className="font-mono text-xs text-landing-secondary">
                flat · no metering
              </p>
            </div>

            <ul className="mt-5 space-y-2">
              {included.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-sm text-landing-secondary"
                >
                  <span
                    aria-hidden="true"
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-landing-accent"
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <div className="mt-6 border-t border-landing-border pt-5">
              {paymentLinkUrl ? (
                <a
                  href={paymentLinkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex w-full items-center justify-center gap-2 rounded-md bg-landing-accent px-5 py-3 text-sm font-semibold text-landing-accent-ink transition-colors hover:bg-landing-accent-hover ${focusRing}`}
                >
                  Pay with Stripe
                  <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden="true" />
                </a>
              ) : (
                <p className="text-sm text-landing-muted">
                  Payment link isn&rsquo;t configured in this environment.
                  Email{' '}
                  <a href={`mailto:${CONTACT_EMAIL}`} className={extLinkClass}>
                    {CONTACT_EMAIL}
                  </a>{' '}
                  instead.
                </p>
              )}
              <p className="mt-3 font-mono text-[11px] text-landing-muted">
                Stripe test mode today — a real card will be declined. See
                the{' '}
                <Link href="/terms" className={extLinkClass}>
                  Terms
                </Link>{' '}
                and{' '}
                <Link href="/refund-policy" className={extLinkClass}>
                  Refund Policy
                </Link>
                .
              </p>
            </div>
          </Card>

          <p className="mt-8 max-w-2xl text-sm leading-relaxed text-landing-secondary">
            Not using n8n, or want the general free tier instead?{' '}
            <Link href="/auth/join" className={extLinkClass}>
              Request Founding Access
            </Link>{' '}
            — no card, nothing charged, the same real delivery pipeline this
            tier runs on.
          </p>
        </main>

        <PricingFooter />
      </div>
    </>
  );
};

export const getStaticProps = async ({ locale }: GetStaticPropsContext) => {
  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
};

PricingPage.getLayout = (page: ReactElement) => <>{page}</>;

export default PricingPage;
