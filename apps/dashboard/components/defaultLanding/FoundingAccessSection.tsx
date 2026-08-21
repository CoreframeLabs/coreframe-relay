/**
 * [Launch-shape change] Founding Access — replaces PricingSection wholesale.
 *
 * `growth/product/relay-launch-decisions.md` (#1, #2) and `relay-launch-sprint.md` §0
 * conclude a paid, card-up-front, 14-day-trial launch is <5% achievable by 2026-08-19:
 * event metering, tier-limit enforcement, log retention/reaping and the trial timer are
 * all sold on the old copy and NONE exist as code (RELAY-75/76/77/78, all TODO). Stripe
 * itself is untouched — blank key, no Products, no Prices. The working default for this
 * week is a FREE "Founding Access" launch instead: no card, no billing, the real pipeline.
 * This is not yet a director-signed decision (the sheet is "Status: Awaiting signature"),
 * it is what the sprint plan targets and what this section is built toward.
 *
 * Gone entirely, per the sprint's H2 gate condition ("the page does not sell metering,
 * caps, retention tiers, trials or Gate/Shield as shipped"): £99/mo as a live price,
 * card-up-front, the 14-day trial, "nothing charged until day 14", the day-12 warning,
 * "the Pro subscription starts and the card is charged £99", and hard-capped-overage
 * copy. £99/mo survives only as a future anchor, explicitly not-yet-live, alongside the
 * Hookdeck US$39–US$499 comparison (real, kept — `relay-buffer-sales-motion.md` §1).
 *
 * LimitsSection's facts survive here, correctly scoped, inside the honesty <details>:
 * the 1 MiB payload cap and (until 2026-08-21, when this comment and the copy below were
 * corrected) the DLQ-cannot-replay-original-headers limitation. RELAY-65 (merged
 * 2026-08-19/20) fixed that: DLQ retry now replays the original request headers, so a
 * signed webhook (Stripe-Signature etc.) survives a replay. The one remaining edge case —
 * DLQ rows written before RELAY-65 shipped have no headers to replay — is per-row, not a
 * standing product limitation, and the confirm dialog already states it that way. The
 * at-least-once caveat is also kept there, load-bearing per the original brief.
 *
 * On capping/invite-only: `relay-launch-decisions.md` #1 recommends invite-only, and
 * decision #2 in the sprint plan (D2 action 4) is to pick a cap number and an
 * enforcement mechanism — neither has happened. Checked against the actual signup path
 * (`apps/dashboard/pages/auth/join.tsx` → `components/auth/Join.tsx` →
 * `pages/api/auth/join.ts`): signup today is open self-serve by email/password/team, no
 * invite token required unless one is supplied in the URL, and no cap check anywhere in
 * the handler (RELAY-88, cap enforcement, is unbuilt). So this page does NOT claim an
 * enforced cap or an invite-code gate — that would be exactly the kind of unbacked claim
 * this whole page exists to avoid. If RELAY-88 ships, revisit this copy.
 */
import Link from 'next/link';

import {
  Card,
  Eyebrow,
  LandingLink,
  Section,
  SectionHeading,
  focusRing,
} from './LandingPrimitives';

const included = [
  'Real webhook receipt, retry with backoff, and a delivery log — the same pipeline every tier will run on',
  'DLQ replay by hand for anything that permanently fails',
  'Destination auth headers encrypted at rest (AES-256-GCM)',
  'Unlimited routes — nothing meters or caps a path today (see below)',
];

const whyFree = [
  'Event metering, tier caps, log retention tiers and a trial timer are not built. None of the four exist as code yet, so nothing here can be honestly metered or billed.',
  'Charging for a promise the software can’t yet keep is worse than not charging. Founding Access removes the promise instead of faking the enforcement.',
  'Support is one person, best effort, no stated hours.',
];

