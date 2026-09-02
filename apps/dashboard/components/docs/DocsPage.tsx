/**
 * [RELAY-108] Shared chrome for public documentation pages.
 *
 * Modelled directly on `components/legal/LegalPage.tsx` (RELAY-79/80/81/82's Terms/
 * Privacy/DPA/Refund pages) for the same reason that component exists standalone
 * rather than reusing `LandingNav`/`LandingFooter`: those carry in-page anchors
 * (`#security`, `#founding-access`) that only resolve on `pages/index.tsx` — reused
 * here they would ship dead links on every docs page. Self-contained header/footer
 * instead, same `--landing-*` token system as the rest of the public site.
 *
 * Deliberately NOT `LegalPage` itself, reused as-is: `LegalPage`'s `body: ReactNode[]`
 * renders every item wrapped in a `<p>`, which is correct for legal prose but breaks
 * for a docs page that needs to render a `<table>` (the bug-to-capability mapping,
 * see `pages/docs/integrations/n8n.tsx`) — a `<table>` inside a `<p>` is invalid HTML
 * that browsers silently re-parent, which is exactly the kind of SSR/client DOM
 * mismatch that trips a hydration warning. `DocsSection.body` here is a single
 * `ReactNode` per section instead, so a section author has full control of its markup.
 */
import Head from 'next/head';
import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

import { Eyebrow, focusRing } from '@/components/defaultLanding/LandingPrimitives';
import type { NextPageWithLayout } from 'types';

const CONTACT_EMAIL = 'info@coreframe-labs.dev';

const DocsHeader = () => (
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
            href="/docs"
            className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
          >
            Docs
          </Link>
        </li>
        <li>
          <Link
            href="/pricing"
            className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
          >
            Pricing
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

const DocsFooter = () => (
  <footer className="border-t border-landing-border/80">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-10 text-sm text-landing-secondary sm:px-8">
      <p>
        Coreframe Labs Ltd — registered in England &amp; Wales. Questions
        about this page:{' '}
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

export type DocsSection = {
  id: string;
  title: string;
  body: ReactNode;
};

type DocsPageProps = {
  eyebrow: string;
  title: string;
  lastUpdated?: string;
  intro?: ReactNode;
  sections: DocsSection[];
  metaTitle: string;
  metaDescription: string;
  /** Rendered directly under the intro, before the section nav — used for a CTA row. */
  afterIntro?: ReactNode;
};

const DocsPage = ({
  eyebrow,
  title,
  lastUpdated,
  intro,
  sections,
  metaTitle,
  metaDescription,
  afterIntro,
}: DocsPageProps) => {
  return (
    <>
      <Head>
        <title>{metaTitle}</title>
        <meta name="description" content={metaDescription} />
      </Head>

      <div className="min-h-screen bg-landing-base text-landing-secondary antialiased">
        <DocsHeader />

        <main className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="text-balance text-3xl font-semibold tracking-tight text-landing-primary sm:text-4xl">
            {title}
          </h1>
          {lastUpdated ? (
            <p className="mt-3 font-mono text-xs text-landing-muted">
              Last updated: {lastUpdated}
            </p>
          ) : null}

          {intro ? (
            <div className="mt-8 max-w-2xl text-sm leading-relaxed text-landing-secondary">
              {intro}
            </div>
          ) : null}

          {afterIntro ? <div className="mt-6 max-w-2xl">{afterIntro}</div> : null}

          <div className="mt-14 flex flex-col gap-12 lg:flex-row">
            {sections.length > 1 ? (
              <nav
                aria-label="Sections on this page"
                className="lg:w-64 lg:shrink-0"
              >
                <div className="lg:sticky lg:top-24">
                  {/* [design-overhaul 2026-08] The sidebar previously had no heading at
                      all — a bare list of links reads as an unlabelled block rather than
                      "here's where you are on this page", the pattern Stripe/Vercel/
                      Resend docs all use for their in-page nav. */}
                  <p className="mb-3 font-mono text-[11px] uppercase tracking-wider text-landing-muted">
                    On this page
                  </p>
                  <ul className="flex flex-col gap-2 border-l border-landing-border pl-4 text-sm">
                    {sections.map((s) => (
                      <li key={s.id}>
                        <a
                          href={`#${s.id}`}
                          className={`block rounded text-landing-secondary transition-colors hover:text-landing-accent-text ${focusRing}`}
                        >
                          {s.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </nav>
            ) : null}

            <div className="flex max-w-3xl flex-col gap-12">
              {sections.map((s) => (
                <section key={s.id} id={s.id} className="scroll-mt-24">
                  {/* [design-overhaul 2026-08] `group` + an opacity-0→100 anchor link on
                      hover is the small, standard docs affordance (Stripe/Resend both do
                      this): hovering a heading reveals a way to link straight to it,
                      rather than making a reader hunt for the sidebar entry. Always
                      present for keyboard/AT users via focus-visible, not hover-only. */}
                  <h2 className="group/heading flex items-center gap-2 text-xl font-semibold text-landing-primary">
                    {s.title}
                    <a
                      href={`#${s.id}`}
                      aria-label={`Link to ${s.title}`}
                      className={`rounded font-mono text-base font-normal text-landing-muted opacity-0 transition-opacity duration-150 group-hover/heading:opacity-100 focus-visible:opacity-100 ${focusRing}`}
                    >
                      #
                    </a>
                  </h2>
                  <div className="mt-3 text-sm leading-relaxed text-landing-secondary">
                    {s.body}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </main>

        <DocsFooter />
      </div>
    </>
  );
};

export default DocsPage;

/** Shared `getLayout` for docs pages: no dashboard chrome, same as the landing page. */
export const docsGetLayout = (page: ReactElement) => <>{page}</>;

export type { NextPageWithLayout };
