import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { StatusBadge, type BadgeState } from './StatusBadge';
import type { DeliveryRow } from './DeliveryStream';
import { fmtBytes, fmtDateTime, fmtLatency } from './DeliveryTable';

/**
 * Request detail panel — relay-ui-ux-spec.md §3.3. [RELAY-7]
 *
 * ── ON RELAY-16, WHICH OVERLAPS THIS FILE ──────────────────────────────────────────────
 *
 * There is no payload preview here, and that is a property of the schema rather than a
 * decision: `DeliveryLog` stores `payloadSizeB` and no body ([RELAY-2]). Bodies live on
 * `DlqItem`, which belongs to [RELAY-8]. So nothing on this page renders attacker-supplied
 * content, and **RELAY-16 is neither satisfied nor advanced by this ticket** — its boxes
 * stay unticked. The size is shown instead, which is the useful half of the question
 * ("did we receive what they think they sent?") without the half that carries the risk.
 *
 * Everything below is rendered as text through JSX. No `dangerouslySetInnerHTML` anywhere
 * on this page, including the source IP, which is the one field on the row that an
 * untrusted party has any influence over.
 */

const Field = ({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-2">
    <dt className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
      {label}
    </dt>
    <dd
      className={cn(
        'min-w-0 truncate text-right text-sm',
        mono && 'font-mono text-xs'
      )}
    >
      {children}
    </dd>
  </div>
);

export function DeliveryDetail({
  row,
  onClose,
}: {
  row: DeliveryRow | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay />
        {/*
          Composed from the Radix primitive rather than the `DialogContent` wrapper.

          That wrapper is a CENTRED modal: `left-[50%] translate-x-[-50%]` plus
          `slide-in-from-left-1/2` and `zoom-in-95`. Overriding it into a right-hand drawer
          by appending classes does not work and was seen not to work — `slide-in-from-right`
          and `slide-in-from-left-1/2` are different utilities, so tailwind-merge keeps BOTH
          and the enter animation still drags the panel in from the centre-left, leaving it
          hanging off the right edge of the viewport mid-flight.

          `components/ui/dialog.tsx` carries hand edits for the react-i18next/Radix children
          conflict ([RELAY-19]) and must not be regenerated or reshaped for one page's
          benefit, so the composition lives here instead. `@radix-ui/react-dialog` is already
          a direct dependency; this adds no package.
        */}
        <DialogPrimitive.Content
          // §3.3 asks for a drawer from the right rather than a centred modal: the operator
          // is reading a list and comparing rows, and a modal in the middle of the screen
          // covers the thing they are comparing against.
          className="dark fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l bg-background p-6 text-foreground shadow-lg duration-200 data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
        >
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
            <X className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>

          <div className="flex flex-col space-y-1.5 text-left">
            <DialogPrimitive.Title className="text-lg font-semibold leading-none tracking-tight">
              Request detail
            </DialogPrimitive.Title>
            {/*
              Radix warns to the console when a Content has no Description. It is also the
              accessible summary a screen reader reads on open, so it is not decoration.
            */}
            <DialogPrimitive.Description className="text-sm text-muted-foreground">
              One delivery attempt chain, as recorded by the consumer.
            </DialogPrimitive.Description>
          </div>

          {row && (
            <dl className="mt-2">
              <Field label="Status">
                <div className="flex items-center justify-end gap-1.5">
                  <StatusBadge state={row.status as BadgeState} />
                  {row.isTest && <StatusBadge state="TEST" />}
                </div>
              </Field>
              {row.isTest && (
                <Field label="Origin">
                  Test webhook (button) — synthetic
                </Field>
              )}
              {/*
              Not `CopyableUrl`: its aria-label is hard-coded to "Copy relay URL …", which
              would announce a request id as a URL. That component is outside this ticket's
              file boundary, so the label could not be parameterised — a plain selectable
              code element is honest instead of a button that lies to a screen reader.
            */}
              <Field label="Request ID" mono>
                <code className="select-all break-all">{row.requestId}</code>
              </Field>
              <Field label="Route">
                {row.route.name}
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  /{row.route.slug}
                </span>
              </Field>
              <Field label="Attempts" mono>
                {row.attemptCount}
              </Field>
              <Field label="Response code" mono>
                {row.responseCode ?? '—'}
              </Field>
              <Field label="Latency" mono>
                {fmtLatency(row.latencyMs)}
              </Field>
              <Field label="Payload size" mono>
                {fmtBytes(row.payloadSizeB)}
              </Field>
              <Field label="Source IP" mono>
                {row.sourceIp ?? '—'}
              </Field>
              <Field label="Received" mono>
                {fmtDateTime(row.createdAt)}
              </Field>
              <Field label="Delivered" mono>
                {fmtDateTime(row.deliveredAt)}
              </Field>
            </dl>
          )}

          <p className="mt-4 text-xs text-muted-foreground">
            Request and response bodies are not stored against delivery rows —
            only their size. A permanently failed payload is retained on its DLQ
            item instead.
          </p>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
