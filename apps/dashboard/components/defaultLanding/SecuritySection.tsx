/**
 * [RELAY-64 v2 / launch-shape change] Security — fills the slot LimitsSection and
 * RoadmapSection left behind (see `pages/index.tsx`'s section-order comment).
 *
 * Per `growth/product/relay-launch-sprint.md` §2.2 and the H2 gate condition ("the page
 * does not sell metering, caps, retention tiers, trials or Gate/Shield as shipped"), every
 * claim below is checked against code that exists TODAY, not the near-term plan:
 *
 *  - AES-256-GCM at rest: `apps/dashboard/lib/relay/destinationAuth.ts` — random IV per
 *    value, GCM auth tag, fails closed on tamper.
 *  - CI (Gitleaks + Semgrep + Trivy): `.github/workflows/ci.yml` — `secret-scan`, `sast`
 *    and `dependency-audit` jobs, all required by the `ci-required` aggregator.
 *  - Public disclosure policy: `SECURITY.md` at the repo root, with stated SLAs.
 *
 * One claim is DELIBERATELY narrower than the original brief asked for: SSRF validation.
 * The real literal-address validator (`apps/proxy/src/services/ssrf.ts`, RFC-1918 +
 * loopback + link-local/metadata + blocked ports) runs at INGEST time only. At the point
 * this section was written, `apps/dashboard/lib/relay/ssrfGap.ts` is still a shape-only
 * stand-in at forward time — its own file header calls this "a KNOWN SECURITY GAP" and
 * names RELAY-33 as the fix, which a concurrent security lane owns on a different branch
 * and has not yet merged. The copy below says only what is true right now (checked at
 * ingest, before anything is ever queued) and does not claim forward-time or DLQ-replay
 * re-validation. Re-check `ssrfGap.ts` before widening this claim once RELAY-33 lands.
 */
import { Card, Section, SectionHeading, StatusChip } from './LandingPrimitives';

const capabilities = [
  {
    title: 'Destination credentials, encrypted at rest',
    body: 'A CRM bearer token, a signing secret, an n8n webhook key — anything you configure for a route is AES-256-GCM encrypted with a random IV per value before it touches the database. A database dump does not yield a usable credential.',
  },
  {
    title: 'Every destination checked before it is queued',
    body: 'A route pointing at cloud metadata, localhost, or an internal RFC-1918 address is rejected at ingest, before the payload is ever queued for delivery — not a promise, a check that runs on every request.',
  },
  {
    title: 'CI gates on every commit',
    body: 'Gitleaks for secrets, Semgrep for static analysis, and Trivy for dependency vulnerabilities — all three are required checks. Nothing merges past a CRITICAL or HIGH finding.',
  },
  {
    title: 'Public vulnerability disclosure',
    body: 'A published policy with stated response SLAs — 24 hours for anything that could touch another team’s data. Report to security@ or umar.ali@coreframe-labs.dev; safe-harbor terms apply to good-faith testing.',
  },
];

const SecuritySection = () => (
  <Section id="security">
    <SectionHeading
      eyebrow="Security"
      title="Built to hold your client's credentials, not just your traffic."
      lede="This is what's checked and true in the codebase today — not the roadmap. Nothing below is a compliance certification; it's what a code reviewer would find."
    />

    <div className="mt-10 grid gap-4 md:grid-cols-2">
      {capabilities.map((capability) => (
        <Card key={capability.title}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="max-w-[16rem] text-base font-semibold text-zinc-100">
              {capability.title}
            </h3>
            <StatusChip tone="built">Built</StatusChip>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            {capability.body}
          </p>
        </Card>
      ))}
    </div>
  </Section>
);

export default SecuritySection;
