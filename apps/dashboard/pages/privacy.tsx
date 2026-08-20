/**
 * [RELAY-80] Privacy Notice — UK GDPR.
 *
 * Drafted against the real architecture, not a template: sub-processor list, the
 * controller/processor split, retention behaviour and security measures below are
 * grounded in `growth/product/relay-launch-decisions.md` #7, `relay-launch-sprint.md`
 * §2.2, `prisma/schema.prisma`, `lib/relay/destinationAuth.ts` and `.env.example`, and
 * are only as current as those sources were on this document's effective date.
 *
 * THIS IS A COMPETENT DRAFT GROUNDED IN THE REAL SYSTEM, NOT A SUBSTITUTE FOR
 * SOLICITOR REVIEW. It has not been reviewed by a qualified UK data-protection
 * solicitor. Coreframe Labs Ltd also has NOT YET registered with the ICO and paid the
 * statutory data-protection fee (~£40-£52/year) as of this document's effective date —
 * that registration is a director action, independent of this Notice existing, and
 * this Notice does not represent that registration has occurred. Get both done before
 * this Notice is relied on at any real volume.
 *
 * CORRECTED ON REVIEW (2026-08-20): an earlier draft of Section 8 stated that Row-Level
 * Security "is enforced" on production tenant data. Checked against
 * `relay-launch-decisions.md` #9 and the RELAY-39/RELAY-83 entries in
 * `relay-dev-log.md`/`relay-sprint-plan.md`: the policies are created and enabled in
 * the production database, but the production app still connects via the `postgres`
 * role (`rolbypassrls=true`), not the restricted `relay_app` role those policies are
 * written to bind — the flip is a named, not-yet-taken director action (RELAY-39 status:
 * BLOCKED). Section 8 now says so. Re-check this note before this Notice's next
 * effective-date bump — if the flip has landed, tighten the language.
 *
 * Route matches `NEXT_PUBLIC_PRIVACY_URL='/privacy'` already declared in
 * `.env.example` — this page fills a route the app already expected to exist.
 */
import type { ReactElement } from 'react';
import Head from 'next/head';
import Link from 'next/link';

import { LegalLayout } from '@/components/legal/LegalLayout';
import type { NextPageWithLayout } from 'types';

const EFFECTIVE_DATE = '19 August 2026';

