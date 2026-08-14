/**
 * [RELAY-64 v2] Hero — the Promise as H1, contract §3.
 *
 * H1 is the panel's locked Promise — "Know which webhooks never arrived — and get
 * them back." — in the buyer's own verb ("arrived"); nobody repeats "Webhooks that
 * survive a slow endpoint" to a colleague. Subhead is the locked §3 sentence.
 *
 * Fixes carried over from the v1 → contract diff:
 *  - Contract bug #2: the "Phase 1 of 3" eyebrow pill is GONE — the designer's
 *    kill-order (anti-brief #4); it sold an unfinished fragment.
 *  - Contract bug #3 [now superseded]: the CTA pair used to be trial-mechanics-first,
 *    "Start the 14-day trial" with a card-up-front sub-line. `growth/product/
 *    relay-launch-sprint.md` §0 puts a paid, card-up-front, 14-day-trial launch at
 *    <5% achievable by 2026-08-19 — event metering, tier caps, retention reaping and
 *    the trial timer are sold on the old copy and none of the four exist as code. The
 *    primary CTA is now "Request Founding Access": free, no card, granted by hand.
 *    Both CTAs still route to real destinations — primary to /auth/join (RELAY-56:
 *    password email auth is what ships), secondary to a real mailto rather than the
 *    setup-call link that routed nowhere.
 *
 * Visual: the Gap (its own section file) — headline reads first, panes are proof.
 * The single decorative element is the one light source the panel kept: a soft
 * radial teal glow behind the headline at ~12% opacity, never a mesh gradient.
 */
import GapSection from './GapSection';
import { LandingLink, focusRing } from './LandingPrimitives';

const HeroSection = () => (
  <section className="relative overflow-hidden">
    {/* Decorative only; carries no meaning, so it is hidden from assistive tech. */}
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_60%_40%_at_50%_-10%,rgba(45,212,191,0.12),transparent_60%)]"
    />

    <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-14 sm:px-8 sm:pb-24 sm:pt-20">
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-5 inline-flex items-center rounded-full border border-[#24262c] bg-[#191b20] px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-zinc-400">
          <span className="text-teal-300">Relay: Buffer</span>
          <span aria-hidden="true" className="mx-2 text-zinc-700">
            /
          </span>
          <span>webhook receipt + retry</span>
        </p>

        <h1 className="text-balance font-display text-4xl font-semibold leading-[1.1] tracking-tight text-[#f2f3f5] sm:text-5xl lg:text-6xl">
          Know which webhooks{' '}
          <span className="text-teal-300">never arrived</span> — and get them
          back.
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-[#9a9ea8] sm:text-lg">
          Relay sits in front of your endpoint, counts every webhook the moment it
          lands, and re-sends the ones that fail — so a restart, a crash or a busy
          spell is never a silent loss.
        </p>

        {/* CTAs stack full-width at 360px (contract §5). */}
        <div className="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          <LandingLink href="/auth/join">Request Founding Access</LandingLink>
          <LandingLink href="mailto:umar.ali@coreframe-labs.dev" variant="secondary">
            Talk to us before you connect anything
          </LandingLink>
        </div>

        {/* [Launch-shape change] The cost/commitment answer now surfaces on the
            first screen rather than at the old Pricing section, fold 8. No card,
            nothing charged — the number that eventually applies (£99/mo) and what
            isn't built yet both live in the Founding Access section below. */}
        <p className="mx-auto mt-5 max-w-xl text-sm text-zinc-500">
          Free while we&apos;re onboarding the first teams — no card, nothing
          charged. Pricing lands at £99/mo once usage-based billing ships; what
          Founding Access doesn&apos;t include yet is{' '}
          <a
            href="#founding-access"
            className={`rounded text-zinc-300 underline decoration-zinc-600 underline-offset-4 transition-colors hover:text-zinc-100 ${focusRing}`}
          >
            written down further down this page
          </a>
          .
        </p>
      </div>

      <div className="mt-14 sm:mt-20">
        <GapSection />
      </div>
    </div>
  </section>
);

export default HeroSection;
