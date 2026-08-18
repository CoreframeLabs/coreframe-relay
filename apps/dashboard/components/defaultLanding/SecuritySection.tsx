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
 *    and `dependency-audit` jobs, each exiting non-zero on a CRITICAL/HIGH finding.
 *  - Public disclosure policy: `SECURITY.md` at the repo root, with stated SLAs.
 *
 * [D7 claims-vs-code audit fix] Two corrections made during the D7 pass:
 *  1. The old copy said "all three are required checks. Nothing merges past a CRITICAL or
 *     HIGH finding." `ci.yml`'s own comment above `ci-required` reads "Add ... as the
 *     required status check in Settings → Branches" — an instruction to a human, not a
 *     confirmed setting. Whether GitHub branch protection actually blocks a merge on
 *     failure is a repo-admin console setting this repo checkout cannot verify, so the
 *     claim is narrowed to what the workflow file itself proves: each job runs on every
 *     push/PR and fails the build on a CRITICAL/HIGH finding.
 *  2. The old copy said "Report to security@ or info@coreframe-labs.dev". A repo-wide
 *     search found `security@...` written nowhere else — not in `SECURITY.md`, not in any
 *     env var, not in any DNS/email-routing note — only on this landing page. `SECURITY.md`
 *     itself names exactly one address. Claiming a mailbox nobody has provisioned is the
 *     exact class of error this audit exists to catch, so the copy now matches
 *     `SECURITY.md` verbatim: one address.
 *
 * One claim is DELIBERATELY narrower than the original brief asked for: SSRF validation.
 * The real literal-address validator (`apps/proxy/src/services/ssrf.ts`, RFC-1918 +
 * loopback + link-local/metadata + blocked ports) runs at INGEST time only. As of the D7
 * gate, `apps/dashboard/lib/relay/ssrfGap.ts` on `main` (and on this branch, which forked
 * from `main` at the same commit) is still a shape-only stand-in at forward time — its own
 * file header calls this "a KNOWN SECURITY GAP" and names RELAY-33 as the fix. RELAY-33 IS
 * fixed on `relay/sec-criticals` (confirmed by reading that branch's `ssrfGap.ts` directly:
 * it now re-exports the real validator) but that branch had NOT merged into `main` as of
 * this audit. The copy below says only what is true right now on the code this page ships
 * from (checked at ingest, before anything is ever queued) and does not claim forward-time
 * or DLQ-replay re-validation. If `relay/sec-criticals` merges before this branch does,
 * this claim can be safely widened — but not before, and not on the strength of the other
 * branch existing.
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
    body: 'Gitleaks for secrets, Semgrep for static analysis, and Trivy for dependency vulnerabilities all run on every push and pull request, and each fails the build on a CRITICAL or HIGH finding.',
  },
  {
    title: 'Public vulnerability disclosure',
    body: 'A published policy with stated response SLAs — 24 hours for anything that could touch another team’s data. Report to info@coreframe-labs.dev; safe-harbor terms apply to good-faith testing.',
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
