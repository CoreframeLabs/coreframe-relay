import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeliveryStatus } from '@prisma/client';

/**
 * The client half of the [RELAY-7] delivery feed.
 *
 * This file is `.tsx` and lives beside the components it serves rather than in `hooks/`
 * because the ticket's file boundary is `components/relay/Delivery*.tsx`. It exports no
 * component; it is the transport.
 */

/**
 * One feed row as it arrives over the wire.
 *
 * Deliberately NOT `DeliveryFeedRow` from `models/delivery`. That type has real `Date`
 * objects; JSON does not, so what the browser actually holds is ISO strings. Reusing the
 * server type here would typecheck and then throw at runtime the first time something
 * called `.getTime()`.
 */
export type DeliveryRow = {
  id: string;
  requestId: string;
  status: DeliveryStatus;
  attemptCount: number;
  responseCode: number | null;
  latencyMs: number | null;
  payloadSizeB: number | null;
  sourceIp: string | null;
  createdAt: string;
  deliveredAt: string | null;
  route: { id: string; name: string; slug: string };
};

export type StreamState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'paused'
  | 'error';

/** What the server says it is doing. Surfaced verbatim in the UI — never assumed. */
export type StreamMode = 'poll' | 'realtime';

type SnapshotEvent = {
  rows: DeliveryRow[];
  maxRows: number;
  mode: StreamMode;
  intervalMs: number;
};

type DeltaEvent = {
  added: DeliveryRow[];
  updated: DeliveryRow[];
};

/**
 * EventSource retries forever on its own, which is right for a blip and wrong for a
 * revoked session — it becomes an invisible request loop against a 401. After this many
 * consecutive failures with no successful open in between, the stream gives up and the UI
 * offers a manual Reconnect.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Cleared after the row-insert highlight has played, so it never accumulates. */
const HIGHLIGHT_MS = 1200;

export type UseDeliveryStreamOptions = {
  teamSlug?: string;
  routeId?: string;
  status?: DeliveryStatus;
  paused: boolean;
  maxRows: number;
};

export function useDeliveryStream({
  teamSlug,
  routeId,
  status,
  paused,
  maxRows,
}: UseDeliveryStreamOptions) {
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [state, setState] = useState<StreamState>('idle');
  const [mode, setMode] = useState<StreamMode | null>(null);
  const [intervalMs, setIntervalMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  /** Ids to highlight as freshly arrived — drives the §3.3 row-insert animation. */
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  /**
   * A running count of rows that arrived, used only to build a throttled screen-reader
   * announcement. See DeliveryLogFeed — announcing each row individually in a live feed is
   * hostile, so the live region gets a summary instead.
   */
  const [arrivedCount, setArrivedCount] = useState(0);
  /** Bumped to force a reconnect after the failure budget is spent. */
  const [attempt, setAttempt] = useState(0);

  const failuresRef = useRef(0);
  const highlightTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const reconnect = useCallback(() => {
    failuresRef.current = 0;
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  const markFresh = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setFreshIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    const timer = setTimeout(() => {
      setFreshIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      highlightTimers.current.delete(timer);
    }, HIGHLIGHT_MS);
    highlightTimers.current.add(timer);
  }, []);

  useEffect(() => {
    const timers = highlightTimers.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (!teamSlug) {
      setState('idle');
      return;
    }

    if (paused) {
      // Pausing closes the connection rather than buffering into a hidden queue. A paused
      // feed that quietly keeps a socket and 200 rows of backlog is how a "paused" page
      // ends up costing more than a live one.
      setState('paused');
      return;
    }

    const params = new URLSearchParams();
    if (routeId) params.set('routeId', routeId);
    if (status) params.set('status', status);
    const query = params.toString();
    const url = `/api/teams/${encodeURIComponent(teamSlug)}/relay/log-stream${
      query ? `?${query}` : ''
    }`;

    setState('connecting');
    const source = new EventSource(url);

    source.onopen = () => {
      failuresRef.current = 0;
      setError(null);
      setState('live');
    };

    source.addEventListener('snapshot', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as SnapshotEvent;
      setRows(payload.rows.slice(0, maxRows));
      setMode(payload.mode);
      setIntervalMs(payload.intervalMs);
      setLastEventAt(Date.now());
      setState('live');
    });

    source.addEventListener('delta', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as DeltaEvent;
      setLastEventAt(Date.now());

      setRows((prev) => {
        const patch = new Map(payload.updated.map((row) => [row.id, row]));
        const patched = patch.size
          ? prev.map((row) => patch.get(row.id) ?? row)
          : prev;

        const seen = new Set(patched.map((row) => row.id));
        // The server already sends `added` newest-first, so prepending preserves order
        // without a re-sort. The `seen` guard covers the one overlap case: a row that a
        // filter change re-fetched while the previous list was still mounted.
        const fresh = payload.added.filter((row) => !seen.has(row.id));

        if (fresh.length === 0 && patch.size === 0) return prev;
        return [...fresh, ...patched].slice(0, maxRows);
      });

      const freshIdList = payload.added.map((row) => row.id);
      markFresh(freshIdList);
      if (freshIdList.length > 0) {
        setArrivedCount((n) => n + freshIdList.length);
      }
    });

    source.addEventListener('stream-error', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        message: string;
      };
      // The connection is still up — this is a failed poll, not a failed stream.
      setError(payload.message);
    });

    source.onerror = () => {
      failuresRef.current += 1;
      if (failuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        source.close();
        setState('error');
        setError(
          'Lost connection to the delivery stream after several attempts.'
        );
        return;
      }
      setState('reconnecting');
    };

    return () => {
      // Closing here is what fires `req.on('close')` on the server and tears down its
      // poll timer. Skipping it leaks a timer per navigation.
      source.close();
    };
  }, [teamSlug, routeId, status, paused, maxRows, attempt, markFresh]);

  return {
    rows,
    state,
    mode,
    intervalMs,
    error,
    lastEventAt,
    freshIds,
    arrivedCount,
    reconnect,
  };
}
