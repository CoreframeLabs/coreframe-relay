/**
 * [RELAY-64 v2] The Gap — the contract §3 Hero visual, plain-DOM take.
 *
 * Two terminal panes replay the same moment side by side. Left ("Without Relay"):
 * the request fires and the pane falls silent — the left pane's emptiness IS the
 * design, so it ends on the buyer's own words in italic and nothing else. Right
 * ("With Relay"): the same request returns the literal string from
 * `apps/proxy/src/routes/ingest.ts` — `200 {"status":"queued","requestId":"…"}` —
 * then an amber retry ladder climbs attempt 1→503 · 2→503 · 3→200 ✓ (emerald),
 * with the surviving `RelayFlowDiagram` terminal nested inside the With pane.
 *
 * [Launch-shape change] The "Saved Payloads: 0" counter that used to sit under the two
 * panes is CUT. The zero-customer confession only needs to appear once on the page (the
 * footer carries it now); repeating it here on top of Proof's caption and the old
 * duplicate Gap render was the same admission four times before a reader ever reaches the
 * CTA. The two terminal panes below are kept as-is — they are the strongest asset on the
 * page and carry no customer-count claim at all.
 *
 * Motion is contract motion #3: one un-staggered two-pane replay, CSS keyframes on
 * opacity only. `prefers-reduced-motion: reduce` disables it wholesale — both panes
 * render as static before/after stills, nothing is ever hidden behind an animation.
 *
 * [ui-revamp Phase 1/4] Deliberately NOT re-tokenized onto `--landing-*` (see
 * `LandingPrimitives.tsx`'s file header). These two panes simulate real terminal
 * output — prompt, status codes, syntax-coloured response — and stay a fixed dark
 * surface in both themes, same as a code block in a docs site. The rest of the page
 * (nav, hero copy, section cards, footer) is theme-aware; this demo unit is an
 * intentional dark island inside it, not an oversight.
 */
import type { ReactNode } from 'react';

import RelayFlowDiagram from './RelayFlowDiagram';

/** Terminal chrome: three dots + pane label. Purely decorative scaffolding. */
const Pane = ({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) => (
  /* [ui-revamp Phase 1/4] The surface is OPAQUE `bg-[#191b20]`, not the `/60` it
     used to carry. While the whole page was dark, 60% over a #0d0f12 base still
     composited to a dark surface; over the light base it composites to ~#727377,
     and the `text-zinc-300` code on it measures 3.20:1 — below AA. Opaque, the
     same text measures 11.66:1 and the pane reads as the fixed dark terminal it
     is meant to be in both themes. Alpha is what broke the dark-island intent. */
  <div
    className={`overflow-hidden rounded-xl border border-[#24262c] bg-[#191b20] ${className}`}
  >
    <div className="flex items-center gap-2 border-b border-[#24262c] bg-[#131518] px-4 py-2.5">
      <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
      <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
      <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
      <p className="ml-2 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
        {label}
      </p>
    </div>
    <div className="p-4 sm:p-5">{children}</div>
  </div>
);

const GapSection = () => {
  const requestLine = (
    <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-6 text-zinc-300">
      <span className="text-zinc-500">$</span> POST /webhooks/stripe{' '}
      <span className="text-zinc-500"># the lead your endpoint never saw</span>
    </pre>
  );

  return (
    <div>
      <div className="relay-reveal grid gap-4 lg:grid-cols-2">
        <Pane label="Without Relay" className="relay-gap-left">
          {requestLine}
          <div className="mt-4 min-h-[5.5rem] rounded-lg border border-dashed border-zinc-800 bg-[#0d0f12] p-4">
            {/* The empty beat is the design. Only the buyer's words break it. */}
            <p className="relay-gap-silence font-mono text-xs italic leading-6 text-zinc-500">
              … no error, no queue, no trace. The event is gone and nothing on
              your side ever knew it existed.
            </p>
          </div>
        </Pane>

        <Pane label="With Relay" className="relay-gap-right">
          {requestLine}
          <pre className="mt-4 whitespace-pre-wrap break-all font-mono text-xs leading-6">
            <span className="text-emerald-400">200</span>{' '}
            <span className="text-zinc-300">
              {'{"status":"queued","requestId":"req_8f3e"}'}
            </span>
          </pre>
          <ol className="mt-4 space-y-1 font-mono text-xs leading-6">
            <li className="text-amber-400">
              attempt 1 → 503 <span className="text-zinc-500">· retry queued</span>
            </li>
            <li className="text-amber-400">
              attempt 2 → 503 <span className="text-zinc-500">· retry queued</span>
            </li>
            <li className="text-emerald-400">
              attempt 3 → 200 ✓ <span className="text-zinc-500">· delivered</span>
            </li>
          </ol>

          {/* The surviving relay-flow terminal, nested inside the With pane. */}
          <div className="mt-5 overflow-x-auto rounded-lg border border-[#24262c] bg-[#0d0f12] p-4">
            <RelayFlowDiagram bare />
          </div>
        </Pane>
      </div>
    </div>
  );
};

export default GapSection;