const FoundingAccessSection = () => (
  <Section id="founding-access">
    <SectionHeading
      eyebrow="Founding Access"
      title="Founding Access — free while we're onboarding the first teams."
      lede="No card, nothing charged. Buffer is built and running; pricing arrives once usage-based billing ships. This is the honest state of the product, not an introductory discount."
    />

    <div className="mt-10 grid gap-4 lg:grid-cols-5">
      {/* The anchor */}
      <Card className="relay-reveal lg:col-span-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-4xl font-semibold tracking-tight text-landing-primary">
            Free
            <span className="text-base font-medium text-landing-secondary">
              {' '}
              during Founding Access
            </span>
          </p>
          <p className="font-mono text-xs text-landing-secondary">no card · nothing charged</p>
        </div>

        <p className="mt-4 text-sm font-medium text-landing-primary">
          Founding Access runs on the real pipeline, not a sandbox.
        </p>

        <ul className="mt-5 space-y-2">
          {included.map((item) => (
            <li key={item} className="flex items-start gap-2 text-sm text-landing-secondary">
              <span
                aria-hidden="true"
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-landing-accent"
              />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        {/* The Hookdeck line and the pricing anchor: £99/mo is named as where the
            ladder eventually sits, explicitly not live yet. */}
        <p className="mt-6 border-t border-landing-border pt-4 text-sm leading-relaxed text-landing-secondary">
          Pricing lands once usage-based billing ships. The anchor is{' '}
          <span className="text-landing-primary">£99/mo flat</span> — Hookdeck runs
          US$39 to US$499 a month for the same category, and Relay would
          invoice in GBP with onboarding included.{' '}
          <span className="text-landing-primary">
            Founding teams get in before that ladder is fixed in Stripe.
          </span>
        </p>
      </Card>

      {/* Why it's free right now, in place of the old trial-mechanics card. */}
      <Card className="relay-reveal lg:col-span-2">
        <Eyebrow>Why it&apos;s free right now</Eyebrow>
        <ul className="space-y-4">
          {whyFree.map((reason) => (
            <li key={reason} className="text-sm leading-relaxed text-landing-secondary">
              {reason}
            </li>
          ))}
        </ul>
      </Card>
    </div>

    {/* Honesty disclosure — collapsed on purpose, not a permanently-visible card.
        Load-bearing: the at-least-once caveat and the DLQ header limitation must
        not be deleted. LimitsSection's two facts (payload cap, DLQ headers) live
        here now that LimitsSection itself is gone. */}
    <details className="relay-reveal mx-auto mt-10 max-w-3xl text-left">
      <summary
        className={`inline-flex w-full cursor-pointer list-none items-center justify-center gap-2 rounded px-3 py-2 text-center text-sm font-medium text-landing-accent-text transition-colors hover:text-landing-accent-text-hover [&::-webkit-details-marker]:hidden ${focusRing}`}
      >
        What Founding Access doesn&apos;t include yet →
      </summary>
      <Card className="mt-3">
        <ul className="space-y-4 text-sm leading-relaxed text-landing-secondary">
          <li>
            <span className="font-semibold text-landing-primary">
              Delivery is at-least-once.
            </span>{' '}
            &quot;at-least-once delivery — your handler has to make it
            exactly-once&quot;. A sender that retries will deliver the same
            event again, and Relay will faithfully pass it on both times;
            deduplication stays in your handler. Every attempt rides one
            requestId, so a duplicate is visible, never hidden.
          </li>
          <li>
            <span className="font-semibold text-landing-primary">
              Your endpoint&apos;s own bugs.
            </span>{' '}
            Relay will deliver a webhook your handler mishandles, log the 4xx,
            and land it in the dead letter queue. It cannot make the handler
            correct.
          </li>
          <li>
            <span className="font-semibold text-landing-primary">
              A payload over 1 MiB.
            </span>{' '}
            Over-cap bodies are refused with a 413 before they are buffered —
            counted as they stream, never silently truncated. DLQ retry
            replays the original request headers (RELAY-65), so a vendor
            signature (Stripe-Signature, X-Hub-Signature-256,
            X-Shopify-Hmac-SHA256) is replayed byte-identically on rows
            written after this shipped. DLQ rows written before it has no
            headers to replay — that&apos;s the one remaining edge case, and
            the confirm dialog says so per-row.
          </li>
          <li>
            <span className="font-semibold text-landing-primary">
              No billing, no metering, no caps.
            </span>{' '}
            Founding Access is free, full stop, until usage-based billing
            ships — there is no trial clock counting down underneath it.
          </li>
        </ul>
      </Card>
    </details>

    {/* CTA repeat + the no-commitment card-bouncer catch. */}
    <div className="relay-reveal mt-10 rounded-2xl border border-landing-border bg-landing-surface/60 p-6 text-center sm:p-10">
      <div className="mx-auto flex max-w-md flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
        <LandingLink href="/auth/join">Request Founding Access</LandingLink>
        <LandingLink href="mailto:info@coreframe-labs.dev" variant="secondary">
          Talk to us before you connect anything
        </LandingLink>
      </div>
      <p className="mx-auto mt-4 max-w-xl text-sm text-landing-secondary">
        Free, no card, nothing charged. What&apos;s not built yet is above.
      </p>

      <details className="mx-auto mt-6 max-w-xl text-left">
        <summary
          className={`inline-flex w-full cursor-pointer list-none items-center justify-center gap-2 rounded px-3 py-2 text-center text-sm font-medium text-landing-accent-text transition-colors hover:text-landing-accent-text-hover [&::-webkit-details-marker]:hidden ${focusRing}`}
        >
          Not ready to connect anything yet? Read the three things to get right →
        </summary>
        <div className="mt-3 rounded-lg border border-landing-border bg-landing-base p-5">
          <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-landing-secondary">
            <li>
              <span className="font-semibold text-landing-primary">
                Answer senders fast, then finish the work.
              </span>{' '}
              Stripe and most vendors time out in a few seconds. Acknowledge with a
              2xx the moment the event is durably queued — before your own slow
              pipeline runs — or the sender treats the event as failed.
            </li>
            <li>
              <span className="font-semibold text-landing-primary">
                Make handlers idempotent.
              </span>{' '}
              Senders retry. Key your writes on the event id so a retried webhook
              is a no-op, not a duplicate charge or a duplicate CRM lead.
            </li>
            <li>
              <span className="font-semibold text-landing-primary">
                Keep a record you can grep, with a replay path.
              </span>{' '}
              Every inbound event needs a durable receipt the moment it lands — and
              a way to send it again after a restart — or the first sign of a loss
              is a human asking where the lead went.
            </li>
          </ol>
          <p className="mt-4 border-t border-landing-border pt-3 text-xs text-landing-muted">
            A deeper write-up of all three is being prepared for dev.to under
            RELAY-70; the link lands here when the article is published.
          </p>
        </div>
      </details>

      <p className="mt-6 text-xs text-landing-muted">
        <Link
          href="/auth/login"
          className={`rounded underline decoration-landing-muted underline-offset-4 transition-colors hover:text-landing-secondary ${focusRing}`}
        >
          Sign in
        </Link>{' '}
        if you already have an account.
      </p>
    </div>
  </Section>
);

export default FoundingAccessSection;
