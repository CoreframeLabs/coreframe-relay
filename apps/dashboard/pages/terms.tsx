/**
 * [RELAY-79] Terms of Service.
 *
 * This is a competent, fact-grounded draft written from the actual product state
 * (`growth/product/relay-launch-sprint.md` §2.1/§2.2, `growth/product/design-panel/
 * engineering-lead-revenue-2026-08-19.md` §4, and the live Stripe wiring in
 * `scripts/create-n8n-wedge-price.mjs` / `components/billing/N8nWedgePaymentLink.tsx`
 * / `components/billing/LinkToPortal.tsx`), not a template filled in with placeholder
 * text. It is NOT a substitute for review by a solicitor qualified in England and
 * Wales before this product takes real money at any scale beyond the current
 * invite-only/early-access footing — see the commit message and the handoff note
 * for what specifically still needs a human lawyer's sign-off (in particular: the
 * £100/12-months-of-fees liability cap in Section 12, and confirmation that the
 * Stripe Customer Portal's live configuration actually matches the cancellation
 * behaviour described in the Refund and Cancellation Policy this page links to).
 *
 * Deliberately does NOT restate the Privacy Notice, DPA or sub-processor list —
 * those are `relay/legal-b`'s document (RELAY-80/81), drafted in a parallel
 * worktree. This page cross-links to `/privacy` (the confirmed route, per
 * `NEXT_PUBLIC_PRIVACY_URL` in `.env.example`) rather than duplicating its content,
 * so the two documents cannot drift out of sync with each other.
 */
