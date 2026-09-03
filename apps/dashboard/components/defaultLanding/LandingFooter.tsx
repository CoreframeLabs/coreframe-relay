/**
 * [RELAY-64 v2] Footer — the reproducibility line and the anchors.
 *
 * [design-overhaul 2026-08] The standalone mono tagline this footer used to open with —
 * "not a dashboard. a receipt." rendered cold, with no antecedent — is cut per direct
 * feedback: it read as a non-sequitur slogan dropped at the bottom of the page with
 * nothing above it setting up the dashboard/receipt contrast. The concept itself is real
 * and already earned elsewhere on the page (ProofSection's "Proof of receipt" /
 * "the receipt Stripe's timeout never gives you"), so rather than deleting it outright it
 * is folded into a full sentence here that states what it actually means — you get a
 * record of what happened, not a surface to babysit — instead of asserting it as an
 * unexplained label. Contract §3 (Footer) still governs everything else here: no
 * newsletter box [contract §3, SYNTHESIS CALL].
 *
 * [Launch-shape change] `#limits` and `#roadmap` are gone — LimitsSection and
 * RoadmapSection are both cut (see `pages/index.tsx`). This is also the ONE place
 * the zero-customer admission survives; GapSection and ProofSection both used to
 * repeat it and no longer do. Anchors now point at Security and Founding Access,
 * the two sections that replaced Limits/Roadmap and Pricing respectively.
 *
 * The dev.to article link the contract asks for is DEFERRED: the article is
 * still an unwritten draft, and a pre-launch footer linking a 404 fails the
 * honesty bar harder than the omission. The no-commitment "three things to get
 * right" checklist it would have carried is inlined in the Founding Access
 * section's <details> instead. [2026-09-03] Removed the footer's own forward-
 * looking "write-up follows" line and its internal ticket reference — a public
 * page is not the place to name an internal ticket ID or promise unpublished
 * content a visitor has no way to verify; the footer states only what is
 * concretely true today (the checklist is reproducible now) and says nothing
 * about content that doesn't exist yet.
 *
 * [RELAY-79 / RELAY-82] Legal links added. `growth/product/relay-launch-decisions.md`
 * decision #7 named this precisely: "The landing page footer links to #limits,
 * #roadmap and /auth/join — no legal links at all." Terms and the Refund/Cancellation
 * Policy now render at `/terms` and `/refund-policy` (see `components/legal/LegalPage.tsx`)
 * and are linked from here so a visitor can actually find them without first creating
 * an account. Privacy Notice / DPA are `relay/legal-b`'s document (RELAY-80/81),
 * drafted in a parallel worktree — not linked from here yet to avoid this branch
 * pointing at a route that may not exist on `main` until that work lands too.
 */
import Link from 'next/link';

import { LandingLink, focusRing } from './LandingPrimitives';

const LandingFooter = () => (
  <footer className="border-t border-landing-border/80">
    <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="max-w-md">
          <p className="text-sm font-semibold leading-relaxed text-landing-primary">
            Coreframe Relay — Buffer phase, built and running. Every webhook gets
            a receipt, not a dashboard to babysit: no customers yet, so no logos,
            no testimonials and no invented numbers on this page either.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-landing-secondary">
            The three-things-to-get-right checklist above is reproducible on your
            own stack.
          </p>
          <nav aria-label="Footer" className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
            <a
              href="#security"
              className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
            >
              Security
            </a>
            <a
              href="#founding-access"
              className={`rounded text-sm text-landing-secondary transition-colors hover:text-landing-primary ${focusRing}`}
            >
              Founding Access
            </a>
            {/* [RELAY-108] Docs and Pricing — the two real routes this ticket
                added, linked from the one footer that reaches every page. */}
            <Link
              href="/docs/integrations/n8n"
              className={`rounded text-sm text-[#9a9ea8] transition-colors hover:text-zinc-100 ${focusRing}`}
            >
              Docs
            </Link>
            <Link
              href="/pricing"
              className={`rounded text-sm text-[#9a9ea8] transition-colors hover:text-zinc-100 ${focusRing}`}
            >
              Pricing
            </Link>
            <Link
              href="/terms"
              className={`rounded text-sm text-[#9a9ea8] transition-colors hover:text-zinc-100 ${focusRing}`}
            >
              Terms
            </Link>
            <Link
              href="/refund-policy"
              className={`rounded text-sm text-[#9a9ea8] transition-colors hover:text-zinc-100 ${focusRing}`}
            >
              Refund Policy
            </Link>
          </nav>
        </div>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          <LandingLink href="/auth/join">Request Founding Access</LandingLink>
        </div>
      </div>
    </div>
  </footer>
);

export default LandingFooter;
