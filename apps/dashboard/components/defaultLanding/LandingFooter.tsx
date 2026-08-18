/**
 * [RELAY-64 v2] Footer — the reproducibility line and the anchors.
 *
 * Contract §3 (Footer): "not a dashboard. a receipt." No newsletter box
 * [contract §3, SYNTHESIS CALL].
 *
 * [Launch-shape change] `#limits` and `#roadmap` are gone — LimitsSection and
 * RoadmapSection are both cut (see `pages/index.tsx`). This is also the ONE place
 * the zero-customer admission survives; GapSection and ProofSection both used to
 * repeat it and no longer do. Anchors now point at Security and Founding Access,
 * the two sections that replaced Limits/Roadmap and Pricing respectively.
 *
 * The dev.to article link the contract asks for is DEFERRED: RELAY-70's article
 * is still an unwritten draft, and a pre-launch footer linking a 404 fails the
 * honesty bar harder than the omission. The no-commitment "three things to get
 * right" checklist it would have carried is inlined in the Founding Access
 * section's <details> instead, and the footer notes the article is coming.
 */
import { LandingLink, focusRing } from './LandingPrimitives';

const LandingFooter = () => (
  <footer className="border-t border-[#24262c]/80">
    <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="max-w-md">
          <p className="font-mono text-sm font-semibold text-[#f2f3f5]">
            not a dashboard. a receipt.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-[#9a9ea8]">
            Coreframe Relay — Buffer phase, built and running. No customers yet,
            so no logos, no testimonials and no invented numbers on this page. The
            three-things-to-get-right checklist above is reproducible on your own
            stack; the dev.to write-up follows when RELAY-70 publishes it.
          </p>
          <nav aria-label="Footer" className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
            <a
              href="#security"
              className={`rounded text-sm text-[#9a9ea8] transition-colors hover:text-zinc-100 ${focusRing}`}
            >
              Security
            </a>
            <a
              href="#founding-access"
              className={`rounded text-sm text-[#9a9ea8] transition-colors hover:text-zinc-100 ${focusRing}`}
            >
              Founding Access
            </a>
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
