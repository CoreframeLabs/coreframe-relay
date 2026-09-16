/**
 * [ux-walkthrough 2026-09-15, finding 5b] General (non-n8n) quickstart at `/docs/quickstart`.
 *
 * Until this page, `/docs` was an index with exactly one entry — the n8n guide — and
 * the "Docs" link in the landing nav and footer went straight to that n8n page. Per
 * `growth/product/relay-ux-walkthrough-2026-09-15.md` (Dana, fold 10): a technical
 * evaluator who clicks Docs "finds a single page about someone else's product", reads
 * docs depth as a maturity signal, and stops there. The landing page told her routes
 * and a wizard exist; nothing under `/docs` showed either.
 *
 * Every step below is transcribed from the UI and API as they exist on this branch,
 * not from the spec or the roadmap:
 *  - signup fields and the verify-email redirect: `components/auth/Join.tsx`
 *  - the three wizard steps, the default of 7 retries (1–10), the header allowlist, the
 *    "URL is the credential" note and the test-send prompt: `components/relay/
 *    NewRouteWizard.tsx`, `DestinationHeadersEditor.tsx`, `SendTestButton.tsx`
 *  - the ingest URL shape: `models/route.ts` `relayUrlFor`
 *  - the 200 (not 202) ack and the 1 MiB / 413 cap: `apps/proxy/src/routes/ingest.ts`
 *  - the delivery-log statuses: `components/relay/StatusBadge.tsx`
 *  - once-per-item DLQ retry and the 64KB retention rule: `pages/api/teams/[slug]/
 *    relay/dlq/[id]/retry.ts`
 *  - the private-address destination rejection: `apps/proxy/src/services/ssrf.ts`
 * The limits section repeats the same two caps the landing page's "What Founding Access
 * doesn't include yet" list and `/terms` §3 already state, in the same words — a
 * quickstart that promised more than those pages would be the drift the walkthrough's
 * finding 3 was about. Hand-transcribed JSX, same as `docs/integrations/n8n.tsx`; there
 * is no markdown source for this one. If the wizard changes, this page needs a matching
 * edit.
 */
