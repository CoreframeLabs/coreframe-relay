import { cn } from '@/lib/utils';

/**
 * The status badge — per relay-ui-ux-spec.md §1.4, "the single most important repeating
 * element", used in every table and every log row.
 *
 * Two details from the spec that are load-bearing rather than decorative:
 *
 *  - Only the DOT pulses, never the label or background. A pulsing block of text is a
 *    motion-sickness trigger, and these tables can hold hundreds of rows.
 *  - The dot is `aria-hidden` and the state is also carried as text. Colour alone is not
 *    an accessible status signal, and "green vs amber" is precisely the distinction a
 *    red-green colourblind user cannot make.
 *
 * [RELAY-105] Light-mode pairing, per ui-revamp-spec-2026-08-19.md §3.2.
 *
 * The unprefixed classes below are now the LIGHT pairing (light is the new default per
 * §3.1/§1.4), and the `dark:` classes are the pre-existing dark pairing, unchanged in
 * value — gated with Tailwind's `darkMode: 'class'` strategy already driving every other
 * `dark:` class in this codebase (`lib/theme.ts`'s `applyTheme` toggles `.dark` on
 * `<html>`; no new mechanism invented). Every light-mode text pair is WCAG-AA-checked
 * against its own `-50` swatch background with a script (standard relative-luminance
 * formula), not assumed — see the commit message / dev log for the script and full output:
 *
 *   green-50/green-700   #f0fdf4 / #15803d  →  4.79:1
 *   amber-50/amber-700   #fffbeb / #b45309  →  4.84:1
 *   red-50/red-700       #fef2f2 / #b91c1c  →  5.91:1
 *   blue-50/blue-700     #eff6ff / #1d4ed8  →  6.16:1
 *   violet-50/violet-700 #f5f3ff / #6d28d9  →  6.48:1
 *
 * All five clear the 4.5:1 AA threshold for normal text.
 *
 * The DOT (aria-hidden, 3:1 UI-component threshold, WCAG 1.4.11) was checked too, against
 * its own badge background rather than the page background, since that is what it actually
 * sits on:
 *
 *   green-500 dot on green-50   → 2.18:1  (FAILS 3:1 — bumped to green-600  → 3.15:1)
 *   amber-500 dot on amber-50   → 2.07:1  (FAILS 3:1 — bumped to amber-600 → 3.07:1)
 *   red-500 dot on red-50       → 3.44:1  (passes as-is)
 *   blue-500 dot on blue-50     → 3.38:1  (passes as-is)
 *   violet-500 dot on violet-50 → 3.86:1  (passes as-is)
 *
 * Only green and amber needed a darker dot shade in light mode; red/blue/violet keep -500.
 * The dot is also redundant with the text label by design (see above), so this would not
 * have blocked ship even unfixed — but the ticket asked for a measured number, not an
 * assumption, and darkening two shades was cheap enough to just do.
 */

export type BadgeState =
  | 'SUCCESS'
  | 'DELIVERED'
  | 'RETRYING'
  | 'FAILED'
  | 'DLQ'
  | 'QUEUED'
  | 'PAUSED'
  | 'ACTIVE'
  | 'FAILING'
  // [RELAY-50] Marks a DeliveryLog row written by the "Send test webhook" button.
  // Distinct from DELIVERED — a real delivery SUCCESS carrying this badge would
  // lie about which bytes actually reached a customer endpoint, and the billing
  // exclusion hooks it, so the same flag states it on both sides.
  | 'TEST';

const STYLES: Record<BadgeState, { wrap: string; dot: string; pulse: boolean; label: string }> = {
  SUCCESS:   { wrap: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400', dot: 'bg-green-600 dark:bg-green-500', pulse: false, label: 'SUCCESS' },
  DELIVERED: { wrap: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400', dot: 'bg-green-600 dark:bg-green-500', pulse: false, label: 'DELIVERED' },
  ACTIVE:    { wrap: 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400', dot: 'bg-green-600 dark:bg-green-500', pulse: false, label: 'LIVE' },
  RETRYING:  { wrap: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400', dot: 'bg-amber-600 dark:bg-amber-500', pulse: true,  label: 'RETRYING' },
  FAILING:   { wrap: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400', dot: 'bg-amber-600 dark:bg-amber-500', pulse: true,  label: 'FAILING' },
  QUEUED:    { wrap: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',     dot: 'bg-blue-500',  pulse: true,  label: 'QUEUED' },
  FAILED:    { wrap: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',         dot: 'bg-red-500',   pulse: false, label: 'FAILED' },
  // DLQ keeps its own, more severe dark-mode pairing (red-900/40 + red-300, distinct from
  // FAILED's red-500/10 + red-400) — that distinction predates this ticket and isn't
  // touched. Light mode uses the same red-50/red-700 "Error" pairing the spec gives for
  // both FAILED and DLQ; the spec's §3.2 table doesn't distinguish them.
  DLQ:       { wrap: 'bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-300',         dot: 'bg-red-500',   pulse: false, label: 'DLQ' },
  // PAUSED isn't one of the spec's five named states — light values follow the same
  // tint-bg/saturated-text pattern at the neutral (zinc) hue. zinc-100/zinc-600 measures
  // 7.03:1, comfortably clearing AA.
  PAUSED:    { wrap: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-700/40 dark:text-zinc-400',    dot: 'bg-zinc-500',  pulse: false, label: 'PAUSED' },
  // [RELAY-50] TEST is its own colour precisely so it cannot be confused with a real
  // DELIVERED row. The `isTest` flag travels on the FeedRow type, not on the status,
  // because a TEST row's status is still QUEUED/DELIVERED/… — and collapsing them
  // would hide whether the synthetic send actually reached its destination.
  TEST:      { wrap: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', dot: 'bg-violet-500', pulse: false, label: 'TEST' },
};

export function StatusBadge({ state, className }: { state: BadgeState; className?: string }) {
  const style = STYLES[state] ?? STYLES.PAUSED;

  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1.5 rounded-full px-2 py-1',
        'font-mono text-xs font-medium uppercase',
        style.wrap,
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 rounded-full', style.dot, style.pulse && 'animate-pulse')}
      />
      {style.label}
    </span>
  );
}
