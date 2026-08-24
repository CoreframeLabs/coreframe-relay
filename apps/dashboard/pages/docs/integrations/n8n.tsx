/**
 * [RELAY-108] Public, unauthenticated rendering of `docs/integrations/n8n.md`.
 *
 * Per `growth/product/relay-gtm-readiness-audit-2026-08-21.md` §7 B2: the setup guide
 * this page renders was, until this ticket, readable only as a raw GitHub blob that
 * nothing on the live site linked to — every forum reply, Reddit post and dev.to
 * cross-link the sales plan calls for needs a URL to point at, and a GitHub blob is a
 * weak destination for a purchase decision. This page is that URL.
 *
 * Content below is transcribed from `docs/integrations/n8n.md` at the repo root,
 * not reinvented — every bug citation, GitHub issue number, forum thread link and
 * caveat is carried over verbatim from that file. No markdown-rendering dependency
 * was added for this (`docs/integrations/n8n.md` continues to be the source of truth
 * read by contributors browsing the repo directly); this page hand-transcribes it into
 * JSX sections, the same approach already used for the Terms/Privacy/DPA/Refund pages
 * in `components/legal/**`. If `docs/integrations/n8n.md` changes, this page needs a
 * matching edit — there is no automatic sync.
 */
import type { GetStaticPropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import Link from 'next/link';

import DocsPage, { docsGetLayout } from '@/components/docs/DocsPage';
import { LandingLink, focusRing } from '@/components/defaultLanding/LandingPrimitives';
import type { DocsSection } from '@/components/docs/DocsPage';
import type { NextPageWithLayout } from 'types';

const extLink = `rounded text-landing-accent-text underline underline-offset-2 hover:text-landing-accent-text-hover ${focusRing}`;

type Verdict = 'yes' | 'yes-partial' | 'no';

const VerdictChip = ({ verdict }: { verdict: Verdict }) => {
  const styles: Record<Verdict, string> = {
    yes: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300',
    'yes-partial':
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300',
    no: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400',
  };
  const label: Record<Verdict, string> = {
    yes: 'Yes',
    'yes-partial': 'Yes, partly',
    no: 'No',
  };
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider ${styles[verdict]}`}
    >
      {label[verdict]}
    </span>
  );
};

const bugCapabilityRows: {
  bug: string;
  verdict: Verdict;
  whatHappens: string;
}[] = [
  {
    bug: 'Webhooks randomly stop firing, need a manual toggle',
    verdict: 'yes',
    whatHappens:
      "Relay receives the request first. While n8n's listener is down, the payload sits safely in Relay, gets retried with backoff, and lands in the DLQ (visible, manually replayable) if n8n never answers — instead of vanishing.",
  },
  {
    bug: 'API-activation never registers the webhook path (#21614)',
    verdict: 'no',
    whatHappens:
      "Relay can't register n8n's own listener. Instead of a silently dead webhook, requests show up in Relay's delivery log as RETRYING → DLQ against a destination that keeps refusing — a real, timestamped failure signal instead of nothing.",
  },
  {
    bug: "n8n Cloud's 100-second Cloudflare timeout",
    verdict: 'yes-partial',
    whatHappens:
      "Relay acknowledges the sender in milliseconds and forwards asynchronously — Stripe/Shopify never see n8n's processing time, they see Relay's ack. If n8n itself then times out on Relay's forward, that attempt becomes a RETRYING/DLQ item Relay keeps retrying, rather than the sender's own delivery attempt failing outright.",
  },
  {
    bug: 'Production webhook always returns 200 OK with nothing registered (#16339)',
    verdict: 'no',
    whatHappens:
      "This is the sharpest limit. If n8n accepts Relay's forwarded request and answers 200 while doing nothing, Relay's delivery log will honestly show DELIVERED, because that's what happened at the HTTP layer. Relay can prove “we handed this to n8n and n8n said OK.” It cannot prove n8n's workflow actually ran.",
  },
];

const sections: DocsSection[] = [
  {
    id: 'the-problem',
    title: 'The problem',
    body: (
      <>
        <p>
          n8n&rsquo;s own Webhook trigger node has a handful of documented,
          current reliability bugs. If you&rsquo;re running Stripe, Shopify,
          WhatsApp, or any other webhook source through n8n, you&rsquo;ve
          probably hit one of these:
        </p>
        <ul className="mt-4 list-disc space-y-3 pl-5">
          <li>
            <strong className="text-landing-primary">
              Webhooks randomly stop firing and need a manual workflow toggle
              to bring them back.
            </strong>{' '}
            While the listener is silently down, anything sent during that
            window is gone — the sender doesn&rsquo;t know n8n stopped
            listening, and n8n never re-fires the events it missed. Reported
            on the n8n community forum under the title &ldquo;Not
            Sustainable&rdquo; (
            <a
              href="https://community.n8n.io/t/help-needed-webhooks-randomly-stop-require-workflow-toggle-to-resume-not-sustainable/119667"
              target="_blank"
              rel="noopener noreferrer"
              className={extLink}
            >
              community.n8n.io/t/…119667
            </a>
            ).
          </li>
          <li>
            <strong className="text-landing-primary">
              Activating a workflow through the REST API doesn&rsquo;t always
              register the webhook path
            </strong>
            , so a workflow deployed programmatically (CI/CD,
            infrastructure-as-code) can go live with a dead webhook until
            someone opens the n8n UI and re-saves it (
            <a
              href="https://github.com/n8n-io/n8n/issues/21614"
              target="_blank"
              rel="noopener noreferrer"
              className={extLink}
            >
              GitHub #21614
            </a>{' '}
            — a fix shipped in n8n 2.14.0 via{' '}
            <a
              href="https://github.com/n8n-io/n8n/pull/27161"
              target="_blank"
              rel="noopener noreferrer"
              className={extLink}
            >
              PR #27161
            </a>
            ; if you&rsquo;re on an older version or a different edge case of
            the same bug class, it may still bite).
          </li>
          <li>
            <strong className="text-landing-primary">
              n8n Cloud enforces a hard 100-second Cloudflare timeout on
              webhook responses.
            </strong>{' '}
            A workflow that takes longer than that to finish fails with a
            524, regardless of what the workflow was actually doing (
            <a
              href="https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/common-issues"
              target="_blank"
              rel="noopener noreferrer"
              className={extLink}
            >
              n8n docs, common webhook issues
            </a>
            ).
          </li>
          <li>
            <strong className="text-landing-primary">
              A separate, still-open report of a Production Webhook that
              always returns 200 OK with nothing actually registered behind
              it
            </strong>
            , on both n8n Cloud and fresh self-hosted workflows (
            <a
              href="https://github.com/n8n-io/n8n/issues/16339"
              target="_blank"
              rel="noopener noreferrer"
              className={extLink}
            >
              GitHub #16339
            </a>
            ).
          </li>
        </ul>
        <p className="mt-4">
          These bugs live inside n8n&rsquo;s own webhook-handling and
          activation logic. Relay doesn&rsquo;t patch n8n&rsquo;s code and
          can&rsquo;t reach into n8n&rsquo;s internals — what it changes is
          what happens to your data <em>while</em> n8n is having one of these
          moments, because Relay, not n8n, is the first thing that receives
          the request.
        </p>
      </>
    ),
  },
  {
    id: 'what-changes',
    title: 'What actually changes, and what doesn’t',
    body: (
      <>
        <p>
          Putting Relay in front of your n8n workflow means: instead of
          Stripe/Shopify/your other webhook source posting directly to
          n8n&rsquo;s Production Webhook URL, it posts to a Relay ingest URL.
          Relay durably queues the request, retries it with backoff against
          your n8n webhook as the destination, and keeps a delivery log.
          Here&rsquo;s what that buys you against each bug above, stated
          plainly — two of the four are things Relay can only make visible,
          not fix:
        </p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-landing-border text-left text-landing-primary">
                <th className="py-2 pr-4 font-semibold">n8n&rsquo;s bug</th>
                <th className="py-2 pr-4 font-semibold">Fixed?</th>
                <th className="py-2 font-semibold">What actually happens</th>
              </tr>
            </thead>
            <tbody>
              {bugCapabilityRows.map((row) => (
                <tr key={row.bug} className="border-b border-landing-border/60 align-top">
                  <td className="py-3 pr-4 text-landing-secondary">{row.bug}</td>
                  <td className="py-3 pr-4">
                    <VerdictChip verdict={row.verdict} />
                  </td>
                  <td className="py-3 text-landing-secondary">{row.whatHappens}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-5">
          <strong className="text-landing-primary">Not covered at all:</strong>{' '}
          WhatsApp/Meta&rsquo;s webhook verification handshake (
          <code>hub.mode</code>, <code>hub.challenge</code>,{' '}
          <code>hub.verify_token</code>) is a separate, well-documented n8n
          pain point, but Relay doesn&rsquo;t implement that handshake
          either. Don&rsquo;t route a WhatsApp Business API verification step
          through Relay expecting it to work — it won&rsquo;t.
        </p>
        <p className="mt-4">
          <strong className="text-landing-primary">
            One thing worth knowing before you rely on DLQ replay:
          </strong>{' '}
          Relay&rsquo;s DLQ &ldquo;Retry&rdquo; button resends the stored
          request body <strong className="text-landing-primary">with the original request headers</strong>,
          signature headers (<code>stripe-signature</code>,{' '}
          <code>x-hub-signature-256</code>, <code>x-shopify-hmac-sha256</code>
          ) included, so an n8n workflow that verifies a signature itself
          will see the same header the original delivery carried. Two
          caveats remain, both about time rather than content:
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            <strong className="text-landing-primary">
              Timestamped signatures can still go stale.
            </strong>{' '}
            Stripe and others bind the signature to a timestamp and reject
            anything outside a tolerance window (Stripe&rsquo;s default is
            five minutes). A replay sent long after the original failure can
            therefore still be refused as stale, headers and all — that is
            the destination&rsquo;s clock, not something Relay withholds.
          </li>
          <li>
            <strong className="text-landing-primary">
              Items that predate this feature have no headers to replay.
            </strong>{' '}
            DLQ rows written before header retention shipped never stored
            the map, so replaying one behaves the old way (body only). The
            confirm dialog tells you which of the two cases an item is in
            before you click.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'ssrf',
    title: 'Before you start: one constraint that matters more for n8n than most',
    body: (
      <p>
        Relay validates every destination URL and rejects anything that
        resolves to a loopback or private address (this is an anti-SSRF
        control, not an n8n-specific restriction). If you&rsquo;re
        self-hosting n8n on a machine that isn&rsquo;t reachable from the
        public internet — <code>localhost</code>, a private LAN address, a
        Docker-internal hostname with no public DNS — Relay cannot reach it
        as a destination, for the same reason your original webhook sender
        couldn&rsquo;t reach it either. You need a publicly resolvable URL
        for your n8n instance (n8n Cloud gives you one automatically; a
        self-hosted instance needs a reverse proxy, tunnel, or public DNS
        entry pointing at it) before Relay — or anything else on the
        internet — can deliver to it.
      </p>
    ),
  },
  {
    id: 'setup',
    title: 'Setup, step by step',
    body: (
      <>
        <p>
          This uses Relay&rsquo;s existing sign-up and route-creation flow as
          it exists today. There is no n8n-specific UI yet — you&rsquo;re
          using the same &ldquo;New Route&rdquo; wizard used for any
          destination.
        </p>
        <ol className="mt-4 list-decimal space-y-4 pl-5">
          <li>
            <strong className="text-landing-primary">
              Get your n8n Production Webhook URL first.
            </strong>{' '}
            Open the workflow with the Webhook trigger node you want to
            protect. Make sure the workflow is <strong className="text-landing-primary">activated</strong>{' '}
            — n8n only serves the Production Webhook URL (as opposed to the
            Test URL) once a workflow is active — and copy that Production
            URL from the node.
          </li>
          <li>
            <strong className="text-landing-primary">
              Create a Relay account and a team.
            </strong>{' '}
            Sign up with email and password (there&rsquo;s no magic-link or
            OAuth sign-in yet, so expect a normal password signup plus an
            email verification step). Once you&rsquo;re in, you&rsquo;ll be
            asked to name a team; any name works.
          </li>
          <li>
            <strong className="text-landing-primary">Create a route.</strong>{' '}
            From your team&rsquo;s Buffer → Routes page, click{' '}
            <strong className="text-landing-primary">New Route</strong> and
            walk the 3-step wizard: name it after the sender (e.g.
            &ldquo;Stripe → n8n&rdquo;), paste your n8n workflow&rsquo;s
            Production Webhook URL as the <strong className="text-landing-primary">Destination</strong>{' '}
            (Relay defaults to 7 retries before a payload moves to the DLQ),
            then get your Relay ingest URL — treat the whole URL as a
            secret, and rotate it from the Routes table if it ever leaks.
          </li>
          <li>
            <strong className="text-landing-primary">
              Repoint your webhook source at the Relay URL — not at n8n.
            </strong>{' '}
            Go into your webhook source&rsquo;s own settings (Stripe&rsquo;s
            Developers → Webhooks, Shopify&rsquo;s notification settings,
            etc.) and replace the n8n Production Webhook URL you had it
            pointed at with the Relay ingest URL from step 3. Leave your n8n
            workflow&rsquo;s own webhook node exactly as it is — Relay
            forwards to it, it doesn&rsquo;t replace it.
          </li>
        </ol>
        <p className="mt-4">
          From this point on, the flow is: sender → Relay ingest URL → Relay
          queues and retries → n8n&rsquo;s Production Webhook URL → your
          workflow.
        </p>
      </>
    ),
  },
  {
    id: 'what-you-see',
    title: 'What you’ll see once it’s live',
    body: (
      <>
        <p>
          <strong className="text-landing-primary">The delivery log</strong>{' '}
          (Buffer → Live Delivery Log, filterable down to just this route)
          shows every request Relay has received and what happened to it:
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            <strong className="text-landing-primary">QUEUED</strong> —
            received and durably stored, forwarding hasn&rsquo;t completed
            yet.
          </li>
          <li>
            <strong className="text-landing-primary">DELIVERED</strong> — n8n
            answered with a success status. This means n8n accepted the HTTP
            request, not that your workflow necessarily finished
            successfully (see GitHub #16339 above).
          </li>
          <li>
            <strong className="text-landing-primary">RETRYING</strong> — the
            forward to n8n failed and Relay is backing off before trying
            again.
          </li>
          <li>
            <strong className="text-landing-primary">FAILED / DLQ</strong> —
            retries ran out. The payload is now sitting in the dead letter
            queue rather than lost.
          </li>
          <li>
            <strong className="text-landing-primary">TEST</strong> — a row
            generated by Relay&rsquo;s own &ldquo;Send test webhook&rdquo;
            button, not real sender traffic.
          </li>
        </ul>
        <p className="mt-4">
          <strong className="text-landing-primary">The DLQ</strong> (Buffer →
          Dead Letter Queue) lists everything that exhausted its retries.
          Each row shows the route, the destination, and a Retry button that
          re-publishes the stored payload back through the same delivery
          path — once per item, and only if the payload was retained
          (payloads over 64KB aren&rsquo;t stored, so there&rsquo;s nothing
          to replay). A retry replays the original request headers too, so a
          signature check your n8n workflow performs (Stripe-Signature,
          X-Hub-Signature-256, X-Shopify-Hmac-SHA256) passes on replay the
          same way it did on the original delivery — except for a DLQ row
          created before header retention shipped, which has no headers
          stored against it; the confirm dialog states this per-row.
        </p>
      </>
    ),
  },
  {
    id: 'not-yet',
    title: 'What this setup does not give you (yet)',
    body: (
      <p>
        There&rsquo;s no dedicated n8n node, no in-canvas status view, and no
        listing in n8n&rsquo;s community-node registry. You&rsquo;re using
        Relay&rsquo;s general-purpose route flow, pointed manually at your
        n8n instance, the same way you&rsquo;d point it at any other HTTP
        destination. If a first-class n8n integration ships later, it will
        build on top of exactly this same mechanism — it won&rsquo;t need
        you to redo anything you set up here.
      </p>
    ),
  },
];

const N8nDocsPage: NextPageWithLayout = () => (
  <DocsPage
    eyebrow="Docs · Integrations"
    title="Using Relay in front of an n8n webhook"
    metaTitle="n8n webhook reliability — setup guide | Coreframe Relay"
    metaDescription="n8n's Webhook trigger has documented, current reliability bugs — webhooks that silently stop firing, an API-activation bug, a 100-second Cloudflare timeout, and a Production Webhook that can return 200 with nothing registered. Here's what putting Relay in front of it actually changes, sourced and stated plainly."
    intro={
      <p>
        If you found this page from an n8n bug thread or the community
        forum: this is a setup guide, not a sales pitch. It uses
        Relay&rsquo;s existing route-creation flow — nothing here is
        unreleased or n8n-specific under the hood. Read &ldquo;What actually
        changes, and what doesn&rsquo;t&rdquo; below before you touch
        anything; it says plainly which parts of your problem this fixes and
        which parts it doesn&rsquo;t.
      </p>
    }
    afterIntro={
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <LandingLink href="/pricing">Get n8n Reliability — $19/mo</LandingLink>
        <Link
          href="/auth/join"
          className={`rounded text-sm text-landing-secondary underline decoration-landing-muted underline-offset-4 transition-colors hover:text-landing-primary ${focusRing}`}
        >
          Or request Founding Access
        </Link>
      </div>
    }
    sections={sections}
  />
);

export const getStaticProps = async ({ locale }: GetStaticPropsContext) => {
  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
};

N8nDocsPage.getLayout = docsGetLayout;

export default N8nDocsPage;
