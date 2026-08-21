import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';
import { StatusBadge, type BadgeState } from './StatusBadge';
import type { DeliveryRow } from './DeliveryStream';

/**
 * The virtualized delivery feed — relay-ui-ux-spec.md §3.3. [RELAY-7]
 *
 * ── WHY THE VIRTUALIZATION IS HAND-WRITTEN ─────────────────────────────────────────────
 *
 * The spec names TanStack Virtual. `pnpm add @tanstack/react-virtual` fails in this
 * environment — every live registry metadata fetch does. Verified it is the environment
 * and not the package: `pnpm add is-odd` in an empty directory fails identically with
 * ERR_PNPM_META_FETCH_FAIL / ETIMEDOUT, while `curl https://registry.npmjs.org/...`
 * returns 200 in ~2s and `npm install` works. Rather than claim a dependency that is not
 * installed, the windowing is ~40 lines below: rows are a fixed 40px, so the visible slice
 * is arithmetic and none of TanStack's dynamic-measurement machinery is needed. If the
 * registry becomes reachable, swapping in `useVirtualizer` touches only this file.
 *
 * ── WHY THE ROLES ARE EXPLICIT INSTEAD OF USING <table> ────────────────────────────────
 *
 * Virtualizing a real `<table>` requires `display: grid` on the table element, and
 * changing a table's `display` drops its implicit ARIA roles in Chrome and Firefox — the
 * markup looks right in review and announces nothing. Explicit `role="table"` / `"row"` /
 * `"columnheader"` / `"cell"` on divs survives any CSS. `aria-rowcount` and `aria-rowindex`
 * carry the TRUE position, because only ~20 of the rows are ever in the DOM and without
 * them a screen reader would report "row 3 of 20" while the user is at row 140 of 200.
 */

const ROW_HEIGHT = 40;
const OVERSCAN = 8;

/**
 * One template string shared by the header and every row. Two declarations drift, and a
 * header that no longer lines up with its columns is worse than no header.
 */
const GRID =
  'grid grid-cols-[6.5rem_15rem_11rem_9rem_5rem_6.5rem_13rem] items-center gap-x-3 px-3';

/**
 * Dates are formatted with an explicit `en-GB` locale and UTC, as [RELAY-6] established.
 * A bare `toLocaleString()` renders per-machine, and 03/04 vs 04/03 in a screenshot
 * attached to an incident costs an hour.
 *
 * Duplicated from RoutesTable rather than imported: that file is outside this ticket's
 * boundary and could not be edited to export it. Worth folding into a shared
 * `components/relay/format.ts` next time either file is open.
 */
export const fmtDateTime = (value: string | Date | null): string => {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        timeZone: 'UTC',
      }).format(d) + ' UTC';
};

/** Short form for the dense feed column; the full UTC stamp lives in the row's title. */
export const fmtTimeOfDay = (value: string | null): string => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'short',
        timeStyle: 'medium',
        timeZone: 'UTC',
      }).format(d);
};

export const fmtLatency = (ms: number | null): string =>
  ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

