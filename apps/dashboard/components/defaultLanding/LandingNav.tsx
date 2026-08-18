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
 */
import Link from 'next/link';

import { LandingLink, focusRing } from './LandingPrimitives';

const navLinks = [
  { href: '#proof', label: 'Proof' },
  { href: '#what-it-does', label: 'What it does' },
  { href: '#security', label: 'Security' },
  { href: '#founding-access', label: 'Founding Access' },
];

const LandingNav = () => (
  /* Glass allowed on the sticky nav only (contract §5). */
  <header className="sticky top-0 z-20 border-b border-[#24262c]/80 bg-[#0d0f12]/90 backdrop-blur">
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
          className="h-5 w-1.5 shrink-0 rounded-full bg-teal-400"
        />
        <span className="font-display text-sm font-semibold tracking-tight text-[#f2f3f5]">
          Coreframe Relay
        </span>
      </Link>

      <ul className="ml-4 hidden items-center gap-6 lg:flex">
        {navLinks.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              className={`rounded text-sm text-[#9a9ea8] transition-colors hover:text-zinc-100 ${focusRing}`}
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>

      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <Link
          href="/auth/login"
          className={`rounded px-2 py-1 text-sm font-medium text-zinc-300 transition-colors hover:text-zinc-50 ${focusRing}`}
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

export default LandingNav;
