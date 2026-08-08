/**
 * [RELAY-64] Public landing page for Coreframe Relay.
 *
 * The page is one dark surface (start to end) rather than the daisyUI theme toggle's
 * two skins, per `relay-ui-ux-spec.md` §1.1 ("Dark Mode Primary"). It sells Buffer —
 * webhook receipt, retry and delivery — and nothing else. Per RELAY-55 Gate and
 * Shield appear only in `RoadmapSection`, labelled as roadmap, because they are
 * unbuilt. There are no metrics, customer logos or testimonials anywhere on this
 * page: there are no customers, and a fabricated proof point is worse than an empty
 * section.
 *
 * The primary CTA routes to `/auth/join` — BoxyHQ's real NextAuth signup page, kept
 * as the destination deliberately (RELAY-56: password email auth is what ships;
 * magic link is not built, so it is never mentioned here).
 *
 * Copy lives as plain literal strings: `pages/index.tsx` and
 * `components/defaultLanding/**` are exempt from `i18next/no-literal-string` in
 * `eslint.config.cjs` (RELAY-60), so `t()` is deliberately not used for copy.
 */
import type { GetServerSidePropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import Head from 'next/head';
import type { ReactElement } from 'react';

import HeroSection from '@/components/defaultLanding/HeroSection';
import LandingNav from '@/components/defaultLanding/LandingNav';
import LimitsSection from '@/components/defaultLanding/LimitsSection';
import ProblemSection from '@/components/defaultLanding/ProblemSection';
import RoadmapSection from '@/components/defaultLanding/RoadmapSection';
import WhatItDoesSection from '@/components/defaultLanding/WhatItDoesSection';
import { LandingLink } from '@/components/defaultLanding/LandingPrimitives';
import env from '@/lib/env';
import type { NextPageWithLayout } from 'types';

const LandingPage: NextPageWithLayout = () => {
  return (
    <>
      <Head>
        <title>Coreframe Relay — Webhooks that survive a slow endpoint</title>
        <meta
          name="description"
          content="Relay accepts webhooks at the edge, answers the sender straight away, then keeps delivering to your endpoint with backoff until it lands."
        />
      </Head>

      {/* One committed dark surface, zinc neutrals, violet for the Relay accent and
          for nothing that merely wants attention. The wrapper — not a theme class —
          carries it, so the route is dark with or without the `.dark` toggle. */}
      <div className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <LandingNav />
        <main>
          <HeroSection />
          <ProblemSection />
          <WhatItDoesSection />
          <LimitsSection />
          <RoadmapSection />
        </main>

        <footer className="border-t border-zinc-800/80">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-12 sm:px-8 md:flex-row md:items-end md:justify-between">
            <div className="max-w-md">
              <p className="text-sm font-semibold text-zinc-50">
                Coreframe Relay
              </p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                Phase 1 of 3 (Buffer) is built and running. No customers yet, so no
                logos, no testimonials and no invented numbers on this page — the
                sections above are the honest state of the product.
              </p>
            </div>
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
              <LandingLink href="/auth/join">Create an account</LandingLink>
              <LandingLink href="/auth/login" variant="secondary">
                Sign in
              </LandingLink>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
};

export const getServerSideProps = async (
  context: GetServerSidePropsContext
) => {
  // Redirect to login page if landing page is disabled
  if (env.hideLandingPage) {
    return {
      redirect: {
        destination: '/auth/login',
        permanent: true,
      },
    };
  }

  const { locale } = context;

  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
};

LandingPage.getLayout = function getLayout(page: ReactElement) {
  return <>{page}</>;
};

export default LandingPage;
