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

import FoundingAccessSection from '@/components/defaultLanding/FoundingAccessSection';
import HeroSection from '@/components/defaultLanding/HeroSection';
import LandingFooter from '@/components/defaultLanding/LandingFooter';
import LandingNav from '@/components/defaultLanding/LandingNav';
import ProofSection from '@/components/defaultLanding/ProofSection';
import SecuritySection from '@/components/defaultLanding/SecuritySection';
import WhatItDoesSection from '@/components/defaultLanding/WhatItDoesSection';
import env from '@/lib/env';
import type { NextPageWithLayout } from 'types';

const LandingPage: NextPageWithLayout = () => {
  return (
    <>
      <Head>
        <title>
          Coreframe Relay — Know which webhooks never arrived, and get them back
        </title>
        <meta
          name="description"
          content="Relay sits in front of your endpoint, counts every webhook the moment it lands, and re-sends the ones that fail — so a restart, a crash or a busy spell is never a silent loss."
        />
      </Head>

      {/* Contract §4 token pass: page adopts coreframe-website's palette values as
          arbitrary-value Tailwind classes over the existing utility structure.
          `bg-[#0d0f12]` page, `text-[#f2f3f5]` headings, `text-[#9a9ea8]` body,
          teal accent (primary CTA `bg-teal-600 text-[#04120f]`, focus `ring-teal-400`).
          The wrapper carries the dark surface so the route is dark regardless of
          the daisyUI theme toggle's `.dark` class. */}
      <div className="min-h-screen bg-[#0d0f12] text-[#9a9ea8] antialiased">
        <LandingNav />
        <main>
          {/* Contract §3 section order: Hero (incl. Gap) → Proof → Product → Security → Founding Access/CTA → Footer. RELAY-55: every section sells the phase that exists — Buffer — and nothing else.
              [RELAY-71] The Gap used to render a second time here — HeroSection already
              renders it internally (see HeroSection.tsx). That duplicate call, plus the
              since-removed LimitsSection/RoadmapSection ("what Relay cannot do
              today" / an explicit roadmap-is-vapourware section), are gone. The
              facts LimitsSection carried (payload cap, DLQ header limitation) live on
              inside FoundingAccessSection's disclosure; SecuritySection fills the
              freed slot with capabilities that are actually true today.
              [Launch-shape change] PricingSection → FoundingAccessSection: per
              growth/product/relay-launch-sprint.md §0, a paid card-up-front launch is
              <5% achievable by 2026-08-19 (metering, caps, reaping and the trial timer
              are sold on the old copy and none exist as code), so this section now
              sells the free, no-billing launch shape the sprint actually targets. */}
          <HeroSection />
          <ProofSection />
          <WhatItDoesSection />
          <SecuritySection />
          <FoundingAccessSection />
        </main>
        <LandingFooter />
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