import type { GetStaticPropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import Link from 'next/link';

import DocsPage, { docsGetLayout } from '@/components/docs/DocsPage';
import { CodeWindow } from '@/components/docs/CodeWindow';
import {
  LandingLink,
  focusRing,
} from '@/components/defaultLanding/LandingPrimitives';
import type { DocsSection } from '@/components/docs/DocsPage';
import type { NextPageWithLayout } from 'types';

const inlineLink = `rounded text-landing-accent-text underline underline-offset-2 hover:text-landing-accent-text-hover ${focusRing}`;

const sections: DocsSection[] = [
  {
    id: 'before-you-start',
    title: 'Before you start',
    body: (
      <>
        <p>You need two things, and both are yours, not Relay&rsquo;s:</p>
        <ul className="mt-4 list-disc space-y-3 pl-5">
          <li>
            <strong className="text-landing-primary">
              An endpoint Relay can reach from the public internet.
            </strong>{' '}
            Relay validates every destination URL and rejects anything that
            resolves to a loopback or private address — <code>localhost</code>,
            a LAN address, a Docker-internal hostname with no public DNS. This
            is an anti-SSRF control, not a plan limit. A tunnel, reverse proxy,
            or public DNS entry in front of a private service is fine; a bare
            private address is not.
          </li>
          <li>
            <strong className="text-landing-primary">
              A webhook sender whose destination URL you control.
            </strong>{' '}
            Stripe, Shopify, GitHub, Meta, a cron job you wrote — anything that
            POSTs to a URL you can change in its settings. Relay doesn&rsquo;t
            need a custom header from the sender; the URL itself is the
            credential (see step 2).
          </li>
        </ul>
        <p className="mt-4">
          If the thing sending or receiving your webhooks is n8n, read the{' '}
          <Link href="/docs/integrations/n8n" className={inlineLink}>
            n8n guide
          </Link>{' '}
          instead — same mechanism, but it covers n8n&rsquo;s own webhook bugs
          and what Relay can and can&rsquo;t do about each of them.
        </p>
      </>
    ),
  },
  {
    id: 'sign-up',
    title: 'Step 1 — Create an account and a team',
    body: (
      <>
        <p>
          <Link href="/auth/join" className={inlineLink}>
            Request Founding Access
          </Link>{' '}
          is one form: your name, a team name, your email, and a password.
          There&rsquo;s no magic link or OAuth sign-in yet. After you submit,
          you&rsquo;re sent to a verify-your-email screen; click the link in
          that email and sign in. Founding Access is free — no card, nothing
          charged — and the team you named is where your routes live.
        </p>
      </>
    ),
  },
  {
    id: 'create-a-route',
    title: 'Step 2 — Create a route',
    body: (
      <>
        <p>
          Once signed in, the left-hand navigation for your team has three Relay
          entries: <strong className="text-landing-primary">Routes</strong>,{' '}
          <strong className="text-landing-primary">Delivery Log</strong> and{' '}
          <strong className="text-landing-primary">DLQ</strong>. Open{' '}
          <strong className="text-landing-primary">Routes</strong> and click{' '}
          <strong className="text-landing-primary">New Route</strong>. The
          wizard is three steps:
        </p>
        <ol className="mt-4 list-decimal space-y-4 pl-5">
          <li>
            <strong className="text-landing-primary">Name.</strong> Name the
            route after the service that will send to it (&ldquo;Stripe
            events&rdquo;, say). The name becomes the last human-readable
            segment of your ingest URL — the wizard shows the slug as you type.
          </li>
          <li>
            <strong className="text-landing-primary">Destination.</strong> Paste
            the http(s) URL Relay should forward to — your existing endpoint,
            exactly as it is today. Two optional fields on the same step:
            <ul className="mt-2 list-disc space-y-2 pl-5">
              <li>
                <strong className="text-landing-primary">Max retries</strong> —
                defaults to 7, accepts 1 to 10. After this many failed attempts
                the payload moves to the dead letter queue rather than being
                dropped.
              </li>
              <li>
                <strong className="text-landing-primary">
                  Destination auth headers
                </strong>{' '}
                — if your endpoint requires a header to accept a request (an{' '}
                <code>authorization</code> bearer, an <code>x-api-key</code>),
                add it here and Relay sends it on every forward. Only a short
                allowlist of header names is accepted (
                <code>authorization</code>, <code>x-api-key</code>,{' '}
                <code>x-auth-token</code>, <code>x-access-token</code>,{' '}
                <code>x-signature</code>, <code>x-hmac-signature</code>,{' '}
                <code>x-webhook-secret</code>, <code>x-github-hook-secret</code>
                ); values are encrypted at rest and never shown again after you
                save.
              </li>
            </ul>
          </li>
          <li>
            <strong className="text-landing-primary">Your Relay URL.</strong>{' '}
            Clicking{' '}
            <strong className="text-landing-primary">Create route</strong> shows
            the ingest URL. It looks like this:
          </li>
        </ol>
        <CodeWindow label="ingest URL shape">
          {`https://<relay-proxy-host>/in/<your-team>/<route-slug>/<ingest-token>`}
        </CodeWindow>
        <p>
          <strong className="text-landing-primary">
            Treat the whole URL as a secret.
          </strong>{' '}
          The last path segment is the route&rsquo;s ingest token; there is no
          separate signing header a sender has to set, which is why Stripe,
          Shopify, GitHub and Meta can all post to it unchanged. If it ever
          leaks, use the{' '}
          <strong className="text-landing-primary">Rotate ingest token</strong>{' '}
          control on that row of the Routes table — the old URL stops working
          immediately and you get a new one to paste into your sender.
        </p>
      </>
    ),
  },
  {
    id: 'send-a-test',
    title: 'Step 3 — Confirm the pipeline before a real sender touches it',
    body: (
      <>
        <p>
          The last wizard screen has a{' '}
          <strong className="text-landing-primary">Send test</strong> button. It
          fires one synthetic webhook through the route&rsquo;s real ingest URL
          and waits for the delivery-log row that the pipeline writes — it is
          end-to-end proof the request went in and came out, not a mock. The
          result (status, response code, latency) appears on the button itself.
        </p>
        <p className="mt-4">
          If you haven&rsquo;t got a destination ready yet, the same menu offers{' '}
          <strong className="text-landing-primary">
            Send to the built-in catcher
          </strong>
          . That re-points the route at a receiver Relay hosts, then sends — so
          you can watch a delivery succeed before you have anything of your own
          to deliver to. It changes the route&rsquo;s destination, so set it
          back to your real endpoint (the{' '}
          <strong className="text-landing-primary">Edit destination</strong>{' '}
          control on the Routes row) before step 4.
        </p>
        <p className="mt-4">
          Test rows are marked{' '}
          <strong className="text-landing-primary">TEST</strong> in the log so
          they can&rsquo;t be mistaken for sender traffic.
        </p>
      </>
    ),
  },
  {
    id: 'point-your-sender',
    title: 'Step 4 — Point your sender at the Relay URL',
    body: (
      <>
        <p>
          Go into your sender&rsquo;s own settings (Stripe&rsquo;s Developers →
          Webhooks, Shopify&rsquo;s notification settings, a GitHub
          repository&rsquo;s Webhooks page, your own scheduler&rsquo;s config)
          and replace the URL it currently posts to with the Relay ingest URL
          from step 2. Leave your endpoint exactly as it is — Relay forwards to
          it, it doesn&rsquo;t replace it.
        </p>
        <p className="mt-4">
          From this point on, every request takes this path:
        </p>
        <CodeWindow label="request path">
          {`sender
  → Relay ingest URL          (answers 200 the moment the request is durably queued)
  → Relay forwards to your destination, retries with backoff on failure
  → your endpoint`}
        </CodeWindow>
        <p>
          Relay answers the sender with <code>200</code>, not <code>202</code>,
          on purpose: a meaningful number of webhook senders in the wild test
          for exactly 200 and treat anything else as a failed delivery. That 200
          means &ldquo;stored, will be forwarded&rdquo; — it is not your
          endpoint&rsquo;s response.
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
          <strong className="text-landing-primary">Delivery Log</strong> shows
          every request Relay has received, filterable to one route, with one of
          these statuses:
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          <li>
            <strong className="text-landing-primary">QUEUED</strong> — received
            and durably stored; forwarding hasn&rsquo;t completed yet.
          </li>
          <li>
            <strong className="text-landing-primary">DELIVERED</strong> — your
            destination answered with a success status. This is the HTTP
            layer&rsquo;s word for it: your endpoint accepted the request. It
            says nothing about what your handler did with it afterwards.
          </li>
          <li>
            <strong className="text-landing-primary">RETRYING</strong> — the
            forward failed and Relay is backing off before trying again.
          </li>
          <li>
            <strong className="text-landing-primary">FAILED / DLQ</strong> —
            retries ran out. The payload now sits in the dead letter queue
            rather than being lost.
          </li>
          <li>
            <strong className="text-landing-primary">TEST</strong> — a row from
            the Send test button, not sender traffic.
          </li>
        </ul>
        <p className="mt-4">
          <strong className="text-landing-primary">DLQ</strong> lists everything
          that exhausted its retries. Each row shows the route, the destination,
          and a <strong className="text-landing-primary">Retry</strong> button
          that re-publishes the stored payload through the same delivery path —
          with the original request headers, so a vendor signature (
          <code>stripe-signature</code>, <code>x-hub-signature-256</code>,{' '}
          <code>x-shopify-hmac-sha256</code>) is replayed as it arrived. Retry
          is allowed once per item, so a double-click cannot double-deliver. Two
          exceptions the confirm dialog states per row: a payload over 64KB has
          no stored body to replay (see below), and a DLQ row written before
          header retention shipped replays body-only.
        </p>
      </>
    ),
  },
  {
    id: 'limits',
    title: 'Limits worth knowing before you rely on this',
    body: (
      <>
        <p>
          These are the same limits the landing page&rsquo;s &ldquo;What
          Founding Access doesn&rsquo;t include yet&rdquo; list and the{' '}
          <Link href="/terms" className={inlineLink}>
            Terms
          </Link>{' '}
          state — repeated here so you don&rsquo;t have to go looking:
        </p>
        <ul className="mt-4 list-disc space-y-3 pl-5">
          <li>
            <strong className="text-landing-primary">
              Payloads over 1 MiB are refused with a 413
            </strong>{' '}
            before they are buffered — counted as they stream, never silently
            truncated. The sender gets the 413; nothing is queued.
          </li>
          <li>
            <strong className="text-landing-primary">
              Payloads between 64KB and 1 MiB are delivered and retried like any
              other, but are not replayable from the DLQ.
            </strong>{' '}
            The DLQ only retains a body for manual replay up to 64KB. A bigger
            payload that ends up there is still logged — requestId, status,
            timestamps, headers — with nothing hidden; it just has no body to
            re-send, and the Retry button on that row is disabled and says why.
          </li>
          <li>
            <strong className="text-landing-primary">
              A paused route answers 404 and can&rsquo;t be retried into.
            </strong>{' '}
            Pausing (in the Edit destination dialog) means &ldquo;stop sending
            to this destination&rdquo;: new webhooks to that ingest URL get a
            404 until it is resumed, and DLQ Retry refuses until then too.
          </li>
          <li>
            <strong className="text-landing-primary">
              Relay can&rsquo;t reach a private address
            </strong>{' '}
            (see &ldquo;Before you start&rdquo;), and it can&rsquo;t make your
            handler correct — a 4xx from your endpoint is logged and lands in
            the DLQ like any other failure.
          </li>
        </ul>
        <p className="mt-4">
          There is no SLA, status page or service credit today — the{' '}
          <Link href="/terms" className={inlineLink}>
            Terms
          </Link>{' '}
          say so in §3. If something here doesn&rsquo;t match what you see in
          the product, that is a bug in this page — email{' '}
          <a href="mailto:info@coreframe-labs.dev" className={inlineLink}>
            info@coreframe-labs.dev
          </a>
          .
        </p>
      </>
    ),
  },
];

const QuickstartDocsPage: NextPageWithLayout = () => (
  <DocsPage
    eyebrow="Docs · Quickstart"
    title="Put Relay in front of any webhook endpoint"
    metaTitle="Quickstart — any webhook sender | Coreframe Relay"
    metaDescription="Sign up, create a route, get the ingest URL, point any webhook sender at it. Every step as the product actually does it today, plus the limits you should know before relying on it."
    canonical="https://relay.coreframe-labs.dev/docs/quickstart"
    intro={
      <p>
        This is the general path: one route in front of one endpoint, with any
        sender. It uses the same New Route wizard for every destination — there
        is nothing sender-specific to configure, and nothing here is unreleased.
        Four steps, then what you&rsquo;ll see in the delivery log and what the
        limits are.
      </p>
    }
    afterIntro={
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <LandingLink href="/auth/join">Request Founding Access</LandingLink>
        <Link
          href="/docs/integrations/n8n"
          className={`rounded text-sm text-landing-secondary underline decoration-landing-muted underline-offset-4 transition-colors hover:text-landing-primary ${focusRing}`}
        >
          Using n8n? Read the n8n guide instead
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

QuickstartDocsPage.getLayout = docsGetLayout;

export default QuickstartDocsPage;
