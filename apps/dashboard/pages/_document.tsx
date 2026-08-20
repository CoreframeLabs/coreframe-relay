import { Head, Html, Main, NextScript } from 'next/document';

import env from '@/lib/env';

/**
 * [ui-revamp Phase 1] Two separate SSR theme problems are fixed here.
 *
 * 1. `data-theme="boxyhq"` used to be hardcoded on <Html>, and `"boxyhq"` is not a
 *    registered daisyUI theme (`tailwind.config.js`'s `daisyui.themes` only
 *    registers `['corporate', 'black']`) — so every SSR page load fell back to
 *    daisyUI's unstyled default until client JS hydrated and `lib/theme.ts`'s
 *    `applyTheme` corrected it. Per the design spec §4.4 the SSR default is now
 *    `corporate`, the real light theme, matching light being the app-wide default.
 *    No fake `boxyhq` theme is invented.
 *
 * 2. FOUC / flash of the wrong theme. `applyTheme` is client-only — it touches
 *    `document`, `localStorage` and `window.matchMedia`, so it cannot run during
 *    SSR, and `pages/_app.tsx` calls it from a `useEffect` that by definition runs
 *    AFTER first paint. On its own that means a user who chose dark (or whose OS
 *    prefers dark) gets one fully-painted light frame first. The standard fix, and
 *    the one used below, is a tiny synchronous script in <Head>: it runs before the
 *    browser paints anything, reads the same `localStorage` key and the same
 *    `prefers-color-scheme` query `applyTheme` uses, and sets the same `.dark`
 *    class and `data-theme` attribute. `applyTheme` in `_app.tsx` then re-applies
 *    the identical result post-hydration, which is a no-op rather than a correction.
 *
 *    Notes on why this is safe here:
 *    - It only ever ADDS dark. The SSR markup is already the light state, so when
 *      the resolved theme is light the script does nothing and there is nothing to
 *      mismatch. It mutates `documentElement` only, never anything React renders,
 *      so it cannot cause a hydration mismatch.
 *    - `middleware.ts`'s CSP allows `'unsafe-inline'` in `script-src`, so no nonce
 *      plumbing is needed. Checked, not assumed.
 *    - It is wrapped in try/catch: `localStorage` throws in some privacy modes, and
 *      a theme preference must never be able to break the page.
 *    - It is gated on `env.darkModeEnabled` (`NEXT_PUBLIC_DARK_MODE`, inlined at
 *      build time) so that with dark mode disabled the script is not emitted at all
 *      and the app stays light, matching `_app.tsx`'s existing gate.
 */

// Kept in sync by hand with `lib/theme.ts`'s `applyTheme`: same 'theme' storage
// key, same `prefers-color-scheme` query, same `.dark` class + `data-theme` pair.
const themeInitScript = `
(function(){try{
var t=localStorage.getItem('theme');
if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){
var e=document.documentElement;e.classList.add('dark');e.setAttribute('data-theme','black');
}}catch(e){}})();
`;

export default function Document() {
  return (
    <Html lang="en" className="h-full" data-theme="corporate">
      <Head>
        {env.darkModeEnabled && (
          <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        )}
      </Head>
      <body className="h-full">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
