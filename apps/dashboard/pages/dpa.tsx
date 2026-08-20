/**
 * [RELAY-81] Data Processing Addendum (DPA) — the Art. 28 UK GDPR contract governing
 * how Coreframe Labs Ltd (processor) handles personal data flowing through a business
 * customer's (controller's) webhook payloads.
 *
 * Grounded the same way `pages/privacy.tsx` is: sub-processor list and security
 * measures come from `growth/product/relay-launch-decisions.md` #7,
 * `relay-launch-sprint.md` §2.2, `prisma/schema.prisma` and
 * `lib/relay/destinationAuth.ts` — not invented. Audit rights and breach-notification
 * commitments are scoped to what a one-person company can actually deliver, not an
 * enterprise programme this company doesn't have.
 *
 * THIS IS A COMPETENT DRAFT GROUNDED IN THE REAL SYSTEM, NOT A SUBSTITUTE FOR
 * SOLICITOR REVIEW before this is relied on at real volume or against an
 * enterprise counterparty's own procurement paper. Coreframe Labs Ltd has also NOT
 * YET registered with the ICO (statutory data-protection fee, ~£40-£52/year) as of
 * this document's effective date — a director action independent of this DPA
 * existing.
 *
 * CORRECTED ON REVIEW (2026-08-20): an earlier draft of Section 4's "Tenant isolation"
 * bullet claimed Row-Level Security "is configured and enforced" at the database
 * layer. Checked against `relay-launch-decisions.md` #9 and the RELAY-39/RELAY-83
 * entries in `relay-dev-log.md`/`relay-sprint-plan.md`: the policies exist and are
 * enabled in production, but the production app still connects via the `postgres`
 * role (`rolbypassrls=true`), which bypasses them — the switch to the restricted
 * `relay_app` role is a named, not-yet-taken director action (RELAY-39 status:
 * BLOCKED). Section 4 now states that today's actual barrier is application-level
 * scoping, with RLS as a built-but-not-yet-live second layer. Re-check before this
 * DPA's next effective-date bump.
 *
 * No dedicated NEXT_PUBLIC_DPA_URL existed in `.env.example` before this change; added
 * alongside NEXT_PUBLIC_PRIVACY_URL/NEXT_PUBLIC_TERMS_URL for the same reason those
 * exist, and this page is served at the path it points to.
 */
import type { ReactElement } from 'react';
import Head from 'next/head';
import Link from 'next/link';

import { LegalLayout } from '@/components/legal/LegalLayout';
import type { NextPageWithLayout } from 'types';

const EFFECTIVE_DATE = '19 August 2026';

