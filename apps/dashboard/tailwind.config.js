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
  daisyui: {
    themes: ['corporate', 'black'],
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
