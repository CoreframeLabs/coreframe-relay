import {
  AnimatePresence,
  LazyMotion,
  domAnimation,
  m,
  useReducedMotion,
} from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * [RELAY-118] Route-level page transition — a short fade + slight vertical
 * settle (150-250ms neighbourhood, matching Linear/Vercel's own dashboard
 * transitions rather than a marketing-site flourish) played on the content
 * of the page being routed to.
 *
 * BUNDLE COST: `_app.tsx` wraps every route in this app, including the
 * public landing page (`pages/index.tsx`) whose entire job is a fast first
 * load for a visitor who has never heard of Relay — so whatever this file
 * imports is NOT something a route can opt out of or code-split away.
 * Measured with `next build` on this worktree: importing plain
 * `motion`/`AnimatePresence` from `framer-motion` added +40 kB to the
 * shared `_app` chunk (257 kB -> 297 kB) and, because that chunk is shared,
 * +40 kB First Load JS on every single route including `/` (354 kB -> 394
 * kB). Switching to `LazyMotion` + the `domAnimation` feature bundle + the
 * `m` component (this file) — which excludes the drag/pan/layout-animation
 * code this component never uses — measured at +28 kB shared / +28 kB on
 * `/` instead (257 kB -> 285 kB shared; 354 kB -> 382 kB on `/`; see the
 * RELAY-118 tracker entry for the exact `next build` output all three
 * ways). `AnimatePresence` itself is not part of `LazyMotion`'s
 * tree-shakeable feature set and is imported directly either way, which is
 * why the saving is a partial ~30% rather than dramatic. +28 kB gzip
 * shared across the whole app, landing page included, for a fade
 * transition is a real, deliberate cost, not a free feature — judged
 * acceptable here because it is a ONE-TIME shared-chunk cost the browser
 * caches across every later navigation, not something paid per-route. The
 * alternative considered, a CSS-only `key`-remount fade at zero JS cost,
 * was rejected for this ticket: it cannot cross-fade an exiting and
 * entering page without either a duplicated DOM pass or a flash of
 * unstyled gap between them. `strict` on `LazyMotion` below fails loudly
 * if a future edit reaches for `motion.*` instead of `m.*` inside this
 * boundary and quietly reintroduces the full +40 kB.
 *
 * WHERE THIS SITS (matters for both perf and correctness):
 * `pages/_app.tsx` wraps `<Component {...props} />` in this component and
 * passes the RESULT into `getLayout(...)` — so `AccountLayout`/`AppShell`
 * (sidebar, header, `SWRConfig`) and `AuthLayout` (centred card chrome) sit
 * OUTSIDE this wrapper, not inside it. React reconciles those layout
 * components by type+position and they carry no `key`, so they stay
 * mounted across a route change; only the inner page content this
 * component wraps actually unmounts/remounts. A data-dense tool people use
 * all day should not have its nav chrome flash on every click just because
 * the page under it changed — Linear and Vercel's own dashboards keep
 * chrome static and transition content only, and this follows that.
 *
 * `AnimatePresence`'s exit-tracking only inspects its own direct `children`
 * prop — it does not care how many non-keyed wrapper components (layouts)
 * end up between it and the app root once `getLayout` nests it. As long as
 * the `motion.div` below stays `AnimatePresence`'s immediate child, this
 * works correctly regardless of which layout a given page picks.
 *
 * REDIRECT SAFETY (the actual hard constraint this ticket exists for):
 * this component is a client-only leaf that renders AFTER Next.js has
 * already decided which page to render. A `getServerSideProps` redirect or
 * a `middleware.ts` redirect (see `middleware.ts`'s `unAuthenticatedRoutes`
 * gate) happens entirely on the server, before any HTML — let alone a
 * React component — reaches the browser; this file is never in that path
 * and cannot delay it. A client-side navigation into a page whose
 * `getServerSideProps` returns a `redirect` is resolved by Next's own
 * router before `_app` ever re-renders with a new `Component` — by the
 * time this component sees a route, the redirect (if any) has already
 * happened and `Component`/`routeKey` are already the FINAL destination.
 * `mode="wait"` only staggers the exit/enter of two already-resolved pages
 * against each other; it has no hook into, and cannot gate, a routing
 * decision. Verified for real against a live dev server, not just reasoned
 * through — see the RELAY-118 tracker entry for the exact repro.
 *
 * REDUCED MOTION: deliberately does NOT swap between "wrap in motion.div"
 * and "render children directly" based on `prefers-reduced-motion`. Doing
 * so would make the server-rendered HTML (which has no `window`, so always
 * assumes no preference) disagree with a reduced-motion client's very
 * first hydration pass, which is a real hydration-mismatch bug, not a
 * hypothetical one. Instead the DOM shape is IDENTICAL either way —
 * `motion.div` always renders — and reduced motion only zeroes out the
 * animation values themselves (`initial={false}`, no `exit`, `duration: 0`),
 * so a reduced-motion visitor sees an instant, un-animated swap rather than
 * a mismatched tree. Same "motion is additive, never load-bearing" contract
 * `Reveal.tsx` already established for the landing page.
 */
const TRANSITION = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as const };

export function PageTransition({
  routeKey,
  children,
}: {
  routeKey: string;
  children: ReactNode;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <LazyMotion features={domAnimation} strict>
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={routeKey}
          initial={shouldReduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={shouldReduceMotion ? undefined : { opacity: 0, y: -6 }}
          transition={shouldReduceMotion ? { duration: 0 } : TRANSITION}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </LazyMotion>
  );
}

export default PageTransition;
