/**
 * [RELAY-64 v2, sequenced per director ask] The Gap — the contract §3 Hero visual,
 * plain-DOM take.
 *
 * Two terminal panes replay the same moment side by side, but as a SEQUENCE now,
 * not a simultaneous fade-in of two finished stills:
 *   1. Both request lines "type" in (CSS `clip-path` steps, no JS) — the same
 *      request firing into both worlds at once.
 *   2. Left ("Without Relay") falls silent — the pane's emptiness IS the design,
 *      so it ends on the buyer's own words in italic and nothing else.
 *   3. A small connector pill ("Relay") appears in the gap between the panes —
 *      the one moment the two panes are not independent: this is Relay stepping
 *      into the request's path. See the `Connector` component below for why this
 *      is a CSS pill and not a `framer-motion`/Three.js moment.
 *   4. Right ("With Relay") answers with the literal string from
 *      `apps/proxy/src/routes/ingest.ts` — `200 {"status":"queued","requestId":"…"}` —
 *      then an amber retry ladder climbs attempt 1→503 · 2→503 · 3→200 ✓ (emerald),
 *      one line at a time with a growing gap between attempts (450ms, then 550ms)
 *      so it reads as backoff, not a list rendering.
 *   5. The surviving `RelayFlowDiagram` terminal, nested inside the With pane,
 *      appears last — the sequence's conclusion once delivery has actually landed.
 *
 * All of it is driven by the SAME mechanism RELAY-116 already wired up — the
 * `.relay-reveal` → `RevealObserverMount` → `.relay-reveal-init`/`.relay-is-revealed`
 * classList contract in `Reveal.tsx` and `globals.css`. Nothing here adds a second
 * trigger: every timed element below is still just a `globals.css` rule keyed off
 * `.relay-reveal-init.relay-is-revealed <selector>`, so the whole sequence starts
 * exactly when the section scrolls into view, same as before.
 *
 * [gap-loop, director ask: "it should be continuous like a real computer, real calls
 * going and looped, this is too basic"] The sequence above no longer plays once and
 * freeze-frames — it is now a CONTINUOUS 11s cycle. Split deliberately in two:
 *
 *   TRAFFIC (loops forever): the request line retypes, the left pane falls silent
 *   again, the connector dot pulses, and the response + retry ladder reclimb —
 *   then all of it clears at 9s and the pane sits blank for ~1.4s before the next
 *   request lands. The blank beat is the point: it is what makes the restart read
 *   as "here comes the next call", not as a glitchy reset.
 *
 *   STRUCTURE (still plays once, `forwards`): the connector pill and the nested
 *   `RelayFlowDiagram` terminal. These are not traffic — the pill says "Relay is in
 *   this request's path" and the diagram is the conclusion of the argument. Fading a
 *   ~120px-tall terminal in and out every 11s in the reader's peripheral vision would
 *   be the distracting kind of motion, and it would also imply the topology itself is
 *   something that comes and goes. They appear once and stay.
 *
 * It stays pure CSS (`animation-iteration-count: infinite`, one keyframe set per
 * element with the whole cycle encoded as percentage stops — see the timeline table
 * in `globals.css`), so the loop costs zero new JS. The ONLY JS this file adds is the
 * pause guard below: `animation-play-state: paused` while the section is off-screen
 * or the tab is backgrounded, which is the same IntersectionObserver +
 * `visibilitychange` pair `WebhookFlowScene.tsx` uses for its rAF loop. An infinite
 * animation compositing forever behind a scrolled-past viewport is a real battery
 * cost, and it is exactly the cost a one-shot sequence never had.
 *
 * `prefers-reduced-motion: reduce` disables ALL of it wholesale, same contract as
 * always in this file: the hidden/typing/staggered states only exist as CSS rules
 * inside `@media (prefers-reduced-motion: no-preference)` in `globals.css`, so a
 * reduced-motion client never gets `.relay-reveal-init` added at all (see
 * `RevealObserverMount`) and renders every element in this component in its final,
 * fully-visible DOM state on first paint — no sequence to wait through, nothing to
 * skip, and CRITICALLY no loop to sit through either: a reduced-motion visitor gets
 * the single, static "after" frame, never a spinning cycle. Everything is
 * `clip-path`/`opacity` keyframes, the same idiom `RelayFlowDiagram`'s own wire
 * pulses already use on this page.
 *
 * [Launch-shape change] The "Saved Payloads: 0" counter that used to sit under the two
 * panes is CUT. The zero-customer confession only needs to appear once on the page (the
 * footer carries it now); repeating it here on top of Proof's caption and the old
 * duplicate Gap render was the same admission four times before a reader ever reaches the
 * CTA. The two terminal panes below are kept as-is — they are the strongest asset on the
 * page and carry no customer-count claim at all.
 *
 * [ui-revamp Phase 1/4] Deliberately NOT re-tokenized onto `--landing-*` (see
 * `LandingPrimitives.tsx`'s file header). These two panes simulate real terminal
 * output — prompt, status codes, syntax-coloured response — and stay a fixed dark
 * surface in both themes, same as a code block in a docs site. The rest of the page
 * (nav, hero copy, section cards, footer) is theme-aware; this demo unit is an
 * intentional dark island inside it, not an oversight. The connector pill between
 * the panes sits OUTSIDE that dark island — it's in the page's own gap/background,
 * not printed onto a terminal — so it deliberately reuses the theme-aware
 * `--landing-*` tokens `RelayFlowDiagram`'s own accent `Node` already uses, rather
 * than a fixed hex colour, and needs verifying in both themes for exactly that reason.
 */
