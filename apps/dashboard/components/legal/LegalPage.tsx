/**
 * [RELAY-79 / RELAY-82] Shared chrome for the legal pages (Terms of Service,
 * Refund and Cancellation Policy).
 *
 * These are the first real legal documents in this codebase — `growth/product/
 * relay-launch-decisions.md` decision #7 and `relay-launch-sprint.md`'s H3 gate
 * both note that no Terms, Privacy, DPA or refund policy exist anywhere, and the
 * footer links nowhere legal. This component exists to make the two documents
 * this ticket owns (Terms, Refund/Cancellation) render as real, readable pages
 * rather than loose markdown nobody serves.
 *
 * Visual style deliberately reuses the landing page's dark surface and the
 * `LandingNav`/`LandingFooter`/`LandingLink` primitives (`components/defaultLanding/**`)
 * rather than the dashboard's daisyUI chrome — a signed-out visitor reads a Terms
 * page from the same surface as the marketing site, not from inside the app shell.
 * The sticky section nav + numbered sections pattern follows the sibling
 * `coreframe-website` repo's `/privacy-policy` page (read for house style only,
 * not shared code — that project is Next App Router, this one is Pages Router).
 */
import Head from 'next/head';
import type { ReactElement, ReactNode } from 'react';

import LandingFooter from '@/components/defaultLanding/LandingFooter';
import LandingNav from '@/components/defaultLanding/LandingNav';
import { Eyebrow } from '@/components/defaultLanding/LandingPrimitives';
import type { NextPageWithLayout } from 'types';

export type LegalSection = {
  id: string;
  title: string;
  body: ReactNode[];
};

type LegalPageProps = {
  eyebrow: string;
  title: string;
  lastUpdated: string;
  intro?: ReactNode;
  sections: LegalSection[];
  metaTitle: string;
  metaDescription: string;
};

const LegalPage = ({
  eyebrow,
  title,
  lastUpdated,
  intro,
  sections,
  metaTitle,
  metaDescription,
}: LegalPageProps) => {
  return (
    <>
      <Head>
        <title>{metaTitle}</title>
        <meta name="description" content={metaDescription} />
      </Head>

      <div className="min-h-screen bg-[#0d0f12] text-[#9a9ea8] antialiased">
        <LandingNav />

        <main className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="text-balance font-display text-3xl font-semibold tracking-tight text-[#f2f3f5] sm:text-4xl">
            {title}
          </h1>
          <p className="mt-3 font-mono text-xs text-[#6b6f78]">
            Last updated: {lastUpdated}
          </p>

          {intro ? (
            <div className="mt-8 max-w-2xl text-sm leading-relaxed text-[#9a9ea8]">
              {intro}
            </div>
          ) : null}

          <div className="mt-14 flex flex-col gap-12 lg:flex-row">
            <nav
              aria-label="Sections on this page"
              className="lg:w-64 lg:shrink-0"
            >
              <ul className="flex flex-col gap-2 border-l border-[#24262c] pl-4 text-sm lg:sticky lg:top-24">
                {sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="text-[#9a9ea8] transition-colors hover:text-teal-300"
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="flex max-w-2xl flex-col gap-10">
              {sections.map((s) => (
                <section key={s.id} id={s.id} className="scroll-mt-24">
                  <h2 className="font-display text-xl font-semibold text-[#f2f3f5]">
                    {s.title}
                  </h2>
                  {s.body.map((para, i) => (
                    <p
                      key={i}
                      className="mt-3 text-sm leading-relaxed text-[#9a9ea8]"
                    >
                      {para}
                    </p>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </main>

        <LandingFooter />
      </div>
    </>
  );
};

export default LegalPage;

/** Shared `getLayout` for legal pages: no dashboard chrome, same as the landing page. */
export const legalGetLayout = (page: ReactElement) => <>{page}</>;

export type { NextPageWithLayout };
