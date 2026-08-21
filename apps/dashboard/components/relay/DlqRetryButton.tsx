import { useState } from 'react';
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { DlqRow } from './DlqTable';

/**
 * The Retry action on a DLQ item. [RELAY-8]
 *
 * ─── Why there is a confirm step ──────────────────────────────────────────────────────
 *
 * Retry is irreversible in the way that matters: it causes a real HTTP POST to a real
 * customer endpoint carrying a real customer payload. It cannot be undone, and the server
 * allows it exactly once per item. Per [RELAY-6]'s precedent, an irreversible action gets
 * a confirm step that states what will happen — not a toast afterwards saying what did.
 *
 * ─── Why the button is sometimes disabled, and always says why ────────────────────────
 *
 * The single most likely way this page lies to an operator is offering Retry on an item
 * that cannot be retried. Over-64KB payloads were stored NEITHER inline nor by key, so
 * there is no body to republish; already-retried items are refused by the server's atomic
 * claim; a paused route must not be sent to. Each of those disables the button AND puts
 * the reason in text next to it. A disabled control with no explanation is a bug report
 * waiting to be filed.
 */

type Outcome =
  | { kind: 'idle' }
  | { kind: 'queued'; messageId: string | null }
  | { kind: 'error'; message: string };

/** Why this item cannot be retried, or null if it can. Text, because it is shown. */
export function retryBlockedReason(row: DlqRow): string | null {
  if (!row.payloadRetained) {
    return 'No payload stored — nothing to republish.';
  }
  if (row.retriedAt) {
    return 'Already retried once.';
  }
  if (row.route.status === 'PAUSED') {
    return 'Route is paused.';
  }
  return null;
}

export function DlqRetryButton({
  row,
  teamSlug,
  onRetried,
}: {
  row: DlqRow;
  teamSlug: string;
  onRetried: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  const blocked = retryBlockedReason(row);

  const submit = async () => {
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/teams/${teamSlug}/relay/dlq/${row.id}/retry`,
        { method: 'POST' }
      );
      const json = await response.json();

      if (!response.ok) {
        setOutcome({
          kind: 'error',
          message:
            json?.error?.message ?? `Request failed (${response.status}).`,
        });
      } else {
        setOutcome({
          kind: 'queued',
          messageId: json?.data?.messageId ?? null,
        });
      }
    } catch (error) {
      setOutcome({
        kind: 'error',
        message:
          error instanceof Error
            ? `Could not reach the dashboard API (${error.name}).`
            : 'Could not reach the dashboard API.',
      });
    } finally {
      setSubmitting(false);
      // Revalidate either way. A failed retry can still have changed the row — the server
      // releases its claim only on a definite rejection, so on an ambiguous failure
      // `retriedAt` is now set and the table must show that.
      onRetried();
    }
  };

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) setOutcome({ kind: 'idle' });
  };

  if (blocked) {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <Button
          size="sm"
          variant="ghost"
          disabled
          aria-describedby={`retry-blocked-${row.id}`}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </Button>
        <span
          id={`retry-blocked-${row.id}`}
          className="max-w-[9rem] text-xs leading-tight text-muted-foreground"
        >
          {blocked}
        </span>
      </div>
    );
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        Retry
      </Button>

      <Dialog open={open} onOpenChange={close}>
        {/*
          [RELAY-107] This is the "DLQ retry confirm" dialog spec §4.1 names directly as a
          glass target. `components/ui/dialog.tsx`'s `DialogContent` now carries the glass
          treatment by default (light base + `dark:` override), but the `dark` class right
          here is self-applied to this same element rather than an ancestor, so Tailwind's
          `dark:` variant (a `.dark <sel>` descendant-combinator selector) never matches it
          — this dialog is deliberately always-dark regardless of the app's real theme
          (same convention as `DeliveryDetail.tsx` and the rest of `components/relay/**`),
          so the dark glass values are hardcoded here instead, overriding the shared
          default's light `bg-white/70`/`border-white/60` via tailwind-merge.
        */}
        <DialogContent className="dark sm:max-w-lg border-white/10 bg-[#191b20]/60">
          <DialogHeader>
            <DialogTitle>Re-send this webhook?</DialogTitle>
            <DialogDescription>
              This publishes the stored payload back to QStash, which will POST
              it to the route&apos;s destination. It cannot be undone, and Relay
              allows it once per item.
            </DialogDescription>
          </DialogHeader>

          <dl className="space-y-2 rounded-md border p-3 text-sm">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">Route</dt>
              <dd className="min-w-0 truncate font-medium">{row.route.name}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">
                Destination
              </dt>
              <dd className="min-w-0 break-all font-mono text-xs">
                {row.route.destination}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">
                Request ID
              </dt>
              <dd className="min-w-0 break-all font-mono text-xs">
                {row.requestId}
              </dd>
            </div>
          </dl>

          {/*
            [RELAY-65] Two distinct states, stated up front rather than discovered from a
            destination's rejection afterwards:
              - `headersRetained` false: a row written before headers were captured at all
                (pre-migration). Nothing to replay them from — same gap this warning
                described before RELAY-65, scoped now to just the old rows.
              - `headersRetained` true: the original headers — signature headers included —
                ride the replay. The residual risk is not "missing headers", it is TIME: a
                sender that binds its signature to a timestamp (Stripe defaults to a
                5-minute tolerance) can still reject a replay sent long after the original
                failure, headers and all.
          */}
          {row.headersRetained ? (
            <p className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                The original request headers are included in this replay,
                signature headers such as{' '}
                <code className="font-mono">stripe-signature</code> included.
                If the destination validates a signature timestamp against a
                tolerance window, a retry sent long after the original
                failure can still be rejected for being stale — that is a
                property of the destination&apos;s clock, not of what Relay
                sends.
              </span>
            </p>
          ) : (
            <p className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                This item predates header capture, so its original request
                headers were never stored and the replay is sent without
                them. If the destination verifies a signature header such as{' '}
                <code className="font-mono">stripe-signature</code>, it will
                reject this replay.
              </span>
            </p>
          )}

          {outcome.kind !== 'idle' && (
            // role="status" so the result is announced. The dialog stays open on both
            // paths: closing on success would hide the outcome from anyone who does not
            // catch a transient toast.
            <div
              role="status"
              className={
                outcome.kind === 'queued'
                  ? 'rounded-md border border-green-500/30 bg-green-500/5 p-3 text-sm text-green-300'
                  : 'rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300'
              }
            >
              {outcome.kind === 'queued' ? (
                <>
                  Queued with QStash
                  {outcome.messageId ? ` (${outcome.messageId})` : ''}. Delivery
                  is asynchronous — watch the delivery log for the result.
                </>
              ) : (
                outcome.message
              )}
            </div>
          )}

          <DialogFooter>
            {outcome.kind === 'queued' ? (
              <Button size="sm" onClick={() => close(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => close(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button size="sm" onClick={submit} disabled={submitting}>
                  {submitting && (
                    <Loader2
                      className="mr-1 h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  Re-send now
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