import { useEffect, useRef, type ReactNode } from 'react';

import RelayFlowDiagram from './RelayFlowDiagram';

/**
 * The "connection moment" — deliberate choice of a CSS-only pill + pulsing dot,
 * not `framer-motion` and not the `WebhookFlowScene` Three.js setup, even though
 * both are already real dependencies loaded elsewhere on this same page (hero +
 * `PageTransition`'s `_app`-level wrapper).
 *
 * Three.js: `WebhookFlowScene.tsx`'s own header is explicit that it exists for
 * the hero's open canvas space and draws travelling points along a curve — a
 * register built for an ambient background accent behind large hero text. This
 * is the opposite context: a compact, text-dense terminal comparison where the
 * "connection" is a single beat between two 300px-tall panes, not a scene. A
 * WebGL canvas here would mean a second `next/dynamic` chunk, a second
 * IntersectionObserver-gated rAF loop, and a second reduced-motion/no-WebGL
 * fallback path — real, recurring cost — to draw something a seven-line CSS
 * pill says just as clearly. Reaching for it here would be "more animation
 * because the tool exists," which is exactly what this ticket asked NOT to do.
 *
 * `framer-motion`: `PageTransition.tsx` already pays framer-motion's `LazyMotion`
 * + `domAnimation` cost once, in the shared `_app` chunk, on every route including
 * this one — so reaching for `m.div` here would not add new *bytes*, but it would
 * add a second, independent animation trigger (framer-motion's own mount/variant
 * lifecycle) sitting next to the CSS-driven `.relay-reveal-init` sequence the rest
 * of this file uses, for a single fade-and-pulse a `<span>` and two keyframes
 * already do. That's a maintenance/consistency cost even at zero KB, and this file
 * already has exactly one motion mechanism (`globals.css` + `RevealObserverMount`)
 * driving every other timed element in this sequence — the connector should be
 * one more rule in that mechanism, not a second one bolted on beside it.
 *
 * So: a `<span>` pill, `opacity`/`transform` only, timed by the same
 * `.relay-gap-*` `animation-delay` convention as everything else here, gated by
 * the same reduced-motion contract. Zero new imports, zero new bytes.
 */
const Connector = () => (
  <div
    aria-hidden="true"
    className="relay-gap-connector pointer-events-none z-10 flex items-center justify-center py-1 lg:absolute lg:inset-y-0 lg:left-1/2 lg:col-start-1 lg:col-span-2 lg:row-start-1 lg:-translate-x-1/2 lg:py-0"
  >
    <span className="relay-gap-connector-inner inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-landing-border bg-landing-surface px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-landing-accent-text shadow-sm">
      <span className="relay-gap-connector-dot h-1.5 w-1.5 rounded-full bg-landing-accent" />
      Relay
    </span>
  </div>
);

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
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 rounded-full bg-zinc-700"
      />
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 rounded-full bg-zinc-700"
      />
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 rounded-full bg-zinc-700"
      />
      <p className="ml-2 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
        {label}
      </p>
    </div>
    <div className="p-4 sm:p-5">{children}</div>
  </div>
);