export const fmtBytes = (bytes: number | null): string => {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const COLUMNS = [
  'Status',
  'Request ID',
  'Route',
  'Source',
  'Code',
  'Latency',
  'Received',
] as const;

export function DeliveryTable({
  rows,
  freshIds,
  selectedId,
  onSelect,
  emptyMessage,
}: {
  rows: DeliveryRow[];
  freshIds: Set<string>;
  selectedId: string | null;
  onSelect: (row: DeliveryRow) => void;
  emptyMessage: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  /**
   * The row currently at the top of the viewport, remembered by id rather than index.
   *
   * §3.3: "Existing rows are NOT re-rendered — they stay in place. This prevents
   * disorienting reflows." In a newest-first feed that is not free: every arrival shifts
   * every existing row down by one. Anchoring on the id and correcting `scrollTop` after
   * the list changes is what actually holds the user's position while reading.
   */
  const anchorRef = useRef<{ id: string; offset: number } | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const measure = () => setViewportHeight(element.clientHeight);
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const top = event.currentTarget.scrollTop;
      setScrollTop(top);

      const index = Math.floor(top / ROW_HEIGHT);
      const row = rows[index];
      anchorRef.current = row
        ? { id: row.id, offset: top - index * ROW_HEIGHT }
        : null;
    },
    [rows]
  );

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = anchorRef.current;
    // At the very top there is nothing to preserve — that is the live-tail position, and
    // holding it is the whole point of a feed.
    if (!element || !anchor || element.scrollTop === 0) return;

    const index = rows.findIndex((row) => row.id === anchor.id);
    if (index < 0) return;

    const desired = index * ROW_HEIGHT + anchor.offset;
    if (Math.abs(desired - element.scrollTop) > 0.5) {
      element.scrollTop = desired;
      setScrollTop(desired);
    }
  }, [rows]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(
    rows.length,
    Math.ceil((scrollTop + (viewportHeight || 600)) / ROW_HEIGHT) + OVERSCAN
  );
  const visible = rows.slice(start, end);

  return (
    <div className="overflow-x-auto rounded-lg border">
      <div
        role="table"
        aria-label="Webhook delivery log"
        // +1 for the header row, so a screen reader's count matches what is on screen.
        aria-rowcount={rows.length + 1}
        className="min-w-[66rem]"
      >
        <div role="rowgroup">
          <div
            role="row"
            aria-rowindex={1}
            className={cn(
              GRID,
              'h-9 border-b bg-muted/40 text-xs font-medium uppercase tracking-wide text-muted-foreground'
            )}
          >
            {COLUMNS.map((column) => (
              <div key={column} role="columnheader" className="truncate">
                {column}
              </div>
            ))}
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <div
            role="rowgroup"
            ref={scrollRef}
            onScroll={handleScroll}
            // A fixed viewport is what makes the list virtualizable at all; without it the
            // page grows to 200 rows and there is nothing to window.
            className="h-[calc(100vh-22rem)] min-h-[18rem] overflow-y-auto"
          >
            <div
              style={{ height: rows.length * ROW_HEIGHT }}
              className="relative"
            >
              <div
                style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}
                className="absolute left-0 top-0 w-full"
              >
                {visible.map((row, offset) => {
                  const index = start + offset;
                  const isFresh = freshIds.has(row.id);
                  const isSelected = selectedId === row.id;
                  const isDead =
                    row.status === 'DLQ' || row.status === 'FAILED';

                  return (
                    <div
                      key={row.id}
                      role="row"
                      aria-rowindex={index + 2}
                      aria-selected={isSelected}
                      onClick={() => onSelect(row)}
                      style={{ height: ROW_HEIGHT }}
                      className={cn(
                        GRID,
                        'cursor-pointer border-b border-border/50 text-sm hover:bg-muted/40',
                        // The 4px accent border is reserved on EVERY row and merely made
                        // transparent on healthy ones. Applied only to dead rows it shifts
                        // their content 4px right, and the Status column visibly stops
                        // lining up — caught in the browser, not in review.
                        'border-l-4 border-l-transparent',
                        // §3.3: DLQ rows carry a red left border so a dead payload is
                        // impossible to scroll past.
                        isDead && 'border-l-red-500 bg-red-500/5',
                        isSelected && 'bg-muted/70',
                        // Motion is opt-in. A feed that slides on every arrival is a
                        // vestibular trigger, and these rows arrive unprompted.
                        isFresh &&
                          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-200',
                        // The non-motion signal for the same event, which is what a
                        // reduced-motion user actually gets.
                        isFresh && 'bg-violet-500/10'
                      )}
                    >
                      <div role="cell">
                        {/* TEST is a second badge, not a status overwrite: a row can
                            be TEST+DELIVERED, and only seeing the colour on one arm
                            would throw away whether the synthetic send arrived. */}
                        <div className="flex items-center gap-1.5">
                          <StatusBadge state={row.status as BadgeState} />
                          {row.isTest && <StatusBadge state="TEST" />}
                        </div>
                      </div>

                      <div role="cell" className="min-w-0">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelect(row);
                          }}
                          title={row.requestId}
                          className="block w-full truncate text-left font-mono text-xs text-foreground/90 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {row.requestId}
                        </button>
                      </div>

                      <div
                        role="cell"
                        className="truncate text-xs"
                        title={`${row.route.name} (/${row.route.slug})`}
                      >
                        {row.route.name}
                      </div>

                      <div
                        role="cell"
                        className="truncate font-mono text-xs text-muted-foreground"
                      >
                        {row.sourceIp ?? '—'}
                      </div>

                      <div
                        role="cell"
                        className={cn(
                          'font-mono text-xs',
                          row.responseCode === null
                            ? 'text-muted-foreground'
                            : row.responseCode >= 500
                              ? // [RELAY-105] Was an unconditional 'text-red-400' — the
                                // dark-mode-tuned -400 shade measures 2.77:1 on the
                                // light-mode white row background (fails 4.5:1 AA by a
                                // wide margin; computed, not assumed). -700 for light,
                                // -400 kept for dark via the same `dark:` gating pattern
                                // used everywhere else in this codebase.
                                'text-red-700 dark:text-red-400'
                              : row.responseCode >= 400
                                ? 'text-amber-700 dark:text-amber-400'
                                : 'text-green-700 dark:text-green-400'
                        )}
                      >
                        {row.responseCode ?? '—'}
                      </div>

                      <div
                        role="cell"
                        className="font-mono text-xs text-muted-foreground"
                      >
                        {fmtLatency(row.latencyMs)}
                      </div>

                      <div
                        role="cell"
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={fmtDateTime(row.createdAt)}
                      >
                        {fmtTimeOfDay(row.createdAt)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
