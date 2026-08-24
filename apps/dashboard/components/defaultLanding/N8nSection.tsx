/**
 * [RELAY-108] The real n8n section — not the passing mention the audit found.
 *
 * `growth/product/relay-gtm-readiness-audit-2026-08-21.md` §2.1: before this ticket
 * the live page mentioned "n8n" exactly once, incidentally, as an example credential
 * type — no heading, no section, no bug citations, no link to the setup guide. The
 * four bugs below and their sourced links are transcribed from `docs/integrations/
 * n8n.md` (which itself cites the community forum thread and the two GitHub issue
 * numbers) — nothing here is a new or invented claim. The Yes/Partial/No verdicts
 * match that file's bug-to-capability table exactly, including the two honest "No"
 * rows: this section is not allowed to oversell what Relay does inside n8n's own
 * activation and execution logic, which it genuinely cannot reach.
 */
import Link from 'next/link';

import {
  Card,
  LandingLink,
  Section,
  SectionHeading,
  focusRing,
} from './LandingPrimitives';

type Verdict = 'fixed' | 'partial' | 'not-fixed';

const verdictLabel: Record<Verdict, string> = {
  fixed: 'Relay fixes this',
  partial: 'Relay fixes the sender-facing part',
  'not-fixed': "Relay can't fix this — makes it visible instead",
};

const verdictStyles: Record<Verdict, string> = {
  fixed:
    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300',
  partial:
    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300',
  'not-fixed':
    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400',
};

const bugs: {
  title: string;
  body: string;
  verdict: Verdict;
  sourceLabel: string;
  sourceHref: string;
}[] = [
  {
    title: 'Webhooks randomly stop firing',
    body: 'The Webhook trigger can silently stop listening until you manually toggle the workflow off and on. Anything sent during that window is gone.',
    verdict: 'fixed',
    sourceLabel: 'community.n8n.io — "Not Sustainable"',
    sourceHref:
      'https://community.n8n.io/t/help-needed-webhooks-randomly-stop-require-workflow-toggle-to-resume-not-sustainable/119667',
  },
  {
    title: 'API-activated workflows can go live dead',
    body: "Activating a workflow through n8n's REST API doesn't always register the webhook path — a CI/CD-deployed workflow can be \"active\" with nothing listening until someone re-saves it in the UI.",
    verdict: 'not-fixed',
    sourceLabel: 'GitHub n8n-io/n8n #21614',
    sourceHref: 'https://github.com/n8n-io/n8n/issues/21614',
  },
  {
    title: "n8n Cloud's 100-second timeout",
    body: 'A hard Cloudflare timeout fails any workflow that takes longer to finish, regardless of what it was doing.',
    verdict: 'partial',
    sourceLabel: 'n8n docs — common webhook issues',
    sourceHref:
      'https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/common-issues',
  },
  {
    title: 'Production webhook can return 200 with nothing behind it',
    body: 'A still-open report: the Production Webhook answers 200 OK on both n8n Cloud and fresh self-hosted workflows with nothing actually registered.',
    verdict: 'not-fixed',
    sourceLabel: 'GitHub n8n-io/n8n #16339',
    sourceHref: 'https://github.com/n8n-io/n8n/issues/16339',
  },
];

const N8nSection = () => (
  <Section id="n8n">
    <SectionHeading
      eyebrow="For n8n users"
      title="n8n's Webhook trigger has documented, current reliability bugs."
      lede="If you're running Stripe, Shopify, or anything else through n8n, you've probably hit one of these. Relay sits in front of n8n's Production Webhook URL — here's what that actually changes, and what it honestly can't, stated the same way the setup guide states it."
    />

    <div className="mt-10 grid gap-4 md:grid-cols-2">
      {bugs.map((bug) => (
        <Card key={bug.title}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="max-w-[16rem] text-base font-semibold text-landing-primary">
              {bug.title}
            </h3>
            <span
              className={`inline-flex shrink-0 items-center rounded border px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider ${verdictStyles[bug.verdict]}`}
            >
              {verdictLabel[bug.verdict]}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-landing-secondary">
            {bug.body}
          </p>
          <a
            href={bug.sourceHref}
            target="_blank"
            rel="noopener noreferrer"
            className={`mt-3 inline-block rounded text-xs text-landing-muted underline decoration-landing-muted underline-offset-4 transition-colors hover:text-landing-secondary ${focusRing}`}
          >
            {bug.sourceLabel} ↗
          </a>
        </Card>
      ))}
    </div>

    <div className="mt-10 flex flex-col items-start gap-4 rounded-2xl border border-landing-border bg-landing-surface/60 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
      <div className="max-w-xl">
        <p className="text-sm font-medium text-landing-primary">
          A single flat n8n tier — $19/month, no metering.
        </p>
        <p className="mt-1 text-sm leading-relaxed text-landing-secondary">
          Point a route at your n8n Production Webhook URL and get retry
          with backoff, a delivery log, and a DLQ with header-replay for
          anything n8n doesn&apos;t answer for.{' '}
          <Link
            href="/docs/integrations/n8n"
            className={`rounded underline decoration-landing-muted underline-offset-4 transition-colors hover:text-landing-primary ${focusRing}`}
          >
            Read the full setup guide
          </Link>
          .
        </p>
      </div>
      <LandingLink href="/pricing" className="shrink-0">
        Get n8n Reliability — $19/mo
      </LandingLink>
    </div>
  </Section>
);

export default N8nSection;
