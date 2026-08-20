/**
 * [RELAY-80/RELAY-81] Shared chrome for the standalone legal pages (Privacy Notice,
 * Data Processing Addendum). Deliberately NOT `LandingNav`/`LandingFooter` from
 * `components/defaultLanding/**` — those carry in-page anchors (`#security`,
 * `#founding-access`) that only resolve on `pages/index.tsx`. Reusing them here would
 * ship two more dead links on every legal page, which is exactly the defect class
 * `relay-launch-decisions.md` already flags on the existing footer. This component is
 * self-contained instead: home, the sibling legal pages, and a mailto contact link, all
 * of which resolve everywhere `LegalLayout` is used.
 *
 * Same dark-surface palette as the landing page via the `--landing-*` token system
 * (`components/legal/LegalPage.tsx` — Terms/Refund's chrome — carries the identical
 * palette; the two components were reconciled onto the same tokens after both landed
 * from parallel worktrees) so a visitor landing here from the footer doesn't hit a
 * visual discontinuity — but built from scratch rather than importing
 * `LandingPrimitives`' `Section`/`Card` components, which assume the landing page's
 * section-per-viewport rhythm rather than a single long-form document.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';

import { focusRing } from '@/components/defaultLanding/LandingPrimitives';

const CONTACT_EMAIL = 'info@coreframe-labs.dev';

const LegalHeader = () => (
  <header className="sticky top-0 z-20 border-b border-landing-border/80 bg-landing-base/90 backdrop-blur">
    <nav
      aria-label="Primary"
      className="mx-auto flex w-full max-w-4xl items-center gap-4 px-5 py-3 sm:px-8"
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
            Data Processing Addendum
          </Link>
        </li>
      </ul>
    </nav>
  </header>
);

const LegalFooter = () => (
  <footer className="border-t border-landing-border/80">
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-2 px-5 py-10 text-sm text-landing-secondary sm:px-8">
      <p>
        Coreframe Labs Ltd — registered in England &amp; Wales. Questions about
        this document, or a data protection request:{' '}
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

export const LegalLayout = ({
  title,
  effectiveDate,
  children,
}: {
  title: string;
  effectiveDate: string;
  children: ReactNode;
}) => (
  <div className="min-h-screen bg-landing-base text-landing-secondary antialiased">
    <LegalHeader />
    <main className="mx-auto w-full max-w-4xl px-5 py-16 sm:px-8">
      <div className="mb-10 border-b border-landing-border/80 pb-8">
        <h1 className="text-balance text-3xl font-semibold tracking-tight text-landing-primary sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 font-mono text-xs uppercase tracking-[0.14em] text-landing-accent-text">
          Effective {effectiveDate}
        </p>
      </div>
      <article className="prose prose-invert prose-zinc max-w-none prose-headings:text-landing-primary prose-a:text-landing-accent-text prose-a:no-underline hover:prose-a:underline prose-strong:text-landing-primary prose-th:text-landing-primary">
        {children}
      </article>
    </main>
    <LegalFooter />
  </div>
);

export default LegalLayout;
