/**
 * [RELAY-80/RELAY-81] Shared chrome for the standalone legal pages (Privacy Notice,
 * Data Processing Addendum). Deliberately NOT `LandingNav`/`LandingFooter` from
 * `components/defaultLanding/**` — those carry in-page anchors (`#security`,
 * `#founding-access`) that only resolve on `pages/index.tsx`. Reusing them here would
 * ship two more dead links on every legal page, which is exactly the defect class
 * `relay-launch-decisions.md` already flags on the existing footer. This component is
 * self-contained instead: home, the sibling legal page, and a mailto contact link, all
 * of which resolve everywhere `LegalLayout` is used.
 *
 * Same dark-surface palette as the landing page (`bg-[#0d0f12]` / `text-[#9a9ea8]` /
 * `text-[#f2f3f5]` headings, teal accent) so a visitor landing here from the footer
 * doesn't hit a visual discontinuity — but built from scratch rather than importing
 * `LandingPrimitives`' `Section`/`Card` components, which assume the landing page's
 * section-per-viewport rhythm rather than a single long-form document.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';

import { focusRing } from '@/components/defaultLanding/LandingPrimitives';

const CONTACT_EMAIL = 'info@coreframe-labs.dev';

const LegalHeader = () => (
  <header className="sticky top-0 z-20 border-b border-[#24262c]/80 bg-[#0d0f12]/90 backdrop-blur">
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
          className="h-5 w-1.5 shrink-0 rounded-full bg-teal-400"
        />
        <span className="font-display text-sm font-semibold tracking-tight text-[#f2f3f5]">
          Coreframe Relay
        </span>
      </Link>
      <ul className="ml-auto flex items-center gap-5">
        <li>
          <Link
            href="/privacy"
            className={`rounded text-sm text-[#9a9ea8] transition-colors hover:text-zinc-100 ${focusRing}`}
          >
            Privacy Notice
          </Link>
        </li>
        <li>
          <Link
            href="/dpa"
            className={`rounded text-sm text-[#9a9ea8] transition-colors hover:text-zinc-100 ${focusRing}`}
          >
            Data Processing Addendum
          </Link>
        </li>
        <li>
          <Link
            href="/terms"
            className={`rounded text-sm text-[#9a9ea8] transition-colors hover:text-zinc-100 ${focusRing}`}
          >
            Terms of Service
          </Link>
        </li>
      </ul>
    </nav>
  </header>
);

const LegalFooter = () => (
  <footer className="border-t border-[#24262c]/80">
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-2 px-5 py-10 text-sm text-[#9a9ea8] sm:px-8">
      <p>
        Coreframe Labs Ltd — registered in England &amp; Wales. Questions about
        this document, or a data protection request:{' '}
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className={`rounded text-teal-300 underline underline-offset-2 hover:text-teal-200 ${focusRing}`}
        >
          {CONTACT_EMAIL}
        </a>
        .
      </p>
      <p>
        <Link
          href="/"
          className={`rounded underline underline-offset-2 hover:text-zinc-200 ${focusRing}`}
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
  <div className="min-h-screen bg-[#0d0f12] text-[#9a9ea8] antialiased">
    <LegalHeader />
    <main className="mx-auto w-full max-w-4xl px-5 py-16 sm:px-8">
      <div className="mb-10 border-b border-[#24262c]/80 pb-8">
        <h1 className="text-balance font-display text-3xl font-semibold tracking-tight text-[#f2f3f5] sm:text-4xl">
          {title}
        </h1>
        <p className="mt-3 font-mono text-xs uppercase tracking-[0.14em] text-teal-300">
          Effective {effectiveDate}
        </p>
      </div>
      <article className="prose prose-invert prose-zinc max-w-none prose-headings:font-display prose-headings:text-[#f2f3f5] prose-a:text-teal-300 prose-a:no-underline hover:prose-a:underline prose-strong:text-[#f2f3f5] prose-th:text-[#f2f3f5]">
        {children}
      </article>
    </main>
    <LegalFooter />
  </div>
);

export default LegalLayout;