import type { GetStaticPropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import Link from 'next/link';

import LegalPage, { legalGetLayout } from '@/components/legal/LegalPage';
import type { LegalSection } from '@/components/legal/LegalPage';
import type { NextPageWithLayout } from 'types';

const SECTIONS: LegalSection[] = [
  {
    id: 'acceptance',
    title: '1. Acceptance of these Terms',
    body: [
      <>
        These Terms of Service (&ldquo;Terms&rdquo;) are a legal agreement between
        you (&ldquo;Customer&rdquo;, &ldquo;you&rdquo;) and Coreframe Labs Ltd, a
        company registered in England and Wales (&ldquo;Coreframe&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;), governing your
        access to and use of Coreframe Relay, our webhook receipt, buffering,
        retry and dead-letter-queue service, together with the associated
        dashboard, API and documentation (the &ldquo;Service&rdquo;).
      </>,
      <>
        By creating an account, clicking to accept these Terms, or otherwise
        accessing or using the Service, you confirm that you have the authority
        to bind the individual or organisation on whose behalf you are acting,
        and you agree to these Terms and to our{' '}
        <Link
          href="/privacy"
          className="text-teal-300 underline underline-offset-2 hover:text-teal-200"
        >
          Privacy Notice
        </Link>
        , which is incorporated into these Terms by reference.
      </>,
      'If you do not agree to these Terms, do not create an account or use the Service.',
      <>
        The Service is intended for use by businesses and other organisations
        in connection with their own commercial or professional activities. It
        is not directed at, and should not be relied on by, consumers acting
        for purposes wholly outside a trade, business, craft or profession —
        see Section 15 for how this interacts with mandatory consumer
        protections.
      </>,
    ],
  },
  {
    id: 'the-service',
    title: '2. What Coreframe Relay does',
    body: [
      <>
        Coreframe Relay sits in front of a webhook destination you control. In
        outline: you create a route, we generate a unique ingest URL for that
        route, you point a sender (for example Stripe, Shopify, GitHub, or an
        automation platform such as n8n) at that URL instead of your
        destination, and the Service accepts the incoming request, records it,
        and forwards it on to the destination URL you configured — retrying on
        failure according to the route&rsquo;s retry policy and, where
        forwarding continues to fail, holding the request in a dead-letter
        queue (&ldquo;DLQ&rdquo;) for manual review and retry.
      </>,
      <>
        Current core functionality includes: email/password account creation
        with email verification; team creation; route creation with a
        configurable destination URL, retry policy and optional encrypted
        destination authentication headers; per-route ingest URLs that can be
        rotated; a delivery log showing the status of each received request; a
        DLQ with manual retry; and a built-in test/catcher endpoint for routes
        with no live destination yet.
      </>,
      <>
        We may add, change, suspend or remove features of the Service at any
        time. Where a change materially reduces functionality you are actively
        relying on, we will make reasonable efforts to give you advance
        notice.
      </>,
    ],
  },
  {
    id: 'not-guaranteed',
    title: '3. What is not guaranteed — please read this section',
    body: [
      'We would rather you knew the honest limits of the Service before you rely on it in production than discover them during an incident. The following are not guaranteed, and no other part of these Terms should be read as promising them:',
      <>
        <strong className="text-[#f2f3f5]">
          No uptime or availability commitment.
        </strong>{' '}
        We do not currently offer a service level agreement (SLA), a public
        status page, or any service credit or compensation scheme for
        downtime. The Service is provided on a reasonable-endeavours basis by
        a very small team.
      </>,
      <>
        <strong className="text-[#f2f3f5]">
          At-least-once delivery, not exactly-once.
        </strong>{' '}
        The Service retries a delivery until it succeeds or is moved to the
        DLQ, which means the same webhook payload can, in some circumstances
        (for example a retry racing a slow response from your destination), be
        delivered to your destination more than once. Your own destination
        handler is responsible for de-duplicating deliveries, for example
        using a request or idempotency identifier.
      </>,
      <>
        <strong className="text-[#f2f3f5]">A payload size limit applies.</strong>{' '}
        Incoming requests above a size cap (currently 1 MiB) are rejected at
        the point of receipt and are not buffered.
      </>,
      <>
        <strong className="text-[#f2f3f5]">
          DLQ retries are best-effort recovery, not a guaranteed replay of the
          original request.
        </strong>{' '}
        When a request is manually retried from the DLQ, the Service
        reconstructs and re-sends the payload to your destination, but it may
        not always be able to preserve every original request header. In
        particular, signature headers some senders use to authenticate a
        webhook (for example a Stripe, GitHub or Shopify signing header) may
        not be present on a DLQ retry, and a destination that verifies such a
        header may reject the retried request. Where this limitation applies,
        we say so in the product itself, at the point you initiate a retry.
        Treat DLQ retry as a recovery aid, not as a substitute for fixing the
        underlying delivery failure.
      </>,
      'We do not support Meta/WhatsApp’s webhook verification handshake. Do not rely on the Service for Meta-originated webhook sources that require it.',
      'Support is provided by one person, on a reasonable-endeavours basis, with no committed response times or support hours.',
      'Nothing in this section limits the specific liability provisions in Section 12; it exists so the limits of the Service are stated plainly, rather than discovered under pressure.',
    ],
  },
  {
    id: 'accounts',
    title: '4. Accounts and teams',
    body: [
      'You must provide accurate information when creating an account and keep your login credentials confidential. You are responsible for all activity that occurs under your account and team, including activity by anyone you invite. Notify us promptly at info@coreframe-labs.dev if you believe your account has been compromised.',
      'You must be legally capable of entering into a binding contract to create an account. We may refuse, suspend or terminate an account that we reasonably believe was created in breach of these Terms.',
    ],
  },
  {
    id: 'fees',
    title: '5. Fees and payment',
    body: [
      <>
        Coreframe Relay currently offers a single flat-rate monthly
        subscription plan, billed and processed by Stripe, with no
        usage-based metering, no tiered pricing, and no annual commitment. The
        current price is shown at checkout before you pay. We may make some
        account and Service functionality available without charge from time
        to time, including during an early-access phase; this does not create
        any ongoing entitlement to free access, and we may begin charging for
        previously free functionality on reasonable notice.
      </>,
      'Fees are billed in advance for each monthly billing period and, unless you cancel, renew automatically each month until cancelled. You authorise us (via Stripe) to charge your payment method for each renewal. All fees are exclusive of VAT and other applicable taxes, which will be added where required by law.',
      <>
        Our position on refunds and cancellation is set out in full in our
        separate{' '}
        <Link
          href="/refund-policy"
          className="text-teal-300 underline underline-offset-2 hover:text-teal-200"
        >
          Refund and Cancellation Policy
        </Link>
        , which forms part of these Terms.
      </>,
    ],
  },
  {
    id: 'acceptable-use',
    title: '6. Acceptable use',
    body: [
      'You must not use the Service to receive, buffer, forward or store: content that is unlawful, fraudulent, or infringes a third party’s rights; malware or content intended to disrupt, damage or gain unauthorised access to any system; special-category or otherwise highly sensitive personal data that the Service was not designed to handle securely at the volume or sensitivity you intend, without first discussing this with us; or content in breach of sanctions, export control or similar law.',
      'You must not: attempt to bypass, probe or defeat the Service’s rate limits, size limits or access controls; use the Service to send or facilitate unsolicited bulk communications; attempt to gain unauthorised access to another customer’s account, team, routes or data; reverse engineer, decompile, or attempt to extract source code from the Service, except to the extent this restriction is not permitted by applicable law; or resell, sublicense or offer the Service to third parties as your own hosted product without our prior written agreement.',
      <>
        You are responsible for the lawfulness, accuracy and content of
        anything you configure the Service to receive or forward, and for
        having any rights or consents needed for that data to pass through the
        Service and to your chosen destination and our sub-processors (see
        our{' '}
        <Link
          href="/privacy"
          className="text-teal-300 underline underline-offset-2 hover:text-teal-200"
        >
          Privacy Notice
        </Link>{' '}
        for the current list).
      </>,
    ],
  },
  {
    id: 'customer-data',
    title: '7. Your data and intellectual property',
    body: [
      'As between you and us, you retain all rights, title and interest in and to the webhook payloads, configuration and other data you submit to or route through the Service (“Customer Data”). We do not claim ownership of Customer Data.',
      <>
        In relation to Customer Data that constitutes personal data, we act as
        a data processor on your instructions, and you act as controller (or,
        where applicable, processor) in respect of your own end customers&rsquo;
        data. Our processing terms, sub-processors and any international
        transfer arrangements are set out in our Data Processing Addendum and{' '}
        <Link
          href="/privacy"
          className="text-teal-300 underline underline-offset-2 hover:text-teal-200"
        >
          Privacy Notice
        </Link>
        , both incorporated into these Terms by reference. The Data Processing
        Addendum is available on request at info@coreframe-labs.dev while it
        is finalised.
      </>,
      'We and our licensors retain all rights, title and interest in and to the Service itself, including the software, infrastructure, branding and documentation, excluding Customer Data. Subject to your compliance with these Terms, we grant you a limited, non-exclusive, non-transferable licence to access and use the Service during your subscription, solely for your own internal business purposes.',
      'Any feedback or suggestions you give us about the Service may be used by us without restriction or obligation to you.',
    ],
  },
  {
    id: 'confidentiality',
    title: '8. Confidentiality',
    body: [
      'Each party may receive confidential information of the other in connection with the Service. Each party agrees to use the other’s confidential information only to perform its obligations or exercise its rights under these Terms, and to protect it using at least the same care it uses for its own confidential information of similar importance, and no less than reasonable care. This section does not apply to information that is or becomes public other than by breach of these Terms, was already known to the receiving party without an obligation of confidence, or is required to be disclosed by law.',
    ],
  },
  {
    id: 'suspension-termination',
    title: '9. Suspension and termination',
    body: [
      <>
        You may stop using the Service and, where you hold a paid
        subscription, cancel it at any time as described in our{' '}
        <Link
          href="/refund-policy"
          className="text-teal-300 underline underline-offset-2 hover:text-teal-200"
        >
          Refund and Cancellation Policy
        </Link>
        .
      </>,
      'We may suspend or restrict your access to the Service, in whole or in part, with notice where reasonably practicable, if: you materially breach these Terms, including the acceptable use provisions in Section 6; your account is overdue on payment; we reasonably believe your use of the Service poses a security, legal or operational risk to us or to other customers; or we are required to do so by law or by a request from a competent authority. We will aim to give advance notice except where we reasonably believe immediate action is necessary.',
      'We may terminate these Terms and your account on reasonable notice (we currently treat 30 days as reasonable notice for a termination for convenience, and will honour a longer period if we have separately agreed one with you in writing), or immediately for a material breach that you fail to remedy within 14 days of being notified of it.',
      'On termination, your right to access the Service ends. We will retain and delete Customer Data in accordance with our Privacy Notice; you should export or note anything you need before your access ends, as we cannot guarantee the ability to retrieve Customer Data after termination.',
      'Sections of these Terms that by their nature should survive termination — including Sections 3 (What is not guaranteed), 7 (Your data and intellectual property), 8 (Confidentiality), 11 (Disclaimers), 12 (Limitation of liability), 13 (Indemnity) and 15 (Governing law) — survive termination.',
    ],
  },
  {
    id: 'third-party',
    title: '10. Third-party services and sub-processors',
    body: [
      <>
        The Service is built on infrastructure and platform providers,
        including hosting, database, message-queue, network/proxy and
        transactional-email providers. A current list of sub-processors,
        including any that involve a transfer of personal data outside the UK,
        is published in our{' '}
        <Link
          href="/privacy"
          className="text-teal-300 underline underline-offset-2 hover:text-teal-200"
        >
          Privacy Notice
        </Link>
        , which we will keep up to date and notify you of material changes to
        where required by law.
      </>,
    ],
  },
  {
    id: 'warranty-disclaimer',
    title: '11. Disclaimers',
    body: [
      'To the maximum extent permitted by law, the Service is provided “as is” and “as available”, without warranties of any kind, whether express, implied or statutory, including implied warranties of satisfactory quality, fitness for a particular purpose, and non-infringement. We do not warrant that the Service will be uninterrupted, error-free, secure, or that every webhook will be delivered exactly once or within any particular time — see Section 3.',
      'Nothing in these Terms excludes or limits our liability for fraud, for death or personal injury caused by our negligence, or for any other liability that cannot be excluded or limited under English law.',
    ],
  },
  {
    id: 'liability',
    title: '12. Limitation of liability',
    body: [
      'To the maximum extent permitted by law: neither party will be liable to the other for any indirect, special, incidental or consequential loss, or for any loss of profits, revenue, business, contracts, anticipated savings, or loss or corruption of data, in each case whether or not such loss was foreseeable and even if the party was advised of the possibility of it.',
      'Subject to the paragraph above and to Section 11, our total aggregate liability to you arising out of or in connection with these Terms or the Service, whether in contract, tort (including negligence) or otherwise, will not exceed the greater of (a) the total fees you paid us for the Service in the 12 months before the event giving rise to the claim, and (b) £100.',
      'This cap reflects the price of the Service and the fact that it is offered without an uptime or delivery SLA. If you need a higher liability commitment or an SLA, contact us to discuss a separate written agreement before relying on the Service for a use case where that matters.',
    ],
  },
  {
    id: 'indemnity',
    title: '13. Indemnity',
    body: [
      'You agree to indemnify and hold us harmless against any claims, losses, liabilities, damages and reasonable costs (including legal fees) arising from: your breach of these Terms, including the acceptable use provisions; Customer Data or your use of the Service infringing a third party’s rights or applicable law; or a claim by one of your own customers or end users in connection with data you routed through the Service.',
    ],
  },
  {
    id: 'changes',
    title: '14. Changes to these Terms',
    body: [
      'We may update these Terms from time to time, for example to reflect changes to the Service, legal or regulatory requirements, or our business. Where a change is material, we will provide reasonable notice — for example by email to the address on your account, or a notice within the dashboard — before it takes effect. Continued use of the Service after a change takes effect constitutes acceptance of the updated Terms. If you do not agree to a material change, you should stop using the Service and, if applicable, cancel your subscription before the change takes effect.',
    ],
  },
  {
    id: 'governing-law',
    title: '15. Governing law and jurisdiction',
    body: [
      'These Terms, and any dispute or claim arising out of or in connection with them or the Service (including non-contractual disputes or claims), are governed by the laws of England and Wales. The courts of England and Wales have exclusive jurisdiction, save that we may seek injunctive or other equitable relief in any competent jurisdiction to protect our intellectual property or confidential information.',
      'If you are contracting from outside the UK, mandatory local consumer-protection law may still apply to the extent the Service is used other than for your trade, business, craft or profession, notwithstanding the business-use statement in Section 1 — nothing in these Terms is intended to exclude a protection you cannot lawfully waive. If you are an EU-established customer, EU GDPR may separately apply to our processing of your account or Customer Data alongside UK GDPR; see our Privacy Notice.',
    ],
  },
  {
    id: 'general',
    title: '16. General',
    body: [
      <>
        <strong className="text-[#f2f3f5]">Entire agreement.</strong> These
        Terms, together with our Privacy Notice, Data Processing Addendum
        (where applicable) and Refund and Cancellation Policy, are the entire
        agreement between you and us regarding the Service and supersede any
        prior discussions or agreements on the subject, except where we have a
        separate signed written agreement with you that expressly overrides
        them.
      </>,
      <>
        <strong className="text-[#f2f3f5]">Severability.</strong> If any
        provision of these Terms is found unenforceable, the remaining
        provisions continue in effect, and the unenforceable provision will be
        replaced with one that most closely achieves its intended effect.
      </>,
      <>
        <strong className="text-[#f2f3f5]">No waiver.</strong> A failure to
        enforce any provision of these Terms is not a waiver of our right to
        do so later.
      </>,
      <>
        <strong className="text-[#f2f3f5]">Assignment.</strong> You may not
        assign or transfer these Terms without our prior written consent. We
        may assign these Terms in connection with a merger, acquisition, or
        sale of substantially all of our assets, on notice to you.
      </>,
      <>
        <strong className="text-[#f2f3f5]">Force majeure.</strong> Neither
        party is liable for a failure or delay in performance caused by events
        beyond its reasonable control, including failures of our third-party
        infrastructure providers.
      </>,
      <>
        <strong className="text-[#f2f3f5]">Notices.</strong> Notices to us
        should be sent to info@coreframe-labs.dev. Notices to you may be sent
        to the email address on your account.
      </>,
    ],
  },
  {
    id: 'contact',
    title: '17. Contact',
    body: [
      'Coreframe Labs Ltd, a company registered in England and Wales. Questions about these Terms: info@coreframe-labs.dev.',
    ],
  },
];

const TermsPage: NextPageWithLayout = () => (
  <LegalPage
    eyebrow="Legal"
    title="Terms of Service"
    lastUpdated="19 August 2026"
    metaTitle="Terms of Service — Coreframe Relay"
    metaDescription="The terms governing your use of Coreframe Relay, including what the Service does, what is not guaranteed, fees, acceptable use, and liability."
    intro={
      <p>
        This document governs your use of Coreframe Relay. It is written to
        match what the product actually does today, including the things it
        does not yet do — see Section 3 in particular before you rely on
        the Service in production.
      </p>
    }
    sections={SECTIONS}
  />
);

export const getStaticProps = async ({ locale }: GetStaticPropsContext) => {
  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
};

TermsPage.getLayout = legalGetLayout;

export default TermsPage;