const PrivacyPage: NextPageWithLayout = () => {
  return (
    <>
      <Head>
        <title>Privacy Notice — Coreframe Relay</title>
        <meta
          name="description"
          content="How Coreframe Labs Ltd collects and processes personal data through Coreframe Relay, including as a data processor for webhook payloads."
        />
      </Head>

      <LegalLayout title="Privacy Notice" effectiveDate={EFFECTIVE_DATE}>
        <p>
          Coreframe Labs Ltd (&ldquo;<strong>Coreframe</strong>&rdquo;,
          &ldquo;we&rdquo;, &ldquo;us&rdquo;) is a company registered in
          England &amp; Wales. We build and operate Coreframe Relay, a webhook
          receipt, buffer, retry and dead-letter-queue service
          (&ldquo;<strong>Relay</strong>&rdquo;, the &ldquo;Service&rdquo;).
          This Notice explains what personal data we collect, why, on what
          legal basis, who we share it with, and what rights you have under
          UK GDPR and the Data Protection Act 2018.
        </p>
        <p>
          Questions about this Notice or a data protection request:{' '}
          <a href="mailto:info@coreframe-labs.dev">info@coreframe-labs.dev</a>
          . This is also Coreframe&rsquo;s security contact address.
        </p>

        <h2>1. Two roles: when we are the controller, and when we are not</h2>
        <p>
          Relay sits in front of a customer&rsquo;s webhook endpoint. Because
          of that, this Notice has to describe two genuinely different kinds
          of processing, and it is important you understand which applies to
          you:
        </p>
        <ul>
          <li>
            <strong>We are the data controller</strong> for your{' '}
            <strong>Relay account data</strong> — the name, email address and
            team details you give us when you sign up and use the dashboard.
            This section of the Notice tells you what we do with that data
            and why, in the normal way a privacy notice does.
          </li>
          <li>
            <strong>We are a data processor</strong> for the{' '}
            <strong>content of the webhooks you route through Relay</strong>.
            If you configure a Route that receives, say, Stripe payment
            events, Shopify order events or WhatsApp Business API messages,
            those payloads may contain personal data belonging to{' '}
            <strong>your own customers or end-users</strong> — a
            cardholder&rsquo;s name, a shipping address, a phone number, a
            message body. We do not decide what you send through Relay, we
            do not use it for our own purposes, and we act only on your
            instructions as set out in our{' '}
            <Link href="/dpa">Data Processing Addendum</Link>. If you are a
            business sending your own customers&rsquo; personal data through
            Relay, <strong>you</strong> are the controller of that data and
            you are responsible for having your own lawful basis and your
            own privacy notice covering it — this document does not discharge
            that obligation for you.
          </li>
        </ul>

        <h2>2. Account data we collect, and why (we are the controller)</h2>
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Why we collect it</th>
              <th>Lawful basis</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Name, email address, password (stored hashed)</td>
              <td>Create and secure your account; sign you in</td>
              <td>Contract (Art. 6(1)(b)) — necessary to provide the Service</td>
            </tr>
            <tr>
              <td>Email verification status, login-attempt count, account-lock status</td>
              <td>Prevent account takeover and credential-stuffing abuse</td>
              <td>Legitimate interests (Art. 6(1)(f)) — securing the Service</td>
            </tr>
            <tr>
              <td>Team name, team slug, optional domain</td>
              <td>Organise your Routes and teammates under one workspace</td>
              <td>Contract (Art. 6(1)(b))</td>
            </tr>
            <tr>
              <td>Team membership and role (owner / admin / member)</td>
              <td>Control who can configure Routes and see delivery data</td>
              <td>Contract (Art. 6(1)(b))</td>
            </tr>
            <tr>
              <td>Invitation email address, when you invite a teammate</td>
              <td>Send the invitation and link it to a team</td>
              <td>Contract (Art. 6(1)(b)), on your instruction</td>
            </tr>
            <tr>
              <td>API key name and creation/last-used timestamps (the key itself is stored hashed, never in plain text)</td>
              <td>Let you authenticate programmatic access to your account</td>
              <td>Contract (Art. 6(1)(b))</td>
            </tr>
            <tr>
              <td>Audit log entries — actor email, event type, affected object, timestamp</td>
              <td>Give you and us a record of account-level actions for security and troubleshooting</td>
              <td>Legitimate interests (Art. 6(1)(f))</td>
            </tr>
            <tr>
              <td>Session cookie (NextAuth)</td>
              <td>Keep you signed in</td>
              <td>Strictly necessary — no consent banner required for this cookie</td>
            </tr>
          </tbody>
        </table>
        <p>
          We do not currently send marketing email based on your account
          data. Transactional email — sign-up verification and password
          reset — is sent because it is necessary to operate the account you
          asked us to create, not on a consent basis.
        </p>

        <h2>3. What we process on your behalf (we are the processor)</h2>
        <p>
          When you create a Route, you configure a destination URL and,
          optionally, authentication headers Relay should attach when
          forwarding to your own downstream system. Those header{' '}
          <strong>values</strong> are your credentials, not personal data
          about a third party in the ordinary case, and are encrypted at
          rest (AES-256-GCM, a random initialisation vector per value) the
          moment you save them; no API response, including ones we control,
          ever returns a header value once set — only its name.
        </p>
        <p>
          Two genuinely different things happen to the webhook traffic
          itself, and they carry different amounts of data at rest:
        </p>
        <ul>
          <li>
            <strong>
              Successfully delivered webhooks: metadata only, not the payload
              body.
            </strong>{' '}
            Our delivery log records the request ID, the sender&rsquo;s IP
            address, delivery status, attempt count, the destination&rsquo;s
            response code, latency, and the payload&rsquo;s size in bytes.
            It does not store the payload&rsquo;s content. Once a webhook is
            delivered, Relay does not retain what was inside it.
          </li>
          <li>
            <strong>
              Permanently failed webhooks: the payload is retained, so you
              can review and replay it.
            </strong>{' '}
            If a webhook exhausts its retry attempts, it lands in the
            dead-letter queue, and — unlike a successful delivery — the
            actual payload content is stored (inline for payloads under
            64KB; referenced via object storage above that), because the
            entire point of the dead-letter queue is to let you inspect and
            manually retry it. This is the one place a third party&rsquo;s
            personal data (for example, a cardholder&rsquo;s name and email
            inside a failed Stripe event) is genuinely held at rest inside
            Relay in more than metadata form.
          </li>
        </ul>
        <p>
          <strong>Sender IP addresses</strong> (the address the webhook
          arrived from — typically the sending platform&rsquo;s own
          infrastructure, e.g. Stripe&rsquo;s or Shopify&rsquo;s, not your
          end-user&rsquo;s) are recorded against every delivery attempt for
          abuse detection and troubleshooting.
        </p>

        <h2>4. Retention — stated honestly</h2>
        <p>
          <strong>
            As of this Notice&rsquo;s effective date, Relay has no automated
            process that deletes account data, delivery-log rows or
            dead-letter-queue payloads on a schedule.
          </strong>{' '}
          The dashboard&rsquo;s dead-letter-queue page shows a
          &ldquo;time remaining&rdquo; indicator against each item; that
          indicator reflects an intended future retention policy and does{' '}
          <strong>not</strong> currently result in automatic deletion when it
          reaches zero. We are not going to publish a specific 7-day, 30-day
          or 90-day retention promise until an automated process actually
          enforces one — a stated retention period with no code behind it
          would be a false claim in this Notice, not a missing feature.
        </p>
        <p>Until that changes:</p>
        <ul>
          <li>
            Delivery-log metadata and dead-letter-queue payloads are
            retained until you delete them yourself (the dashboard supports
            manual deletion and retry of dead-letter items), your account is
            deleted, or you ask us to delete them.
          </li>
          <li>
            Account and team data is retained for as long as your account is
            active, plus a limited period afterwards where we have a legal
            or accounting reason to keep it (for example, invoice records,
            once billing exists, are ordinarily kept around six years to
            meet UK tax record-keeping obligations).
          </li>
          <li>
            You can ask us to delete your account and associated data at any
            time — see Section 6.
          </li>
        </ul>

        <h2>5. Sub-processors</h2>
        <p>
          The following organisations process data on our behalf in order to
          run the Service. This list is factual as of this Notice&rsquo;s
          effective date and will be updated if it changes — see the{' '}
          <Link href="/dpa">Data Processing Addendum</Link> for the change-notice
          mechanism that applies if you are a business customer.
        </p>
        <table>
          <thead>
            <tr>
              <th>Sub-processor</th>
              <th>Purpose</th>
              <th>Location of processing</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Vercel Inc.</td>
              <td>Hosts the Relay dashboard application</td>
              <td>United States</td>
            </tr>
            <tr>
              <td>Supabase</td>
              <td>
                Primary database — Relay account data, Route configuration,
                delivery logs and dead-letter-queue items
              </td>
              <td>eu-west-2 (London, UK)</td>
            </tr>
            <tr>
              <td>Upstash (QStash)</td>
              <td>
                Message queue that sequences delivery attempts and retries
                between our proxy and your destination
              </td>
              <td>United States / EU (multi-region queue infrastructure)</td>
            </tr>
            <tr>
              <td>Cloudflare, Inc.</td>
              <td>
                Reverse proxy, DNS and edge network in front of the ingest
                endpoint
              </td>
              <td>Global edge network / United States</td>
            </tr>
            <tr>
              <td>Resend</td>
              <td>
                Transactional email — sign-up verification and password
                reset
              </td>
              <td>
                <strong>ap-northeast-1 (Tokyo, Japan)</strong> — see Section
                7, International transfers
              </td>
            </tr>
            <tr>
              <td>Stripe, Inc.</td>
              <td>
                Payment collection, where applicable — Stripe acts as an
                independent controller for your payment card data; Coreframe
                does not receive or store card numbers
              </td>
              <td>United States / United Kingdom</td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>Sentry</strong> (error monitoring) and{' '}
          <strong>Mixpanel</strong> (product analytics) are integrated in
          Relay&rsquo;s codebase but require an explicit configuration value
          (a Sentry DSN, a Mixpanel project token) to activate, and neither
          is configured in Coreframe&rsquo;s reference deployment settings as
          of this Notice&rsquo;s effective date. Neither is currently
          receiving data. If either is switched on in the future, this
          Notice will be updated to name it here and describe what it
          receives before it goes live.
        </p>

        <h2>6. International transfers</h2>
        <p>
          Two sub-processors above sit outside the UK, so UK GDPR Chapter V
          requires us to name the safeguard for each:
        </p>
        <ul>
          <li>
            <strong>Resend — Tokyo, Japan.</strong> The UK maintains
            adequacy regulations recognising Japan&rsquo;s data protection
            framework (the Act on the Protection of Personal Information,
            APPI) as adequate for restricted transfers to private-sector
            organisations regulated as APPI &ldquo;personal information
            handling business operators&rdquo;. Where that basis applies, no
            additional Article 46 safeguard is required, and it is our
            primary basis for this transfer. Because Resend is a US-
            headquartered company using Tokyo-region infrastructure rather
            than a Japan-incorporated entity in every respect, we also rely
            on the standard contractual safeguards in Resend&rsquo;s own
            data processing terms (which incorporate the UK International
            Data Transfer Addendum to the EU Standard Contractual Clauses)
            as a fallback, so the transfer is covered either way.
          </li>
          <li>
            <strong>Vercel — United States.</strong> Our agreement with
            Vercel incorporates the UK International Data Transfer Addendum
            to the EU Standard Contractual Clauses (or, where Vercel is a
            certified participant, the UK extension to the EU-US Data
            Privacy Framework) as the transfer safeguard.
          </li>
        </ul>
        <p>
          We have not independently verified every sub-processor&rsquo;s
          exact transfer paperwork against the standard above beyond what is
          published by each provider — see the flag at the top of this
          Notice about solicitor review.
        </p>

        <h2>7. Your rights</h2>
        <p>Under UK GDPR, you have the right to:</p>
        <ul>
          <li>be informed about how your data is used (this Notice);</li>
          <li>access a copy of your personal data;</li>
          <li>have inaccurate data corrected;</li>
          <li>
            have your data erased (&ldquo;right to be forgotten&rdquo;),
            subject to legal exceptions;
          </li>
          <li>restrict or object to certain processing;</li>
          <li>
            receive your data in a portable format, where processing is
            based on consent or contract and carried out by automated means;
          </li>
          <li>
            not be subject to solely automated decisions with legal or
            similarly significant effects (Relay does not make any such
            decisions about you); and
          </li>
          <li>
            complain to the Information Commissioner&rsquo;s Office (ICO) —{' '}
            <a
              href="https://ico.org.uk"
              target="_blank"
              rel="noreferrer"
            >
              ico.org.uk
            </a>
            , 0303 123 1113 — although we would appreciate the chance to
            resolve your concern directly first.
          </li>
        </ul>
        <p>
          To exercise a right, email{' '}
          <a href="mailto:info@coreframe-labs.dev">info@coreframe-labs.dev</a>
          . We will verify your identity before acting on a request and
          respond within one month (extendable to three months for complex
          requests, with an explanation).
        </p>
        <p>
          <strong>
            If your request concerns data inside a webhook payload processed
            through someone else&rsquo;s Route
          </strong>{' '}
          — i.e. you are the end-user of one of our business customers, not
          a Relay account holder yourself — we are a processor for that
          data, not the controller, and UK GDPR expects the request to go to
          the controller (our customer) in the first instance. Tell us who
          the relevant business is and we will either forward your request
          to them or assist them in responding to you directly, per our
          Data Processing Addendum.
        </p>

        <h2>8. Security</h2>
        <p>
          A summary of the technical measures protecting the data described
          above — the full commitments to business customers are in the{' '}
          <Link href="/dpa">Data Processing Addendum</Link>:
        </p>
        <ul>
          <li>
            Destination authentication headers you configure are encrypted
            at rest with AES-256-GCM, keyed per value, and are never
            returned by any API once set.
          </li>
          <li>
            <strong>Tenant isolation, stated honestly.</strong> Every query
            that reads or writes Route, delivery-log or dead-letter-queue
            data is written to filter by your team ID, and that scoping is
            what actually separates one customer&rsquo;s data from
            another&rsquo;s in production today. PostgreSQL Row-Level
            Security policies have also been created and enabled on all six
            of those tables in the production database, as a second,
            database-layer barrier &mdash; but as of this Notice&rsquo;s
            effective date, the production application has{' '}
            <strong>not yet</strong> been switched to the restricted
            database role those policies are designed to enforce against,
            so that second barrier is built and tested but not yet the
            thing actively stopping a cross-tenant query in production.
            Completing that switch is a named, outstanding operational
            action, tracked the same way ICO registration is at the top of
            this Notice. The application-level scoping, and the
            Row-Level Security policies&rsquo; correctness once the
            restricted role is in use, are both verified by an automated
            cross-tenant isolation test suite run as part of our release
            process.
          </li>
          <li>All traffic to and from the Service is encrypted in transit (TLS).</li>
          <li>
            Access to production infrastructure is limited to the
            company&rsquo;s director.
          </li>
        </ul>

        <h2>9. Changes to this Notice</h2>
        <p>
          We will update this Notice as Relay&rsquo;s architecture and
          sub-processor list change — most importantly, when an automated
          retention process ships (Section 4), when Sentry or Mixpanel is
          activated (Section 5), or when a new sub-processor is added
          (Section 5, Section 6). We will change the effective date at the
          top of this page when we do.
        </p>

        <h2>10. Who we are</h2>
        <p>
          Coreframe Labs Ltd, a company registered in England &amp; Wales.
          Contact for all privacy matters, including data protection
          requests: <a href="mailto:info@coreframe-labs.dev">info@coreframe-labs.dev</a>.
        </p>
      </LegalLayout>
    </>
  );
};

export default PrivacyPage;

PrivacyPage.getLayout = function getLayout(page: ReactElement) {
  return <>{page}</>;
};
