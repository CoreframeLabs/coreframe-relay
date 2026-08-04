import { AlertTriangle } from 'lucide-react';

/**
 * Payload preview for a DLQ item. [RELAY-8], and the shape [RELAY-16] specifies.
 *
 * ─── The rule this component exists to enforce ────────────────────────────────────────
 *
 * **These bytes arrived from the public internet.** Anyone who can reach a team's relay
 * URL chooses them. Rendering them as HTML would let a sender execute script inside an
 * authenticated operator's dashboard session — the XSS vector named in Part 1 of the
 * engineering standards, and the reason [RELAY-16] exists as its own ticket.
 *
 * So: the body is placed in `{}` as a text child of a `<pre><code>`. React escapes text
 * children, which is the whole control. There is NO `dangerouslySetInnerHTML` in this
 * file, and adding one would defeat the only protection here. Nothing pretty-prints or
 * re-parses the body either — a payload that is not JSON must still be displayed, and a
 * `JSON.parse` here would either throw on it or, worse, silently show a re-encoded
 * version that is not what was received.
 *
 * ─── Truncation is stated, not hidden ─────────────────────────────────────────────────
 *
 * The API truncates server-side (`DLQ_PREVIEW_MAX_CHARS`) so a 64KB blob never crosses
 * the wire for a row nobody expanded. That means the preview can be a lie of omission
 * unless it says so, hence the explicit banner and the real byte count.
 *
 * NOTE: this component partially satisfies [RELAY-16], but that ticket's boxes stay
 * unticked — it requires a test that posts a payload containing a script tag and asserts
 * zero executable nodes in the DOM, which is not written here.
 */

/** Bytes rendered as a human size. `sizeB` is measured, never estimated. */
function formatBytes(sizeB: number): string {
  if (sizeB < 1024) return `${sizeB} B`;
  if (sizeB < 1024 * 1024) return `${(sizeB / 1024).toFixed(1)} KB`;
  return `${(sizeB / (1024 * 1024)).toFixed(2)} MB`;
}

export function DlqPayloadPreview({
  preview,
  payloadBytes,
  truncated,
  failReason,
}: {
  /** Null when nothing was retained. */
  preview: string | null;
  payloadBytes: number | null;
  truncated: boolean;
  failReason: string;
}) {
  if (preview === null) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
        <p className="flex items-center gap-2 text-sm font-medium text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          No payload was stored for this item
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          The body exceeded the 64KB inline limit and Relay has no object
          storage yet, so it was not retained. There is nothing to preview and
          nothing to retry — this item records that a webhook died, not what was
          in it.
        </p>
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {failReason}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Payload</span>
        {payloadBytes !== null && (
          <span className="font-mono">{formatBytes(payloadBytes)}</span>
        )}
        {truncated && (
          // Text, not a colour or an ellipsis. An operator reading a truncated payload
          // and believing it complete will debug the wrong thing.
          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-amber-300">
            TRUNCATED — showing the first 2,000 characters only
          </span>
        )}
      </div>
      <pre
        className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
        // A payload is content, not decoration, and it can be long: give it a region a
        // keyboard user can scroll and a screen reader can find.
        tabIndex={0}
        role="region"
        aria-label="Request payload, shown as plain text"
      >
        {/*
          The escaping boundary. `preview` is a string interpolated as a text child, which
          React escapes. Do not replace this with dangerouslySetInnerHTML for syntax
          highlighting or any other reason — see the note at the top of this file.
        */}
        <code>{preview}</code>
      </pre>
    </div>
  );
}
