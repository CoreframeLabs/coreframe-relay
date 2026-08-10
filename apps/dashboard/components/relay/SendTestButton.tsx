import { useEffect, useRef, useState } from 'react';
import { Zap, Loader2, Check, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { StatusBadge } from './StatusBadge';

/**
 * The "Send test webhook" button — [RELAY-50].
 *
 * Fires one synthetic webhook through the route's REAL ingest URL and polls the
 * delivery-feed for the row the consumer writes, so the button is end-to-end
 * verification the pipeline runs, not a mock that always succeeds.
 *
 * The result is shown here, not in a side panel that has already scrolled past: the
 * row that proves the send landed can be seconds late on a loaded pipeline, and an
 * operator looking at this button is asking "did you actually go?" — the answer lives
 * on the button itself until they dismiss it.
 *
 * [RELAY-50's last AC] The "Send to catcher" action re-points the route at the
 * built-in catcher first, then sends — two steps in one click for an onboarding user
 * who has not wired a destination yet. It is NOT the same as the plain send: the
 * route's destination changes for every sender.

 */
export function SendTestButton({
  routeId,
  teamSlug,
  routeName,
  onSent,
}: {
  routeId: string;
  teamSlug: string;
  /** Used in the dialog's accessible summary. */
  routeName: string;
  /** Called once a delivery row for the test send is observed (any status). */
  onSent?: (requestId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<
    'idle' | 'sending' | 'queued' | 'observed' | 'failed' | 'error'
  >('idle');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [resultRow, setResultRow] = useState<null | {
    status: string;
    responseCode: number | null;
    latencyMs: number | null;
  }>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll deadline and timer — cleaned up by id so a closed popover never continues
  // burning requests.
  const pollerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadlineRef = useRef<number>(0);

  useEffect(
    () => () => {
      if (pollerRef.current) clearInterval(pollerRef.current);
    },
    []
  );

  const stopPolling = () => {
    if (pollerRef.current) {
      clearInterval(pollerRef.current);
      pollerRef.current = null;
    }
  };

  const startPolling = (id: string) => {
    stopPolling();
    // Twenty real seconds, polled at 2s — the same interval the feed uses, so this
    // never leads the user to refresh faster than the database can answer.
    deadlineRef.current = Date.now() + 20_000;
    pollerRef.current = setInterval(async () => {
      if (Date.now() > deadlineRef.current) {
        stopPolling();
        setPhase('queued');
        // The row did not materialise within the budget. That does not mean the send
        // failed — the proxy told us it was queued — it means the consumer is slower
        // than this dialog's attention span. The honest report is "queued, check the
        // log in a second", not a red X the user then cannot reproduce.
        return;
      }

      try {
        const feed = await fetch(
          `/api/teams/${encodeURIComponent(teamSlug)}/relay/log?routeId=${encodeURIComponent(routeId)}`
        ).then((r) => (r.ok ? r.json() : null));

        if (!feed?.data) return;

        const found = (feed.data as Array<{ requestId: string; status: string; responseCode: number | null; latencyMs: number | null; isTest: boolean }>)
          .find((r) => r.requestId === id && r.isTest);

        if (found) {
          stopPolling();
          setResultRow(found);
          setPhase('observed');
          onSent?.(id);
        }
      } catch {
        // A single failed poll is not yet an error worth showing; the deadline is.
      }
    }, 2_000);
  };

  const send = async (toCatcher: boolean) => {
    setPhase('sending');
    setError(null);
    setResultRow(null);
    setRequestId(null);
    stopPolling();

    try {
      const res = await fetch(
        `/api/teams/${encodeURIComponent(teamSlug)}/relay/routes/${encodeURIComponent(routeId)}/test-send${toCatcher ? '?catcher=true' : ''}`,
        { method: 'POST' }
      );
      const json = (await res.json().catch(() => ({}))) as {
        data?: { requestId?: string };
        error?: { message?: string };
      };

      if (!res.ok) {
        setPhase('failed');
        setError(json.error?.message ?? `Send failed (${res.status})`);
        return;
      }

      const id = json.data?.requestId ?? null;
      setRequestId(id);
      setPhase('queued');
      if (id) startPolling(id);
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : 'Send failed');
    }
  };

  const close = () => {
    stopPolling();
    setOpen(false);
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Zap className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        Send test
      </Button>

      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label={`Send test webhook for ${routeName}`}
          className="absolute z-20 mt-8 w-72 rounded-lg border bg-popover p-3 text-sm shadow-md"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <p className="font-medium">Send a test webhook</p>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="space-y-2">
            <Button
              type="button"
              size="sm"
              className="w-full justify-start"
              disabled={phase === 'sending'}
              onClick={() => send(false)}
            >
              {phase === 'sending' && !resultRow ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="mr-2 h-3.5 w-3.5" />
              )}
              Send to destination
            </Button>

            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="w-full justify-start"
              disabled={phase === 'sending'}
              onClick={() => send(true)}
            >
              {phase === 'sending' && !resultRow ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="mr-2 h-3.5 w-3.5" />
              )}
              Send to the built-in catcher
            </Button>
          </div>

          {phase === 'failed' && error && (
            <p role="alert" className="mt-2 text-xs text-red-400">
              {error}
            </p>
          )}
          {phase === 'error' && error && (
            <p role="alert" className="mt-2 text-xs text-red-400">
              {error}
            </p>
          )}

          {phase === 'queued' && requestId && !resultRow && (
            <p className="mt-2 text-xs text-muted-foreground">
              Queued. Waiting for the delivery row…
            </p>
          )}

          {resultRow && requestId && (
            <div className="mt-3 space-y-1 border-t border-border/50 pt-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Status</span>
                <StatusBadge
                  state={resultRow.status as never}
                />
                <StatusBadge state="TEST" />
              </div>
              <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
                <span>Response</span>
                <span>{resultRow.responseCode ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
                <span>Latency</span>
                <span>
                  {resultRow.latencyMs === null
                    ? '—'
                    : resultRow.latencyMs >= 1000
                      ? `${(resultRow.latencyMs / 1000).toFixed(2)}s`
                      : `${resultRow.latencyMs}ms`}
                </span>
              </div>
              <div className="flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                <span>Request</span>
                <span className="truncate pl-2">{requestId}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                This row is labeled TEST in the delivery log and excluded from billing
                counters.
              </p>
            </div>
          )}

          <p className="mt-2 text-[11px] text-muted-foreground">
            A synthetic webhook is fired through the REAL ingest endpoint — this proves
            the queue + forward path work without a third-party sender pointing at the
            route.
          </p>
        </div>
      )}
    </div>
  );
}
