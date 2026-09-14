import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

/**
 * [director ask: the light-mode landing page is "too bland and blank canvas"]
 *
 * PLACEMENT DECISION — one `position: fixed`, viewport-sized layer at the page root,
 * behind every section, NOT scoped to the hero. Two reasons, and the first is the
 * decisive one:
 *
 *  1. The hero is the one part of this page that already has a visual (the radial
 *     teal glow plus `WebhookFlowVisual`'s Three.js arc). The blankness being
 *     complained about is everything BELOW it — Proof, What It Does, n8n, Security,
 *     Founding Access, all reading as dark text on flat #f7f8fa. A hero-scoped
 *     element would decorate the only fold that was never the problem.
 *
 *  2. `fixed` and not an absolutely-positioned full-page layer because this page is
 *     ~8000px tall: an absolute layer means a canvas that tall, and the drawing
 *     surface cost is O(page height) for something only one viewport of which is
 *     ever visible. Fixed keeps it O(viewport) forever. The scene compensates for
 *     the lack of scroll movement with a small parallax nudge (see
 *     `AmbientBackdropScene.tsx`) so it does not read as a sticker on the glass.
 *
 * It is behind the content, not in it: the landing sections that carry body copy sit
 * on opaque `--landing-bg-surface` cards, so the mesh shows through the gutters and
 * the page margins and never underneath a paragraph. The one place it does show
 * through text is the nav, which is `bg-landing-surface/70 backdrop-blur-md` — and
 * the blur is exactly what keeps it a wash there.
 *
 * TWO LAYERS, and the lower one is not optional:
 *
 *  - The CSS wash (`.relay-ambient-wash`, `globals.css`) is ALWAYS painted. It is
 *    three soft radial blooms, zero JS, zero motion. This is what a reduced-motion
 *    visitor, a no-WebGL browser and the pre-hydration first paint all get, and it
 *    answers "blank white canvas" on its own — the accessible path gets a real fix
 *    here, not an apology.
 *  - The Three.js mesh layers on top, `next/dynamic(..., { ssr: false })` so `three`
 *    stays in its own client chunk and out of `/`'s First Load JS, and only after a
 *    post-mount `prefers-reduced-motion` check comes back false. Same "safe default,
 *    JS upgrades it once it has confirmed that is OK" shape as
 *    `WebhookFlowVisual.tsx`, which also means server and client first render are
 *    byte-identical and there is no hydration mismatch to reason about.
 */
const AmbientBackdropScene = dynamic(() => import('./AmbientBackdropScene'), {
  ssr: false,
});

export default function AmbientBackdrop() {
  const [showScene, setShowScene] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (reduce?.matches) return;
    setShowScene(true);
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      <div className="relay-ambient-wash absolute inset-0" />
      {showScene && <AmbientBackdropScene />}
    </div>
  );
}
