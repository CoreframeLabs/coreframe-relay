/**
 * [RELAY-64] Shared building blocks for the public landing page.
 *
 * These live under `components/defaultLanding/**` on purpose: that path is already
 * exempt from `i18next/no-literal-string` in `eslint.config.cjs` (alongside
 * `pages/index.tsx`), so marketing copy can be written as plain strings. A fresh
 * `components/landing/**` namespace would NOT be exempt and would fail `check-lint`
 * once per string — and `eslint.config.cjs` is outside this ticket's file boundary.
 *
 * The page commits to a single dark surface rather than following the daisyUI theme
 * toggle, per `relay-ui-ux-spec.md` §1.1 ("Dark Mode Primary", zinc neutrals, violet
 * brand, colour used only to convey status). Colours are written as explicit zinc/violet
 * utilities instead of the shadcn `--background` variables, because the landing route
 * renders under `data-theme="boxyhq"` without the `.dark` class and would otherwise
 * resolve to the light palette.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Shared focus treatment. Visible on every interactive element, on a dark surface. */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950';

type LandingLinkProps = {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
  className?: string;
};

/**
 * Deliberately not daisyUI's `.btn` — `styles/globals.css` restyles that class app-wide
 * and the landing page should not inherit dashboard chrome.
 */
export const LandingLink = ({
  href,
  children,
  variant = 'primary',
  className = '',
}: LandingLinkProps) => {
  const base = `inline-flex items-center justify-center gap-2 rounded-md px-5 py-3 text-sm font-semibold transition-colors ${focusRing}`;

  // violet-600 rather than violet-500: white on #7c3aed measures 5.7:1, white on
  // #8b5cf6 measures 4.1:1 and fails WCAG AA for normal text.
  const styles =
    variant === 'primary'
      ? 'bg-violet-600 text-white hover:bg-violet-500'
      : 'border border-zinc-700 bg-zinc-900 text-zinc-100 hover:border-zinc-500 hover:bg-zinc-800';

  return (
    <Link href={href} className={`${base} ${styles} ${className}`}>
      {children}
    </Link>
  );
};

export const Eyebrow = ({ children }: { children: ReactNode }) => (
  <p className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-violet-400">
    {children}
  </p>
);

type SectionProps = {
  id?: string;
  children: ReactNode;
  className?: string;
};

export const Section = ({ id, children, className = '' }: SectionProps) => (
  <section id={id} className={`scroll-mt-16 border-t border-zinc-800/80 ${className}`}>
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
    <h2 className="text-balance text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">
      {title}
    </h2>
    {lede ? (
      <p className="mt-4 text-base leading-relaxed text-zinc-400">{lede}</p>
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
    className={`rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 sm:p-6 ${className}`}
  >
    {children}
  </div>
);

/**
 * Status chip. Colour is never the only signal — every chip also carries its own word,
 * per `relay-ui-ux-spec.md` §7.
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
    gap: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  } as const;

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider ${tones[tone]}`}
    >
      {children}
    </span>
  );
};
