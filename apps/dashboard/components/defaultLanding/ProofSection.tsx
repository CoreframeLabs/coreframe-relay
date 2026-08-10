/**
 * [RELAY-64 v2] Proof of receipt — the logo wall this page cannot have, replaced.
 *
 * Contract §3 (Proof): one full-width mono log line exactly as the API returns it,
 * with a working copy button, captioned by the receipt line. "The demo is the
 * testimonial": when the Saved Payloads counter leaves zero, this strip is the
 * proof it points at (until RELAY-68 wires the counter live, it stays honest-zero
 * and this row stays an example of the receipt's SHAPE, labelled as such).
 *
 * No invented customers, logos, metrics or testimonials (RELAY-55 + the contract's
 * anti-brief #2). The row below is a shape-of-data still: requestId, timestamp,
 * status and retry history in the format `DeliveryLog` returns, not a real event.
 */
import { useState } from 'react';

import { Section, SectionHeading, focusRing } from './LandingPrimitives';

const RECEIPT_LINE =
  'req_8f3e29c4 · 2026-08-10T11:42:07Z · POST /in/acme/orders · attempt 1→503 · 2→503 · 3→200 ✓ delivered';

const ProofSection = () => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(RECEIPT_LINE);
    } catch {
      // Clipboard API denied (e.g. permissions) — fall through silently; the line
      // stays selectable on the page, so no copy path is ever fully closed.
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Section id="proof">
      <SectionHeading
        eyebrow="Proof of receipt"
        title="The receipt Stripe's timeout never gives you."
        lede="This is the receipt Stripe's timeout never gives you. Sign up, fire one request, and this row is yours in under a minute."
      />

      <div className="relay-reveal mt-10">
        <figure className="overflow-hidden rounded-xl border border-teal-500/30 bg-[#191b20]/60">
          <div className="flex items-center justify-between gap-3 border-b border-[#24262c] bg-[#131518] px-4 py-2.5">
            <p className="font-mono text-[11px] uppercase tracking-wider text-zinc-500">
              Delivery log — one row, the shape of the data
            </p>
            <button
              type="button"
              onClick={copy}
              className={`rounded border border-[#24262c] px-2.5 py-1 font-mono text-[11px] text-[#9a9ea8] transition-colors hover:border-zinc-500 hover:text-[#f2f3f5] ${focusRing}`}
              aria-label="Copy the receipt line"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {/* Only the code pane scrolls internally at 360px — never the page. */}
          <div className="overflow-x-auto p-4">
            <code className="block whitespace-nowrap font-mono text-xs leading-6 text-zinc-300">
              <span className="text-teal-300">req_8f3e29c4</span>
              <span className="text-zinc-500"> · </span>2026-08-10T11:42:07Z
              <span className="text-zinc-500"> · POST /in/acme/orders · </span>
              <span className="text-amber-400">attempt 1→503</span>
              <span className="text-zinc-500"> · </span>
              <span className="text-amber-400">2→503</span>
              <span className="text-zinc-500"> · </span>
              <span className="text-emerald-400">3→200 ✓ delivered</span>
            </code>
          </div>
          <figcaption className="border-t border-[#24262c] px-4 py-3 text-xs leading-relaxed text-[#9a9ea8]">
            An example of the receipt&apos;s format, not a record of real traffic —
            the Saved Payloads counter above is still at its honest zero. The moment
            it moves, the strip links to it, which is a proof no logo wall ever is.
          </figcaption>
        </figure>
      </div>
    </Section>
  );
};

export default ProofSection;
