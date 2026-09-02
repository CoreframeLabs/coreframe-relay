import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import useSWR from 'swr';
import type { DeliveryStatus } from '@prisma/client';

import fetcher from '@/lib/fetcher';
import {
  DeliveryFilters,
  type RouteOption,
  type StatusFilter,
} from './DeliveryFilters';
import { DeliveryStreamStatus } from './DeliveryStreamStatus';
import { DeliveryTable } from './DeliveryTable';
import { DeliveryDetail } from './DeliveryDetail';
import { useDeliveryStream, type DeliveryRow } from './DeliveryStream';

/**
 * Buffer → Delivery Log. relay-ui-ux-spec.md §3.3. [RELAY-7]
 *
 * [design-overhaul 2026-08] Used to force a `.dark` class on this wrapper regardless of
 * the app's real theme — see `BufferRoutes.tsx`'s header for the full history. Removed
 * here too. `DeliveryStreamStatus.tsx`'s state colours were retuned alongside this change
 * (they were raw `-400` shades assuming a permanently dark ambient); everything else in
 * this tree (`DeliveryTable`, `DeliveryDetail`, `DeliveryFilters`) already used
 * theme-aware shadcn tokens.
 */

/** Mirrors DELIVERY_FEED_MAX_ROWS in models/delivery.ts. The server enforces it too. */
const MAX_ROWS = 200;

/** How often the announcement below is allowed to speak. */
const ANNOUNCE_INTERVAL_MS = 10_000;

export function DeliveryLogFeed() {
  const router = useRouter();
  const { slug } = router.query as { slug?: string };

  const [routeId, setRouteId] = useState<string | 'ALL'>('ALL');
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState<DeliveryRow | null>(null);

  // Reuses [RELAY-6]'s routes endpoint rather than adding a second one that answers the
  // same question.
  const { data: routeData } = useSWR<{ data: RouteOption[] }>(
    slug ? `/api/teams/${slug}/relay/routes` : null,
    fetcher
  );
  const routes = useMemo(() => routeData?.data ?? [], [routeData]);

  const {
    rows,
    state,
    mode,
    intervalMs,
    error,
    freshIds,
    arrivedCount,
    reconnect,
  } = useDeliveryStream({
    teamSlug: slug,
    routeId: routeId === 'ALL' ? undefined : routeId,
    status: status === 'ALL' ? undefined : (status as DeliveryStatus),
    paused,
    maxRows: MAX_ROWS,
  });

  /**
   * §"Screen reader support: live feed has aria-live='polite'".
   *
   * Taken as a requirement to keep an assistive-technology user informed, NOT as a licence
   * to announce every row. A feed under load emits rows faster than speech synthesis can
   * read them, and a polite live region that never stops talking is worse than silence —
   * it makes the rest of the page unusable. So the region carries a THROTTLED SUMMARY.
   */
  const [announcement, setAnnouncement] = useState('');
  const lastAnnouncedRef = useRef({ count: 0, at: 0 });

  useEffect(() => {
    const now = Date.now();
    const since = lastAnnouncedRef.current;
    if (arrivedCount === since.count) return;
    if (now - since.at < ANNOUNCE_INTERVAL_MS) return;

    const delta = arrivedCount - since.count;
    lastAnnouncedRef.current = { count: arrivedCount, at: now };
    setAnnouncement(
      `${delta} new ${delta === 1 ? 'delivery' : 'deliveries'}. ${rows.length} shown.`
    );
  }, [arrivedCount, rows.length]);

  const emptyMessage =
    routeId === 'ALL' && status === 'ALL'
      ? 'No deliveries yet. Once a webhook arrives at one of your relay URLs it appears here within seconds.'
      : 'No deliveries match this filter.';

  return (
    <div className="min-h-full bg-background p-6 text-foreground">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Delivery Log
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every webhook Relay has received, newest first. The feed holds the
            most recent {MAX_ROWS}.
          </p>
        </div>

        <DeliveryStreamStatus
          state={state}
          mode={mode}
          intervalMs={intervalMs}
          rowCount={rows.length}
          maxRows={MAX_ROWS}
          paused={paused}
          onTogglePause={() => setPaused((value) => !value)}
          onReconnect={reconnect}
        />
      </div>

      <DeliveryFilters
        routes={routes}
        routeId={routeId}
        onRouteChange={setRouteId}
        status={status}
        onStatusChange={setStatus}
      />

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-300"
        >
          {error}
        </div>
      )}

      <DeliveryTable
        rows={rows}
        freshIds={freshIds}
        selectedId={selected?.id ?? null}
        onSelect={setSelected}
        emptyMessage={
          state === 'connecting' && rows.length === 0
            ? 'Connecting to the delivery stream…'
            : emptyMessage
        }
      />

      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>

      <DeliveryDetail row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