const DpaPage: NextPageWithLayout = () => {
  return (
    <>
      <Head>
        <title>Data Processing Addendum — Coreframe Relay</title>
        <meta
          name="description"
          content="The Art. 28 UK GDPR contract governing how Coreframe Labs Ltd processes personal data flowing through a customer's webhook payloads."
        />
      </Head>

      <LegalLayout
        title="Data Processing Addendum"
        effectiveDate={EFFECTIVE_DATE}
      >
        <p>
          This Data Processing Addendum (&ldquo;<strong>DPA</strong>
          &rdquo;) is entered into between{' '}
          <strong>Coreframe Labs Ltd</strong> (&ldquo;
          <strong>Processor</strong>&rdquo;, &ldquo;we&rdquo;), a company
          registered in England &amp; Wales, and the business identified on
          the Coreframe Relay account it applies to (&ldquo;
          <strong>Controller</strong>&rdquo;, &ldquo;you&rdquo;). It applies
          automatically to every customer processing personal data through
          Coreframe Relay (the &ldquo;<strong>Service</strong>&rdquo;) and is
          incorporated into, and forms part of, the Terms of Service. It
          governs Processor&rsquo;s processing of personal data contained in
          the webhook payloads Controller routes through the Service on
          Controller&rsquo;s behalf (&ldquo;<strong>Customer Data</strong>
          &rdquo;). It does not cover Coreframe&rsquo;s processing of your
          own Relay account data (your name, email, team) — that is
          described in the <Link href="/privacy">Privacy Notice</Link>, where
          Coreframe is the controller.
        </p>
        <p>
          If you want a signed, countersigned copy of this DPA for your own
          procurement records, email{' '}
          <a href="mailto:info@coreframe-labs.dev">info@coreframe-labs.dev</a>{' '}
          and we will provide one; a separate signature is not required for
          this DPA to apply to your use of the Service.
        </p>

        <h2>1. Subject matter, duration and nature of processing</h2>
        <p>
          <strong>Subject matter:</strong> the receipt, queuing, retry,
          logging and — for permanently failed deliveries only — temporary
          storage of webhook payloads submitted to a Route Controller
          configures within the Service.
        </p>
        <p>
          <strong>Duration:</strong> for as long as Controller has an active
          Route configured to receive the relevant traffic, and thereafter
          only for as long as any already-stored Customer Data remains
          undeleted (see Section 8, Retention and deletion).
        </p>
        <p>
          <strong>Nature and purpose:</strong> Processor operates
          infrastructure that (a) accepts an inbound HTTP request at a
          Controller-configured ingest URL, (b) queues it for delivery to a
          Controller-configured destination, (c) retries delivery on
          failure according to Controller-configured retry settings, (d)
          records delivery metadata (see Section 3) so Controller can
          monitor delivery health, and (e) for deliveries that permanently
          fail, retains the payload so Controller can inspect and manually
          replay it. Processor does not process Customer Data for any
          purpose of its own — see Section 2.
        </p>

        <h2>2. Processor obligations</h2>
        <p>Processor shall:</p>
        <ul>
          <li>
            process Customer Data only on Controller&rsquo;s documented
            instructions — which are, for the avoidance of doubt, the Route
            configuration Controller sets within the Service (destination
            URL, retry policy, any destination authentication headers) —
            unless required to do otherwise by UK law, in which case
            Processor will inform Controller before processing, unless that
            law prohibits it;
          </li>
          <li>
            ensure persons authorised to process Customer Data are subject
            to confidentiality obligations;
          </li>
          <li>
            implement appropriate technical and organisational security
            measures (Section 4);
          </li>
          <li>
            engage sub-processors only as permitted under Section 5, and
            flow down equivalent data protection obligations to each;
          </li>
          <li>
            assist Controller, taking into account the nature of the
            processing, in responding to requests from data subjects
            exercising their UK GDPR rights (Section 6);
          </li>
          <li>
            assist Controller with its own security, breach-notification
            and data protection impact assessment obligations, to the
            extent Processor holds information Controller needs and
            Controller could not reasonably obtain itself (Section 7);
          </li>
          <li>
            at Controller&rsquo;s choice, delete or return Customer Data at
            the end of the relationship, subject to Section 8; and
          </li>
          <li>
            make available the information reasonably necessary to
            demonstrate compliance with this DPA and allow for audits as
            described in Section 9.
          </li>
        </ul>

        <h2>3. Categories of data and data subjects</h2>
        <p>
          Controller determines what Customer Data exists by what it
          chooses to route through the Service — Processor does not select,
          filter or interpret payload content. Typically this is data
          Controller&rsquo;s own upstream systems (e.g. Stripe, Shopify, the
          WhatsApp Business API) send about Controller&rsquo;s own customers
          or end-users: names, email addresses, phone numbers, order and
          payment metadata (not raw card numbers, which never transit
          Processor&rsquo;s infrastructure via these integrations), shipping
          addresses, or message content. Data subjects are Controller&rsquo;s
          customers, end-users or other individuals Controller&rsquo;s
          upstream systems reference — not Processor&rsquo;s own personnel
          or contacts.
        </p>
        <p>
          As described in the Privacy Notice Section 3, Processor&rsquo;s
          delivery log stores metadata about a delivery attempt (request ID,
          sender IP, status, attempt count, response code, latency, payload
          size in bytes) rather than payload content for successfully
          delivered webhooks. Payload content is retained only for
          deliveries that permanently fail, in the dead-letter queue, so
          Controller can review and manually retry them.
        </p>

        <h2>4. Security measures</h2>
        <p>
          Measures actually in place today, stated at the level of
          specificity we can stand behind rather than a generic checklist:
        </p>
        <ul>
          <li>
            <strong>Encryption of destination credentials at rest.</strong>{' '}
            Any authentication header value Controller configures for a
            destination is encrypted with AES-256-GCM before it is written
            to the database, keyed per header value with a random
            initialisation vector, and is decrypted only at the moment of
            forwarding a request. No API, including ones Processor
            controls, ever returns a stored header value — only its name.
          </li>
          <li>
            <strong>Tenant isolation, stated honestly.</strong> Every
            relevant handler is written to filter Route, delivery-log and
            dead-letter-queue queries by the requesting team&rsquo;s ID, and
            that application-level scoping is what actually separates one
            Controller&rsquo;s Customer Data from another&rsquo;s in
            production today. PostgreSQL Row-Level Security policies have
            also been created and enabled on all six of those tables in the
            production database, as a second, database-layer barrier
            designed to enforce the same restriction independently of
            application code &mdash; but as of this DPA&rsquo;s effective
            date, the production application has <strong>not yet</strong>{' '}
            been switched to the restricted database role those policies
            are designed to enforce against, so that second barrier is
            built and tested but not yet the thing actively stopping a
            cross-tenant query in production. Completing that database-role
            switch is a named, outstanding operational action; Controller
            may request its current status by contacting us (Section 12).
            The application-level scoping, and the Row-Level Security
            policies&rsquo; correctness once the restricted role is in use,
            are both verified by an automated cross-tenant isolation test
            suite exercised as part of Processor&rsquo;s release process.
          </li>
          <li>
            <strong>Encryption in transit.</strong> All traffic to and from
            the Service, including inbound webhook delivery and dashboard
            access, is served over TLS.
          </li>
          <li>
            <strong>Access control.</strong> Production infrastructure
            (hosting, database, DNS, queue) is administered solely by
            Processor&rsquo;s director; there is no separate operations
            team with standing production access.
          </li>
          <li>
            <strong>Credential handling.</strong> Infrastructure credentials
            are held as environment secrets, not committed to source
            control, and rotated when there is reason to believe one may
            have been exposed.
          </li>
        </ul>
        <p>
          <strong>Stated limit, not hidden:</strong> Processor is a
          single-person company. There is no dedicated security team, no 24/7
          on-call rotation, and no formal ISO 27001 or SOC 2 certification.
          If that level of assurance is a requirement for your organisation,
          say so before relying on this DPA — we would rather you know that
          now than discover it during your own audit.
        </p>

        <h2>5. Sub-processors</h2>
        <p>Processor currently uses the following sub-processors:</p>
        <table>
          <thead>
            <tr>
              <th>Sub-processor</th>
              <th>Purpose</th>
              <th>Location</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Vercel Inc.</td>
              <td>Application hosting</td>
              <td>United States</td>
            </tr>
            <tr>
              <td>Supabase</td>
              <td>Primary database</td>
              <td>eu-west-2 (London, UK)</td>
            </tr>
            <tr>
              <td>Upstash (QStash)</td>
              <td>Delivery queue and retry orchestration</td>
              <td>United States / EU</td>
            </tr>
            <tr>
              <td>Cloudflare, Inc.</td>
              <td>Reverse proxy, DNS and edge network at ingest</td>
              <td>Global edge network / United States</td>
            </tr>
            <tr>
              <td>Resend</td>
              <td>Transactional email (does not carry Customer Data)</td>
              <td>ap-northeast-1 (Tokyo, Japan)</td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>General authorisation and the right to object.</strong>{' '}
          Controller gives Processor general authorisation to engage the
          sub-processors above, and any future sub-processor, subject to
          this clause: Processor will notify Controller — by email to the
          address on Controller&rsquo;s account, or an equivalent in-product
          notice — of any intended addition or replacement of a
          sub-processor that will process Customer Data, at least{' '}
          <strong>14 days</strong> before the change takes effect. Controller
          may object on reasonable data-protection grounds within that
          window by emailing{' '}
          <a href="mailto:info@coreframe-labs.dev">info@coreframe-labs.dev</a>
          . If Processor cannot address the objection with a change that
          resolves it, either party may terminate the affected part of the
          Service without penalty. Processor remains liable for each
          sub-processor&rsquo;s performance of its data protection
          obligations to the same extent Processor would be liable for
          performing those obligations itself.
        </p>

        <h2>6. Assistance with data subject requests</h2>
        <p>
          If Processor receives a request from an individual concerning
          Customer Data (for example, someone identifying themselves as one
          of Controller&rsquo;s customers), Processor will, without undue
          delay, either forward the request to Controller or assist
          Controller in responding, and will not respond to the individual
          directly except to confirm the request has been forwarded, unless
          Controller instructs otherwise or Processor is legally required to
          respond. Controller remains responsible for determining how to
          respond to the individual, since Controller is the controller of
          that data.
        </p>

        <h2>7. Personal data breach notification</h2>
        <p>
          Processor will notify Controller <strong>without undue delay</strong>{' '}
          and in any event <strong>within 72 hours</strong> of becoming aware
          of a confirmed personal data breach affecting Customer Data, by
          email to the address on Controller&rsquo;s account — the fastest
          channel available given Processor is a single-person operation
          without a dedicated incident-response function. The notification
          will describe, to the extent then known: the nature of the
          breach, the categories and approximate number of data subjects and
          records concerned, the likely consequences, and the measures taken
          or proposed to address it. Processor will update Controller as
          material new information becomes available, since a first
          notification inside 72 hours will not always be complete.
        </p>

        <h2>8. Retention and deletion</h2>
        <p>
          As set out plainly in the Privacy Notice: Processor does not
          currently operate an automated process that deletes Customer Data
          on a schedule. Customer Data is retained until Controller deletes
          it (via the dashboard&rsquo;s dead-letter-queue management
          features), Controller&rsquo;s account is deleted, or Controller
          requests deletion directly.
        </p>
        <p>
          On termination of Controller&rsquo;s use of the Service, Processor
          will, within <strong>30 days</strong> of Controller&rsquo;s written
          request, delete all Customer Data held in delivery-log and
          dead-letter-queue storage, or — if Controller requests it in
          writing before that 30-day window closes — export it to
          Controller in a structured format first and then delete it,
          except to the extent retention is required by UK law.
        </p>

        <h2>9. Audit rights</h2>
        <p>
          Sized to what a one-person company can actually deliver, not an
          enterprise programme Processor does not have: no more than once
          in any 12-month period, Controller may request a written summary
          of the security measures described in Section 4, together with
          reasonable supporting evidence (for example, the result of the
          cross-tenant isolation test suite referenced there). Processor
          will provide a response to a reasonable written questionnaire
          within a reasonable time. Processor does not currently offer an
          on-site audit, a third-party penetration-test report, or a formal
          certification (ISO 27001, SOC 2) — if your organisation requires
          one of those as a condition of processing, tell us before relying
          on this DPA rather than after.
        </p>

        <h2>10. International transfers</h2>
        <p>
          Where a sub-processor in Section 5 is located outside the UK, the
          transfer safeguard applied is the one described in the{' '}
          <Link href="/privacy">Privacy Notice</Link>, Section 6 (International
          transfers) — in summary, UK adequacy regulations for Japan
          (Resend) as the primary basis with the UK International Data
          Transfer Addendum incorporated as a fallback, and the UK
          International Data Transfer Addendum (or the UK extension to the
          EU-US Data Privacy Framework, where applicable) for United States
          sub-processors (Vercel).
        </p>

        <h2>11. Liability and governing law</h2>
        <p>
          This DPA is governed by the laws of England &amp; Wales, on the
          same terms as the Terms of Service into which it is incorporated.
          Nothing in this DPA expands either party&rsquo;s liability beyond
          what the Terms of Service set out.
        </p>

        <h2>12. Contact</h2>
        <p>
          Data protection queries relating to this DPA:{' '}
          <a href="mailto:info@coreframe-labs.dev">info@coreframe-labs.dev</a>
          .
        </p>
      </LegalLayout>
    </>
  );
};

export default DpaPage;

DpaPage.getLayout = function getLayout(page: ReactElement) {
  return <>{page}</>;
};
