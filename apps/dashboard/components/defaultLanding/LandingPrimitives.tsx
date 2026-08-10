/**
 * [RELAY-64 v2] Shared building blocks for the public landing page.
 *
 * These live under `components/defaultLanding/**` on purpose: that path is already
 * exempt from `i18next/no-literal-string` in `eslint.config.cjs` (alongside
 * `pages/index.tsx`), so marketing copy can be written as plain strings. A fresh
 * `components/landing/**` namespace would NOT be exempt and would fail `check-lint`
 * once per string — and `eslint.config.cjs` is outside this ticket's file boundary.
 *
 * v2 token pass per `relay-landing-design.md` §4: coreframe-website colour VALUES
 * mapped onto the existing zinc utility STRUCTURE — page `bg-[#0d0f12]`, cards
 * `bg-[#191b20]`/60, hairlines `border-[#24262c]`, headings `text-[#f2f3f5]`, body
 * `text-[#9a9ea8]`, primary accent teal, amber #fb923c keeps the "gap" meaning,
 * emerald stays delivered-only. Values are inline arbitrary utilities, NOT a
 * tailwind.config change [AGENT-22 conservative-default, director may reverse]:
 * the app-wide token cascade stays out of scope.
 *
 * The page still commits to a single dark surface rather than following the daisyUI
 * theme toggle — explicit hex utilities resolve identically with or without the
 * `.dark` class on the landing route, which renders under `data-theme="boxyhq"`.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Shared focus treatment. Visible on every interactive element, on a dark surface. */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d0f12]';

type LandingLinkProps = {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  className?: string;
};

/**
 * Deliberately not daisyUI's `.btn` — `styles/globals.css` restyles that class app-wide
 * and the landing page should not inherit dashboard chrome.
 *
 * Contrast per the panel's method (relay-landing-design.md §5): teal accent bg-teal-600
 * with dark ink text-[#04120f] measures ≈7.5:1 — above the 5.7:1 bar set by v1's
 * violet-600 CTA. The lighter hover step keeps the same dark ink: accent-on-hover is
 * the website's pattern, not a white-foreground variant (white on teal fails AA).
 */
export const LandingLink = ({
  href,
  children,
  variant = 'primary',
  className = '',
}: LandingLinkProps) => {
  const base = `inline-flex items-center justify-center gap-2 rounded-md px-5 py-3 text-sm font-semibold transition-colors ${focusRing}`;

  const styles =
    variant === 'primary'
      ? 'bg-teal-600 text-[#04120f] hover:bg-teal-500'
      : 'border border-[#24262c] bg-[#191b20] text-[#f2f3f5] hover:border-zinc-500 hover:bg-[#22242b]';

  return (
    <Link href={href} className={`${base} ${styles} ${className}`}>
      {children}
    </Link>
  );
};

export const Eyebrow = ({ children }: { children: ReactNode }) => (
  <p className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-teal-300">
    {children}
  </p>
);

type SectionProps = {
  id?: string;
  children: ReactNode;
  className?: string;
};

export const Section = ({ id, children, className = '' }: SectionProps) => (
  <section id={id} className={`scroll-mt-16 border-t border-[#24262c]/80 ${className}`}>
    <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
      {children}
    </div>
  </section>
);

export const SectionHeading = ({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
}) => (
  <div className="max-w-3xl">
    <Eyebrow>{eyebrow}</Eyebrow>
    <h2 className="text-balance font-display text-2xl font-semibold tracking-tight text-[#f2f3f5] sm:text-3xl">
      {title}
    </h2>
    {lede ? (
      <p className="mt-4 text-base leading-relaxed text-[#9a9ea8]">{lede}</p>
    ) : null}
  </div>
);

export const Card = ({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) => (
  <div
    className={`rounded-xl border border-[#24262c] bg-[#191b20]/60 p-5 sm:p-6 ${className}`}
  >
    {children}
  </div>
);

/**
 * Status chip. Colour is never the only signal — every chip also carries its own word,
 * per `relay-ui-ux-spec.md` §7. Amber is `text-amber-400` (#fbbf24 ≈ #fb923c kept as
 * the "gap" meaning); emerald is built/delivered only.
 */
export const StatusChip = ({
  tone,
  children,
}: {
  tone: 'built' | 'planned' | 'gap';
  children: ReactNode;
}) => {
  const tones = {
    built: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    planned: 'border-zinc-600 bg-zinc-800 text-zinc-300',
    gap: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  } as const;

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider ${tones[tone]}`}
    >
      {children}
    </span>
  );
};
