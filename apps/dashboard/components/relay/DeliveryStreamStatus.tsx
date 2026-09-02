import { Pause, Play, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { StreamMode, StreamState } from './DeliveryStream';

/**
 * Connection indicator for the delivery feed. [RELAY-7]
 *
 * Two rules from [RELAY-6]'s precedent are load-bearing here:
 *
 *  - Only the DOT pulses. A pulsing block of text is a motion trigger, and this element is
 *    permanently on screen.
 *  - The state is carried as TEXT, not only as colour. "Live" green versus "Reconnecting"
 *    amber is exactly the distinction a red-green colourblind user cannot make.
 *
 * And one rule specific to this ticket: **the transport is named on screen.** `mode` comes
 * from the server, which reports `poll` today because Supabase Realtime cannot carry this
 * feed (see the API route's header comment for the measurements). Showing "Live" alone
 * would imply push semantics the stream does not have, and someone would eventually debug
 * a two-second lag as a bug.
 *
 * [design-overhaul 2026-08] `text` used to be a flat `-400` shade (`text-zinc-400`,
 * `text-blue-400`, …) — legible on the dark ambient `DeliveryLogFeed` used to force via a
 * hardcoded `.dark` wrapper, but that wrapper is gone (see `DeliveryLogFeed.tsx`'s header)
 * and a `-400` shade on a white light-mode surface drops well below AA (`text-zinc-400`
 * #a1a1aa on white measures ~2.4:1). Retuned to the same light-tint/saturated-text pattern
 * `StatusBadge.tsx` already uses and already measured: `-700` text clears 4.5:1 on white,
 * `dark:` keeps the original `-400` values unchanged.
 */

const STATE_COPY: Record<
  StreamState,
  { label: string; dot: string; pulse: boolean; text: string }
> = {
  idle: {
    label: 'Idle',
    dot: 'bg-zinc-500',
    pulse: false,
    text: 'text-zinc-600 dark:text-zinc-400',
  },
  connecting: {
    label: 'Connecting',
    dot: 'bg-blue-500',
    pulse: true,
    text: 'text-blue-700 dark:text-blue-400',
  },
  live: {
    label: 'Live',
    dot: 'bg-green-600 dark:bg-green-500',
    pulse: true,
    text: 'text-green-700 dark:text-green-400',
  },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'bg-amber-600 dark:bg-amber-500',
    pulse: true,
    text: 'text-amber-700 dark:text-amber-400',
  },
  paused: {
    label: 'Paused',
    dot: 'bg-zinc-500',
    pulse: false,
    text: 'text-zinc-600 dark:text-zinc-400',
  },
  error: {
    label: 'Disconnected',
    dot: 'bg-red-500',
    pulse: false,
    text: 'text-red-700 dark:text-red-400',
  },
};

export function DeliveryStreamStatus({
  state,
  mode,
  intervalMs,
  rowCount,
  maxRows,
  paused,
  onTogglePause,
  onReconnect,
}: {
  state: StreamState;
  mode: StreamMode | null;
  intervalMs: number | null;
  rowCount: number;
  maxRows: number;
  paused: boolean;
  onTogglePause: () => void;
  onReconnect: () => void;
}) {
  const copy = STATE_COPY[state];

  const transport =
    mode === 'poll' && intervalMs
      ? `polled every ${(intervalMs / 1000).toFixed(0)}s`
      : mode === 'realtime'
        ? 'realtime'
        : null;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span
        className={cn(
          'inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium',
          copy.text
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            copy.dot,
            copy.pulse && 'motion-safe:animate-pulse'
          )}
        />
        {copy.label}
        {transport && (
          <span className="font-normal text-muted-foreground">
            · {transport}
          </span>
        )}
      </span>

      <span className="font-mono text-xs text-muted-foreground">
        {rowCount} / {maxRows} rows
      </span>

      <Button
        size="sm"
        variant="ghost"
        onClick={onTogglePause}
        aria-pressed={paused}
      >
        {paused ? (
          <Play className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Pause className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        )}
        {paused ? 'Resume' : 'Pause'}
      </Button>

      {state === 'error' && (
        <Button size="sm" variant="secondary" onClick={onReconnect}>
          <RotateCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Reconnect
        </Button>
      )}
    </div>
  );
}
