/**
 * Tailwind 3 config — daisyUI (BoxyHQ's existing pages) and shadcn/ui (all new Relay
 * pages) side by side. See relay-boilerplate-integration.md Part 7: the migration is
 * progressive, so both plugins stay until every BoxyHQ page has been migrated.
 *
 * Tailwind is pinned at 3.x on purpose. daisyUI 4.12 does not support Tailwind 4, and the
 * shadcn v4 CLI assumes Tailwind 4 — hence the shadcn config here is written by hand
 * rather than generated. See [RELAY-1] in the dev log.
 */
module.exports = {
  mode: 'jit',
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
    'node_modules/daisyui/dist/**/*.js',
    'node_modules/react-daisyui/dist/**/*.js',
  ],
  // [RELAY-106 / ui-revamp Phase 3] `corporate` (light) and `black` (dark) are
  // daisyUI's stock theme names, kept as-is (see pages/_document.tsx and
  // lib/theme.ts, which hardcode these two theme names for the legacy BoxyHQ
  // pages under pages/{teams,settings,auth}/** and components/{account,team,
  // billing,apiKey,invitation}/**), but their colour KEYS below are retuned to
  // the §3.2 (light) / §3.3 (dark) token values in
  // growth/product/design-panel/ui-revamp-spec-2026-08-19.md — the same values
  // already live as the `--bg-*`/`--text-*`/`--accent` CSS custom properties in
  // styles/globals.css and the `landing-*` Tailwind colours above, so these
  // legacy pages stop looking like a different, unbranded product sitting next
  // to the Relay-specific surfaces in the same nav. Colour-swap only — no
  // structural change to daisyUI's theme schema or component classes.
  //
  // Key-name reference (daisyUI 4.12 theme schema, confirmed against
  // node_modules/daisyui/src/theming/themes.js — NOT the `--bg-*` names used
  // elsewhere in this file):
  //   primary/secondary/accent/neutral (+ `-content` = text-on-that-fill)
  //   base-100/200/300 (100 = lightest in light themes, darkest in dark themes;
  //     200/300 step AWAY from that extreme toward mid-grey either direction —
  //     matches daisyUI's own stock `black` theme, where 100→300 lightens) +
  //     base-content (body text)
  //   info/success/warning/error (+ `-content`) — solid fill colours for
  //     daisyUI's own alert/badge components, distinct from the light-mode
  //     tint/saturated-text pairing in components/relay/StatusBadge.tsx (§3.2),
  //     which is a separate Tailwind-class pattern, not a daisyUI theme key.
  //
  // Every `-content` pairing below was measured with a WCAG relative-luminance
  // contrast check (not assumed): all 22 fg/bg pairs across both themes clear
  // 4.5:1 (lowest measured: light success-content on success, 4.79:1). See the
  // commit that introduced this comment for the calculation.
  daisyui: {
    themes: [
      {
        corporate: {
          'color-scheme': 'light',
          primary: '#0d9488', // --accent (teal-600)
          'primary-content': '#04120f', // --accent-ink
          secondary: '#5b6472', // --text-secondary (muted slate, not a 2nd accent)
          'secondary-content': '#ffffff',
          accent: '#0f766e', // --accent-hover (teal-700) — same teal family as primary
          'accent-content': '#ffffff',
          neutral: '#14181f', // --text-primary
          'neutral-content': '#f7f8fa', // --bg-base
          'base-100': '#ffffff', // --bg-surface
          'base-200': '#f7f8fa', // --bg-base
          'base-300': '#eef0f3', // --bg-elevated
          'base-content': '#14181f', // --text-primary
          info: '#1d4ed8', // blue-700, matches §3.2 queued/info status text
          'info-content': '#eff6ff',
          success: '#15803d', // green-700, matches §3.2 success status text
          'success-content': '#f0fdf4',
          warning: '#b45309', // amber-700, matches §3.2 warning status text
          'warning-content': '#fffbeb',
          error: '#b91c1c', // red-700, matches §3.2 error status text
          'error-content': '#fef2f2',
        },
      },
      {
        black: {
          'color-scheme': 'dark',
          primary: '#2dd4bf', // --accent (teal-400)
          'primary-content': '#04120f', // --accent-ink
          secondary: '#9a9ea8', // --text-secondary
          'secondary-content': '#0d0f12',
          accent: '#5eead4', // --accent-hover (teal-300) — same teal family as primary
          'accent-content': '#04120f',
          neutral: '#22242b', // --bg-elevated
          'neutral-content': '#f2f3f5', // --text-primary
          'base-100': '#0d0f12', // --bg-base
          'base-200': '#191b20', // --bg-surface
          'base-300': '#22242b', // --bg-elevated
          'base-content': '#f2f3f5', // --text-primary
          info: '#60a5fa', // blue-400, dark-mode-appropriate saturated tone
          'info-content': '#04120f',
          success: '#4ade80', // green-400
          'success-content': '#04120f',
          warning: '#fbbf24', // amber-400
          'warning-content': '#04120f',
          error: '#f87171', // red-400
          'error-content': '#04120f',
        },
      },
    ],
  },
  theme: {
    extend: {
      // NOTE — no `fontFamily` key here, deliberately. [ui-revamp Phase 1] Until
      // this pass, `font-display` was applied to every landing heading (and one
      // billing heading) but was never defined in `theme.extend.fontFamily` and is
      // not a Tailwind built-in, so Tailwind silently dropped it: those headings
      // were already rendering in the `globals.css` system stack, and had been
      // since the class was introduced. Per spec §3.4 the dead class was removed
      // rather than backfilled with a real display face — the £0 constraint makes a
      // webfont optional, and removing it changes nothing visually while making
      // what actually renders match what the markup says. If a display face is ever
      // wanted, wire it via `next/font/google` (ships with Next, no new dependency)
      // and register it here; do not re-add a bare `font-display` class.
      // Landing page tokens — [ui-revamp Phase 1/4]. Resolves against the
      // `--landing-*` CSS variables in styles/globals.css (§3.2/§3.3 of
      // ui-revamp-spec-2026-08-19.md), toggled by the same `.dark` class as the
      // shadcn block below. Plain hex `var()` refs (not `hsl(var())`) since the
      // landing tokens are stored as hex, not HSL triplets.
      colors: {
        landing: {
          base: 'var(--landing-bg-base)',
          surface: 'var(--landing-bg-surface)',
          elevated: 'var(--landing-bg-elevated)',
          border: 'var(--landing-border)',
          primary: 'var(--landing-text-primary)',
          secondary: 'var(--landing-text-secondary)',
          muted: 'var(--landing-text-muted)',
          code: 'var(--landing-text-code)',
          // `accent` is the FILL value (button/chip backgrounds, dots, rules);
          // `accent-text` is the value safe to use as TEXT on the page's own
          // surfaces. They differ in light mode only, because a UI fill needs
          // 3:1 and text needs 4.5:1 — see the measured ratios in globals.css.
          accent: 'var(--landing-accent)',
          'accent-hover': 'var(--landing-accent-hover)',
          'accent-text': 'var(--landing-accent-text)',
          'accent-text-hover': 'var(--landing-accent-text-hover)',
          'accent-ink': 'var(--landing-accent-ink)',
        },
        // shadcn/ui — resolves against the CSS variables in styles/globals.css.
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('daisyui'),
    require('tailwindcss-animate'),
  ],
};
