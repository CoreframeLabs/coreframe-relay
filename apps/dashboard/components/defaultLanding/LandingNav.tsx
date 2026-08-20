/**
 * [RELAY-64 v2] Public landing navigation.
 *
 * [D7 claims-vs-code audit fix] "How it works" → `#how-it-works` was a dead in-page
 * anchor: rendered SSR HTML has no element with that id anywhere on the page. The
 * standalone how-it-works section this once pointed at was folded into the Gap
 * (`RelayFlowDiagram` rendered `bare` inside `GapSection`, itself nested inside
 * `HeroSection` with no id of its own) back when LimitsSection/RoadmapSection were cut.
 * Removed rather than re-added, since re-introducing a real target section is new scope
 * this gate day doesn't call for — a nav link to nowhere is worse than one fewer link.
 *
 * [ui-revamp Phase 1/4] Tokenized onto `--landing-*` (see `LandingPrimitives.tsx`'s file
 * header) and gained a visible theme toggle — `applyTheme` already existed app-wide
 * (`lib/theme.ts`, driven from `components/shared/shell/Header.tsx`) but the landing page
 * had no control reachable from it, so a first-time visitor who never touches the
 * dashboard had no way to actually switch. The `bg-[#0d0f12]/90 backdrop-blur` sticky-nav
 * treatment already here predates this pass and is kept as-is (recoloured onto the token),
 * not a new glass treatment — the spec explicitly names this nav as glass's one
 * already-approved use, and the "no glassmorphism yet" instruction is about NOT extending
 * it to modals/header/hero pills, not about removing what already shipped.
 *
 * The toggle reads the RESOLVED theme (the `.dark` class actually on `<html>`) rather than
 * `hooks/useTheme`'s stored preference. That hook models three states — 'light', 'dark'
 * and 'system' — and reports a null/'system' preference as not-dark, which is wrong here:
 * a first-time visitor whose OS prefers dark has no stored preference, so the hook would
 * render a "switch to dark" moon on an already-dark page, and its `toggleTheme` would then
 * apply dark again — a control that visibly does nothing on first click. `lib/theme.ts`
 * has already collapsed 'system' onto a concrete `.dark`-or-not by the time this paints
 * (`pages/_document.tsx`'s pre-paint script, then `pages/_app.tsx`), so reading the class
 * gives the state the visitor can actually see. The dashboard header keeps using the hook;
 * this is a landing-page-local read, not a change to the shared mechanism.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { MoonIcon, SunIcon } from '@heroicons/react/24/outline';

import { applyTheme } from '@/lib/theme';
import env from '@/lib/env';
import { LandingLink, focusRing } from './LandingPrimitives';

const navLinks = [
  { href: '#proof', label: 'Proof' },
  { href: '#what-it-does', label: 'What it does' },
  { href: '#security', label: 'Security' },
  { href: '#founding-access', label: 'Founding Access' },
];

const LandingNav = () => {
  // Starts false so the server render and the first client render agree (the SSR
  // markup is the light state either way — see `pages/_document.tsx`); the effect
  // then reconciles to whatever the pre-paint script resolved. Deliberately not
  // read during render: touching `document` there would break SSR outright.
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggleTheme = () => {
    applyTheme(isDark ? 'light' : 'dark');
    setIsDark(!isDark);
  };

  return (
    <header className="sticky top-0 z-20 border-b border-landing-border/80 bg-landing-base/90 backdrop-blur">
      <nav
        aria-label="Primary"
        className="mx-auto flex w-full max-w-6xl items-center gap-4 px-5 py-3 sm:px-8"
      >
        <Link
          href="/"
          className={`flex items-center gap-2 rounded ${focusRing}`}
          aria-label="Coreframe Relay home"
        >
          <span
            aria-hidden="true"
            className="h-5 w-1.5 shrink-0 rounded-full bg-landing-accent"
          />
          <span className="text-sm font-semibold tracking-tight text-landing-primary">
            Coreframe Relay
          </span>
        </Link>

        <ul className="ml-4 hidden items-center gap-6 lg:flex">
          {navLinks.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {env.darkModeEnabled && (
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
              className={`rounded p-1.5 text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
            >
              {isDark ? (
                <SunIcon className="h-5 w-5" aria-hidden="true" />
              ) : (
                <MoonIcon className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          )}
          <Link
            href="/auth/login"
            className={`rounded px-2 py-1 text-sm font-medium text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
          >
            Sign in
          </Link>
          <LandingLink href="/auth/join" className="!px-4 !py-2">
            Request Founding Access
          </LandingLink>
        </div>
      </nav>
    </header>
  );
};

export default LandingNav;
