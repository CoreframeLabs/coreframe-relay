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
 * [post-merge fix] Originally reused `LandingNav`/`LandingFooter` from
 * `components/defaultLanding/**`, but those carry in-page anchors (`#security`,
 * `#founding-access`) that only resolve on `pages/index.tsx` — every legal page
 * would have shipped two dead links, the exact defect class
 * `relay-launch-decisions.md` already flags on the pre-existing footer. Now
 * self-contained instead, matching the sibling `LegalLayout` component
 * (`components/legal/LegalLayout.tsx`, RELAY-80/81's Privacy/DPA pages) — home, the
 * three sibling legal pages, and a mailto contact link, all of which resolve
 * everywhere this component is used. Also carries the same `--landing-*` token
 * system the rest of the app moved onto in the UI revamp pass (no more hardcoded
 * hex, no more `font-display` — that class was dead everywhere, see
 * `tailwind.config.js`'s note).
 *
 * The sticky section nav + numbered sections pattern follows the sibling
 * `coreframe-website` repo's `/privacy-policy` page (read for house style only,
 * not shared code — that project is Next App Router, this one is Pages Router).
 */
import Head from 'next/head';
import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

import { Eyebrow, focusRing } from '@/components/defaultLanding/LandingPrimitives';
import type { NextPageWithLayout } from 'types';

const CONTACT_EMAIL = 'info@coreframe-labs.dev';

const LegalHeader = () => (
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
            href="/terms"
            className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
          >
            Terms of Service
          </Link>
        </li>
        <li>
          <Link
            href="/refund-policy"
            className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
          >
            Refund Policy
          </Link>
        </li>
        <li>
          <Link
            href="/privacy"
            className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
          >
            Privacy Notice
          </Link>
        </li>
        <li>
          <Link
            href="/dpa"
            className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
          >
            DPA
          </Link>
        </li>
      </ul>
    </nav>
  </header>
);

const LegalFooter = () => (
  <footer className="border-t border-landing-border/80">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-10 text-sm text-landing-secondary sm:px-8">
      <p>
        Coreframe Labs Ltd — registered in England &amp; Wales. Questions about
        this document:{' '}
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

      <div className="min-h-screen bg-landing-base text-landing-secondary antialiased">
        <LegalHeader />

        <main className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-landing-primary sm:text-4xl">
            {title}
          </h1>
          <p className="mt-3 font-mono text-xs text-landing-muted">
            Last updated: {lastUpdated}
          </p>

          {intro ? (
            <div className="mt-8 max-w-2xl text-sm leading-relaxed text-landing-secondary">
              {intro}
            </div>
          ) : null}

          <div className="mt-14 flex flex-col gap-12 lg:flex-row">
            <nav
              aria-label="Sections on this page"
              className="lg:w-64 lg:shrink-0"
            >
              <ul className="flex flex-col gap-2 border-l border-landing-border pl-4 text-sm lg:sticky lg:top-24">
                {sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="text-landing-secondary transition-colors hover:text-landing-accent-text"
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
                  <h2 className="text-xl font-semibold text-landing-primary">
                    {s.title}
                  </h2>
                  {s.body.map((para, i) => (
                    <p
                      key={i}
                      className="mt-3 text-sm leading-relaxed text-landing-secondary"
                    >
                      {para}
                    </p>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </main>

        <LegalFooter />
      </div>
    </>
  );
};

export default LegalPage;

/** Shared `getLayout` for legal pages: no dashboard chrome, same as the landing page. */
export const legalGetLayout = (page: ReactElement) => <>{page}</>;

export type { NextPageWithLayout };