/**
 * Adds/removes `relay-gap-paused` (→ `animation-play-state: paused` in
 * `globals.css`) on the replay container while it is off-screen or the tab is
 * backgrounded. Same IntersectionObserver + `visibilitychange` pair
 * `WebhookFlowScene.tsx` gates its rAF loop with — an always-on CSS animation has
 * the same "costs the machine something forever" problem a rAF loop does.
 *
 * The two signals are tracked as SEPARATE booleans rather than folded into one
 * mutable `running` flag. Folding them latches: `running = !document.hidden &&
 * running` can only ever drive the flag to false, so once a tab is backgrounded the
 * animation never resumes until the observer happens to fire again. Keeping them
 * separate and re-deriving `paused` from both is what makes un-backgrounding work.
 */
function usePauseWhenUnseen(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    let onScreen = true;
    const apply = () =>
      el.classList.toggle('relay-gap-paused', !onScreen || document.hidden);

    const io = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        apply();
      },
      { threshold: 0 }
    );
    io.observe(el);

    document.addEventListener('visibilitychange', apply);

    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', apply);
      // Never leave the class behind: a paused-forever replay would be a worse
      // frozen frame than the one-shot version this replaced.
      el.classList.remove('relay-gap-paused');
    };
  }, [ref]);
}

const GapSection = () => {
  const replayRef = useRef<HTMLDivElement>(null);
  usePauseWhenUnseen(replayRef);

  // `relay-gap-request` drives the typewriter reveal (CSS `clip-path` steps in
  // `globals.css`) — both panes render this exact same node, so both request
  // lines type in lock-step: the story is one request, two outcomes, and the
  // divergence has to start only once the request has actually "landed".
  const requestLine = (
    <pre className="relay-gap-request whitespace-pre-wrap break-all font-mono text-xs leading-6 text-zinc-300">
      <span className="text-zinc-500">$</span> POST /webhooks/stripe{' '}
      <span className="text-zinc-500"># the lead your endpoint never saw</span>
    </pre>
  );

  return (
    <div>
      <div
        ref={replayRef}
        className="relay-reveal relative grid gap-4 lg:grid-cols-2 lg:gap-10"
      >
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

        {/* The connection moment — see `Connector`'s own header comment for why
            this is a CSS pill and not framer-motion/Three.js. Lives between the
            two `Pane`s in DOM order: on mobile (single column) it renders as a
            normal stacked row; at `lg:` it's pulled out of flow and centred in
            the gap between the two columns via `Connector`'s own responsive
            classes, same "stack below `lg`, bridge the gap at `lg`" shape
            `RelayFlowDiagram`'s own `Wire` component already uses. */}
        <Connector />

        <Pane label="With Relay" className="relay-gap-right">
          {requestLine}
          <pre className="relay-gap-response mt-4 whitespace-pre-wrap break-all font-mono text-xs leading-6">
            <span className="text-emerald-400">200</span>{' '}
            <span className="text-zinc-300">
              {'{"status":"queued","requestId":"req_8f3e"}'}
            </span>
          </pre>
          <ol className="mt-4 space-y-1 font-mono text-xs leading-6">
            <li className="relay-gap-retry-1 text-amber-400">
              attempt 1 → 503{' '}
              <span className="text-zinc-500">· retry queued</span>
            </li>
            <li className="relay-gap-retry-2 text-amber-400">
              attempt 2 → 503{' '}
              <span className="text-zinc-500">· retry queued</span>
            </li>
            <li className="relay-gap-retry-3 text-emerald-400">
              attempt 3 → 200 ✓{' '}
              <span className="text-zinc-500">· delivered</span>
            </li>
          </ol>

          {/* The surviving relay-flow terminal, nested inside the With pane —
              the sequence's conclusion, so it's the last thing to appear. */}
          <div className="relay-gap-diagram mt-5 overflow-x-auto rounded-lg border border-[#24262c] bg-[#0d0f12] p-4">
            <RelayFlowDiagram bare />
          </div>
        </Pane>
      </div>

      {/* [ux-walkthrough 2026-09-15, finding 4] A persona walkthrough flagged that this
          replay loops forever with no "this is an example" label, while ProofSection's
          receipt strip directly below it — the same fabricated-request-ID/status-code
          idiom — does carry one (`An example of the receipt's format, not a record of
          real traffic.`). Read together, an unlabelled loop next to a labelled one-shot
          reads as an inconsistency in the footer's own "no invented numbers" claim, even
          though the loop was never meant to imply a live feed. Same wording pattern as
          ProofSection's figcaption, same `text-landing-muted` token this page already
          uses for its captions elsewhere. */}
      <p className="relay-reveal mt-4 text-center text-xs text-landing-muted">
        A replayed example of the request/retry shape, not a live feed.
      </p>
    </div>
  );
};

export default GapSection;
