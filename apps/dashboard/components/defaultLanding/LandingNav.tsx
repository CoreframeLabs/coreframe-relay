/** [RELAY-64] Public landing navigation. */
import Link from 'next/link';

import { LandingLink, focusRing } from './LandingPrimitives';

const navLinks = [
  { href: '#how-it-works', label: 'How it works' },
  { href: '#what-it-does', label: 'What it does' },
  { href: '#limits', label: 'Limits' },
  { href: '#roadmap', label: 'Roadmap' },
];

const LandingNav = () => (
  <header className="sticky top-0 z-20 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
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
          className="h-5 w-1.5 shrink-0 rounded-full bg-violet-500"
        />
        <span className="text-sm font-semibold tracking-tight text-zinc-50">
          Coreframe Relay
        </span>
      </Link>

      <ul className="ml-4 hidden items-center gap-6 lg:flex">
        {navLinks.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              className={`rounded text-sm text-zinc-400 transition-colors hover:text-zinc-100 ${focusRing}`}
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
          Create account
        </LandingLink>
      </div>
    </nav>
  </header>
);

export default LandingNav;
