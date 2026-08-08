/**
 * [RELAY-64] The limits, written so they cannot be misread as roadmap.
 *
 * These three cards are the exact gaps a real customer would hit today. Each one is
 * checked against code that exists: the proxy rejects any body over a 1 MiB cap before
 * it is buffered, the DLQ rows the retry consumes keep the body but deliberately do not
 * keep the original headers (so a vendor signature cannot be replayed), and the retry
 * window is a per-environment configuration, not a promotional number invented for this
 * page. None of it is a promise with a decimal attached.
 */
import { Card, Section, SectionHeading, StatusChip } from './LandingPrimitives';

const limits = [
  {
    title: 'Payload cap',
    body: 'A body over 1 MiB is refused up front with a 413 — it is counted as it streams, never buffered. There is no silent truncation, and no over-cap path inside Relay: the rejection is final for that attempt.',
  },
  {
    title: 'What the DLQ cannot replay',
    body: 'Relay keeps the body and the failure reason. It does not keep the original headers, so a signature Stripe or GitHub signed once cannot be re-sent. A retry from the dead letter queue is your own re-send, not a byte-identical re-delivery.',
  },
  {
    title: 'Retry window',
    body: 'Retries run with backoff until the attempts are spent, then the payload moves to the dead letter queue. The budget is configured per environment rather than a marketing number — it is stated, not presumed.',
  },
];

const LimitsSection = () => (
  <Section id="limits" className="bg-zinc-950">
    <SectionHeading
      eyebrow="Limits"
      title="What Relay cannot do today."
      lede="None of the following is hedged. These are the failure modes that exist past the first curl, stated up front rather than after you have sent your first event."
    />

    <div className="mt-10 grid gap-4 md:grid-cols-3">
      {limits.map((limit) => (
        <Card key={limit.title}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="max-w-[14rem] text-base font-semibold text-zinc-100">
              {limit.title}
            </h3>
            <StatusChip tone="gap">Current behaviour</StatusChip>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            {limit.body}
          </p>
        </Card>
      ))}
    </div>
  </Section>
);

export default LimitsSection;
