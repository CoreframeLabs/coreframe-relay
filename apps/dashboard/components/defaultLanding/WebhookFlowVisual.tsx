import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

/**
 * [director ask, landing-page visual — split from RELAY-118's motion work]
 *
 * Public entry point for the hero's Three.js accent. `HeroSection.tsx` is
 * the only caller, and this component is landing-only by construction —
 * nothing under `pages/teams/**`/`pages/settings/**`/`pages/auth/**` (or
 * any other authenticated route) imports it. See `WebhookFlowScene.tsx`'s
 * header for what it actually draws and why.
 *
 * LAZY-LOADING: `next/dynamic(..., { ssr: false })` means the ~150 kB
 * (uncompressed) `three` module is in its own chunk, fetched only after
 * this component mounts on the client — it is never part of the server
 * HTML, never part of `/`'s own "First Load JS" figure in `next build`'s
 * report, and never blocks first paint or the hero's text/CTAs from
 * rendering and becoming interactive. See the RELAY-118 tracker entry for
 * the measured per-chunk size and confirmation `/`'s reported First Load
 * JS is unchanged by this file's presence.
 *
 * REDUCED MOTION: the *default* render — server, and the client's first
 * paint before this component's own effect has had a chance to run — is
 * the static fallback below, never the animated scene. Only after mount,
 * once `matchMedia('(prefers-reduced-motion: reduce)')` is checked and
 * found false, does state flip to mount the dynamic scene. This is the
 * same "safe default, JS upgrades it after confirming it's safe to" shape
 * `Reveal.tsx` already established for the landing page's scroll-reveal —
 * and it is also what keeps server and client markup identical on first
 * render (both always render the plain fallback `<div>`), so there is no
 * hydration mismatch to reason about here: the dynamic scene only ever
 * appears from a POST-hydration state update, never from the initial
 * render itself.
 */
const WebhookFlowScene = dynamic(() => import('./WebhookFlowScene'), {
  ssr: false,
});

export default function WebhookFlowVisual() {
  const [showScene, setShowScene] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (reduce?.matches) return;
    setShowScene(true);
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden opacity-70"
    >
      {/* Static fallback: the same path-and-packets idea as the animated
          scene, held still. Rendered until (and unless) the dynamic Three.js
          scene takes over — reduced-motion visitors, browsers without
          WebGL, and the pre-hydration/pre-effect instant all see this and
          nothing more. Hidden (not unmounted — no need to pay for it twice)
          once the scene is showing, rather than left underneath it. */}
      <svg
        viewBox="0 0 400 160"
        preserveAspectRatio="xMidYMid meet"
        className={`h-full w-full ${showScene ? 'invisible' : ''}`}
      >
        <path
          d="M 20 110 C 90 20, 160 150, 230 60 S 340 20, 380 90"
          fill="none"
          stroke="#2dd4bf"
          strokeWidth="1"
          strokeOpacity="0.18"
        />
        <circle cx="90" cy="55" r="3" fill="#5eead4" fillOpacity="0.7" />
        <circle cx="230" cy="60" r="3" fill="#5eead4" fillOpacity="0.7" />
        <circle cx="330" cy="45" r="3" fill="#5eead4" fillOpacity="0.7" />
      </svg>
      {showScene && (
        <div className="absolute inset-0">
          <WebhookFlowScene />
        </div>
      )}
    </div>
  );
}
