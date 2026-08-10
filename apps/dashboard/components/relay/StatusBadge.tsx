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
  SUCCESS:   { wrap: 'bg-green-500/10 text-green-400', dot: 'bg-green-500', pulse: false, label: 'SUCCESS' },
  DELIVERED: { wrap: 'bg-green-500/10 text-green-400', dot: 'bg-green-500', pulse: false, label: 'DELIVERED' },
  ACTIVE:    { wrap: 'bg-green-500/10 text-green-400', dot: 'bg-green-500', pulse: false, label: 'LIVE' },
  RETRYING:  { wrap: 'bg-amber-500/10 text-amber-400', dot: 'bg-amber-500', pulse: true,  label: 'RETRYING' },
  FAILING:   { wrap: 'bg-amber-500/10 text-amber-400', dot: 'bg-amber-500', pulse: true,  label: 'FAILING' },
  QUEUED:    { wrap: 'bg-blue-500/10 text-blue-400',   dot: 'bg-blue-500',  pulse: true,  label: 'QUEUED' },
  FAILED:    { wrap: 'bg-red-500/10 text-red-400',     dot: 'bg-red-500',   pulse: false, label: 'FAILED' },
  DLQ:       { wrap: 'bg-red-900/40 text-red-300',     dot: 'bg-red-500',   pulse: false, label: 'DLQ' },
  PAUSED:    { wrap: 'bg-zinc-700/40 text-zinc-400',   dot: 'bg-zinc-500',  pulse: false, label: 'PAUSED' },
  // [RELAY-50] TEST is its own colour precisely so it cannot be confused with a real
  // DELIVERED row. The `isTest` flag travels on the FeedRow type, not on the status,
  // because a TEST row's status is still QUEUED/DELIVERED/… — and collapsing them
  // would hide whether the synthetic send actually reached its destination.
  TEST:      { wrap: 'bg-violet-500/15 text-violet-300',dot: 'bg-violet-500', pulse: false, label: 'TEST' },
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
