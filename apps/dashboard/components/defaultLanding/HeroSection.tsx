/**
 * [RELAY-64] Hero.
 *
 * Sells **Buffer** — webhook receipt, retry and delivery — and nothing else. Per
 * RELAY-55 this page must not sell agent containment: Gate and Shield appear only in
 * `RoadmapSection`, labelled as unbuilt. There are no metrics here on purpose; the ones
 * that exist were measured against a local endpoint and do not describe a hosted service.
 */
import { LandingLink } from './LandingPrimitives';
import RelayFlowDiagram from './RelayFlowDiagram';

const HeroSection = () => (
  <section id="how-it-works" className="relative scroll-mt-16 overflow-hidden">
    {/* Decorative only; carries no meaning, so it is hidden from assistive tech. */}
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-violet-600/10 to-transparent"
    />

    <div className="relative mx-auto w-full max-w-6xl px-5 pb-16 pt-14 sm:px-8 sm:pb-24 sm:pt-20">
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-5 inline-flex flex-wrap items-center justify-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-zinc-400">
          <span className="text-violet-300">Relay: Buffer</span>
          <span aria-hidden="true" className="text-zinc-700">
            /
          </span>
          <span>Phase 1 of 3</span>
        </p>

        <h1 className="text-balance text-4xl font-semibold leading-[1.1] tracking-tight text-zinc-50 sm:text-5xl lg:text-6xl">
          Webhooks that survive a slow endpoint.
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-pretty text-base leading-relaxed text-zinc-400 sm:text-lg">
          Fast senders give your server a few seconds. A legacy CRM can take
          longer than that. Relay accepts the request at the edge, answers
          straight away, then keeps delivering to your endpoint — with backoff
          and an idempotency key — until it actually lands.
        </p>

        <div className="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          <LandingLink href="/auth/join">Create an account</LandingLink>
          <LandingLink href="/auth/login" variant="secondary">
            Sign in
          </LandingLink>
        </div>

        <p className="mx-auto mt-5 max-w-xl text-sm text-zinc-500">
          No billing is switched on, so there is nothing to pay and no card to
          enter. What Relay cannot do yet is{' '}
          <a
            href="#limits"
            className="rounded text-zinc-300 underline decoration-zinc-600 underline-offset-4 transition-colors hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          >
            written down further down this page
          </a>
          .
        </p>
      </div>

      <div className="mt-14 sm:mt-20">
        <RelayFlowDiagram />
      </div>
    </div>
  </section>
);

export default HeroSection;
