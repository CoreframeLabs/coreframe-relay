/**
 * [RELAY-64 v2] Shared building blocks for the public landing page.
 *
 * These live under `components/defaultLanding/**` on purpose: that path is already
 * exempt from `i18next/no-literal-string` in `eslint.config.cjs` (alongside
 * `pages/index.tsx`), so marketing copy can be written as plain strings. A fresh
 * `components/landing/**` namespace would NOT be exempt and would fail `check-lint`
 * once per string — and `eslint.config.cjs` is outside this ticket's file boundary.
 *
 * [ui-revamp Phase 1/4, growth/product/design-panel/ui-revamp-spec-2026-08-19.md]
 * The page previously committed to a single hardcoded-hex dark surface, opted out
 * of the toggle by design (see the git history on this file for that original
 * rationale). That scope boundary is now revisited: the page consumes the
 * `--landing-*` CSS variables (styles/globals.css) via the `landing-*` Tailwind
 * colour family (tailwind.config.js), toggled by the exact same `.dark` class
 * `lib/theme.ts`'s `applyTheme` already sets for the rest of the app — light is
 * the new default, dark remains fully supported. No new toggle mechanism, no new
 * dependency (RELAY-62 stays untouched by this pass either way).
 *
 * Deliberately NOT re-tokenized: the terminal/code/log mockups in `GapSection.tsx`,
 * `RelayFlowDiagram.tsx`'s `Terminal`, and `ProofSection.tsx`'s receipt-line figure.
 * Those simulate real terminal/log output and stay a fixed dark surface in both
 * themes, the same way a code block in a docs site typically doesn't flip to a
 * white terminal under a light theme — flipping them would break the visual
 * metaphor they're going for, not improve it. See the comments in those files.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Shared focus treatment. Visible on every interactive element, in both themes. */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-landing-accent focus-visible:ring-offset-2 focus-visible:ring-offset-landing-base';

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
 * Contrast per the panel's method (relay-landing-design.md §5, carried forward by
 * ui-revamp-spec-2026-08-19.md §3.1): teal accent with dark ink text measures ≈7.5:1 in
 * both themes (`--landing-accent-ink` is the same `#04120f` value in light and dark —
 * spec §3.2/§3.3). The lighter/darker hover step keeps the same dark ink: accent-on-hover
 * is the pattern in both themes, not a white-foreground variant (white on teal fails AA).
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
      ? 'bg-landing-accent text-landing-accent-ink hover:bg-landing-accent-hover'
      : 'border border-landing-border bg-landing-surface text-landing-primary hover:border-landing-muted hover:bg-landing-elevated';

  return (
    <Link href={href} className={`${base} ${styles} ${className}`}>
      {children}
    </Link>
  );
};

export const Eyebrow = ({ children }: { children: ReactNode }) => (
  <p className="mb-3 font-mono text-xs uppercase tracking-[0.18em] text-landing-accent-text">
    {children}
  </p>
);

type SectionProps = {
  id?: string;
  children: ReactNode;
  className?: string;
};

export const Section = ({ id, children, className = '' }: SectionProps) => (
  <section id={id} className={`scroll-mt-16 border-t border-landing-border/80 ${className}`}>
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
    <h2 className="text-balance text-2xl font-semibold tracking-tight text-landing-primary sm:text-3xl">
      {title}
    </h2>
    {lede ? (
      <p className="mt-4 text-base leading-relaxed text-landing-secondary">{lede}</p>
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
    className={`rounded-xl border border-landing-border bg-landing-surface/60 p-5 sm:p-6 ${className}`}
  >
    {children}
  </div>
);

/**
 * Status chip. Colour is never the only signal — every chip also carries its own word,
 * per `relay-ui-ux-spec.md` §7. Amber is `text-amber-400` (#fbbf24 ≈ #fb923c kept as
 * the "gap" meaning); emerald is built/delivered only.
 *
 * Light-mode pairing follows spec §3.2's status-colour pattern (light tint background,
 * saturated text) rather than the CSS-variable token set above: these are ordinary
 * Tailwind palette colours, not part of the neutral/accent token family, so a plain
 * `dark:` variant is the minimal-diff way to flip them — same `.dark` class, no new
 * mechanism. Dark values are unchanged from the original (already shipped) pairing.
 */
export const StatusChip = ({
  tone,
  children,
}: {
  tone: 'built' | 'planned' | 'gap';
  children: ReactNode;
}) => {
  const tones = {
    built:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300',
    planned:
      'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
    gap: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400',
  } as const;

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider ${tones[tone]}`}
    >
      {children}
    </span>
  );
};
