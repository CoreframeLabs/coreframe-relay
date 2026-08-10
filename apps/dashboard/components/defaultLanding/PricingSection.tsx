/**
 * [RELAY-64 v2] Pricing/CTA — the £99 is the qualifier, so it is on the page.
 *
 * Rebuilt on `LandingPrimitives`: the stock react-daisyui version (daisyUI `.btn`
 * chrome, lorem-ipsum lede, hardcoded "buy now") was contract bug #1 and is gone.
 *
 * Contract §3 (Pricing), in order: £99 flat/month; annual 12-for-10 arithmetic;
 * "What is one recovered lead worth to you?"; the Hookdeck line with the
 * US$39→US$499 cliff, GBP invoice and onboarding included; the numbered
 * trial-mechanics card; the end-of-trial FAQ; the verbatim roadmap line; the
 * honesty block with at-least-once quoted verbatim; the CTA repeated with the same
 * mechanics sub-line; and a no-commitment three-things download that catches
 * card-bouncers. No feature table — the contract's anti-brief #3 bans it as a
 * tyre-kicker magnet that breaks the insurance reframe.
 *
 * [AGENT-22 conservative-default, director may reverse]: contract question (a) —
 * £99 is the ONLY number shown. No launch-window discount; the RELAY-38 ladder
 * (2026-08-07, LOCKED) is the source of truth and it is solicitors' arithmetic,
 * not marketing's.
 */
import { CheckIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';

import {
  Card,
  Eyebrow,
  LandingLink,
  Section,
  SectionHeading,
  focusRing,
} from './LandingPrimitives';

/** The trial mechanics, numbered — a process, not a promise. */
const trialSteps = [
  {
    n: '1',
    title: 'Card up front, day one.',
    body: "So you set it up properly and we know you're a business, not a bot. Nothing is charged on the card today.",
  },
  {
    n: '2',
    title: 'Nothing charged until day 14.',
    body: 'Fourteen days of real traffic through one route is the proof. Your card does not move during the trial.',
  },
  {
    n: '3',
    title: 'Day-12 warning before anything moves.',
    body: 'Two days before the trial ends you get a warning in writing. Nothing charges silently, ever.',
  },
  {
    n: '4',
    title: 'I will set it up with you on the call.',
    body: 'Book the 20-minute setup call and we point your first route at Relay together. You leave with your own counter moving.',
  },
];

/** End-of-trial questions, answered before they are asked. */
const trialFaq = [
  {
    q: 'What happens on day 14?',
    a: 'If you have done nothing, the Pro subscription starts and the card is charged £99 for the month. The day-12 email lands first, so a charge you did not see coming is a bug, not the design.',
  },
  {
    q: 'What if I cancel before day 14?',
    a: 'Nothing is charged, full stop. The routes you pointed at Relay stop being buffered; the delivery log and DLQ you accumulated stay readable while the account is open.',
  },
  {
    q: 'Does a burst during my worst week charge me per event?',
    a: 'No. Overage is hard-capped at the tier limit with an auto-upgrade prompt — never silent per-event billing. A burst-loss buyer penalised during the worst week churns; the ladder is locked against it.',
  },
];

const included = [
  '50k buffered events a month',
  '90-day delivery log',
  'Unlimited routes',
  'Retry with backoff, then DLQ replay',
];

const PricingSection = () => (
  <Section id="pricing">
    <SectionHeading
      eyebrow="Pricing"
      title="£99 flat a month. That is the qualifier, so it is on the page."
      lede="The price decides before the calendar does. A founder who bounces at £99 here would not pay on day 14, and the calendar stays clear for the buyer whose receiver has actually died."
    />

    <div className="mt-10 grid gap-4 lg:grid-cols-5">
      {/* The anchor */}
      <Card className="relay-reveal lg:col-span-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-display text-4xl font-semibold tracking-tight text-[#f2f3f5]">
            £99
            <span className="text-base font-medium text-[#9a9ea8]">
              {' '}
              flat / month
            </span>
          </p>
          <p className="font-mono text-xs text-[#9a9ea8]">
            annual: 12 for 10 · £990/yr
          </p>
        </div>

        <p className="mt-4 text-sm font-medium text-[#f2f3f5]">
          What is one recovered lead worth to you?
        </p>

        <ul className="mt-5 space-y-2">
          {included.map((item) => (
            <li key={item} className="flex items-start gap-2 text-sm text-[#9a9ea8]">
              <CheckIcon
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-teal-400"
              />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        {/* The Hookdeck line: same category, honestly compared. Contract copy is
            confined to Relay's owned claims; "Same category. If you need their
            transformation engine, use them." is verbatim from the sales motion. */}
        <p className="mt-6 border-t border-[#24262c] pt-4 text-sm leading-relaxed text-[#9a9ea8]">
          Hookdeck runs US$39 to US$499 a month.{' '}
          <span className="text-[#f2f3f5]">
            Same category. If you need their transformation engine, use them.
          </span>{' '}
          Relay invoices in GBP and the onboarding call is included.
        </p>

        <p className="mt-4 text-sm leading-relaxed text-[#9a9ea8]">
          The roadmap adds Gate — human approval on risky payloads — and Shield
          later.{' '}
          <span className="text-[#f2f3f5]">
            Buffer stands alone; don&apos;t buy the roadmap.
          </span>
        </p>
      </Card>

      {/* Numbered trial mechanics — the sales motion's verbatim card. */}
      <Card className="relay-reveal lg:col-span-2">
        <Eyebrow>The 14-day trial</Eyebrow>
        <ol className="space-y-4">
          {trialSteps.map((step) => (
            <li key={step.n} className="flex gap-3">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-teal-500/40 bg-teal-500/10 font-mono text-xs font-semibold text-teal-300"
              >
                {step.n}
              </span>
              <div>
                <p className="text-sm font-semibold text-[#f2f3f5]">
                  {step.title}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-[#9a9ea8]">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>

    {/* End-of-trial FAQ (RELAY-69) + the honesty block side by side. */}
    <div className="mt-10 grid gap-4 lg:grid-cols-2">
      <div className="relay-reveal space-y-4">
        <Eyebrow>When the trial ends</Eyebrow>
        {trialFaq.map((item) => (
          <Card key={item.q}>
            <h3 className="text-sm font-semibold text-[#f2f3f5]">{item.q}</h3>
            <p className="mt-2 text-sm leading-relaxed text-[#9a9ea8]">
              {item.a}
            </p>
          </Card>
        ))}
      </div>

      {/* The honesty block, beside pricing on purpose. */}
      <Card className="relay-reveal">
        <Eyebrow>What Relay doesn&apos;t fix for you</Eyebrow>
        <ul className="space-y-4 text-sm leading-relaxed text-[#9a9ea8]">
          <li>
            <span className="font-semibold text-[#f2f3f5]">
              Delivery is at-least-once.
            </span>{' '}
            &quot;at-least-once delivery — your handler has to make it
            exactly-once&quot;. A sender that retries will deliver the same event
            again, and Relay will faithfully pass it on both times; deduplication
            stays in your handler. Every attempt rides one requestId, so a duplicate
            is visible, never hidden.
          </li>
          <li>
            <span className="font-semibold text-[#f2f3f5]">
              Your endpoint&apos;s own bugs.
            </span>{' '}
            Relay will deliver a webhook your handler mishandles, log the 4xx, and
            land it in the dead letter queue. It cannot make the handler correct.
          </li>
          <li>
            <span className="font-semibold text-[#f2f3f5]">
              A payload over 1 MiB, or its original headers.
            </span>{' '}
            Over-cap bodies are refused with a 413 before they are buffered, and a
            retry from the DLQ is your own re-send — the original signed headers are
            not kept, so a vendor signature cannot be replayed byte-identically.
          </li>
        </ul>
      </Card>
    </div>

    {/* CTA repeat + the no-commitment card-bouncer catch. */}
    <div className="relay-reveal mt-10 rounded-2xl border border-[#24262c] bg-[#191b20]/60 p-6 text-center sm:p-10">
      <div className="mx-auto flex max-w-md flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
        <LandingLink href="/auth/join">Start the 14-day trial</LandingLink>
        <LandingLink href="/auth/join" variant="secondary">
          Book the 20-minute setup call
        </LandingLink>
      </div>
      <p className="mx-auto mt-4 max-w-xl text-sm text-[#9a9ea8]">
        Card up front, nothing charged until day 14, day-12 warning before
        anything moves.
      </p>

      <details className="mx-auto mt-6 max-w-xl text-left">
        <summary
          className={`inline-flex w-full cursor-pointer list-none items-center justify-center gap-2 rounded px-3 py-2 text-center text-sm font-medium text-teal-300 transition-colors hover:text-teal-200 [&::-webkit-details-marker]:hidden ${focusRing}`}
        >
          Not ready to put a card down? Read the three things to get right →
        </summary>
        <div className="mt-3 rounded-lg border border-[#24262c] bg-[#0d0f12] p-5">
          <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-[#9a9ea8]">
            <li>
              <span className="font-semibold text-[#f2f3f5]">
                Answer senders fast, then finish the work.
              </span>{' '}
              Stripe and most vendors time out in a few seconds. Acknowledge with a
              2xx the moment the event is durably queued — before your own slow
              pipeline runs — or the sender treats the event as failed.
            </li>
            <li>
              <span className="font-semibold text-[#f2f3f5]">
                Make handlers idempotent.
              </span>{' '}
              Senders retry. Key your writes on the event id so a retried webhook
              is a no-op, not a duplicate charge or a duplicate CRM lead.
            </li>
            <li>
              <span className="font-semibold text-[#f2f3f5]">
                Keep a record you can grep, with a replay path.
              </span>{' '}
              Every inbound event needs a durable receipt the moment it lands — and
              a way to send it again after a restart — or the first sign of a loss
              is a human asking where the lead went.
            </li>
          </ol>
          <p className="mt-4 border-t border-[#24262c] pt-3 text-xs text-zinc-500">
            A deeper write-up of all three is being prepared for dev.to under
            RELAY-70; the link lands here when the article is published.
          </p>
        </div>
      </details>

      <p className="mt-6 text-xs text-zinc-500">
        <Link
          href="/auth/login"
          className={`rounded underline decoration-zinc-600 underline-offset-4 transition-colors hover:text-zinc-300 ${focusRing}`}
        >
          Sign in
        </Link>{' '}
        if you already have an account.
      </p>
    </div>
  </Section>
);

export default PricingSection;
