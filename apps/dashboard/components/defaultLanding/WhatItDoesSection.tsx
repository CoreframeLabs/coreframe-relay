/**
 * [RELAY-64] What Buffer does.
 *
 * These three cards state only capabilities that exist in `src/` today: the ingest
 * endpoint answers 200 the instant the body is queued (`routes/ingest.ts`), the QStash
 * consumer retries then writes to the DLQ (`pages/api/relay/qstash.ts`), and every
 * attempt is recorded on `DeliveryLog` with a DLQ that reports the real reason —
 * nothing on this grid is marketing copy for a control that is not in this codebase.
 */
import { Card, Section, SectionHeading, StatusChip } from './LandingPrimitives';

const capabilities = [
  {
    title: 'Answers fast, always',
    body: 'Relay accepts the payload at the edge, returns a 200 as soon as it is safe, and only then involves the queue. Your endpoint never adds to the sender’s wait.',
  },
  {
    title: 'Retries until it lands',
    body: 'When your endpoint answers 5xx or times out, Relay tries again with backoff instead of treating the event as dead. It only stops when the retry budget runs out.',
  },
  {
    title: 'Nothing vanishes silently',
    body: 'Every attempt is written to a delivery log. When the retries run out the payload moves to the dead letter queue, with its failure reason, so you can read it — or retry it by hand.',
  },
];

const WhatItDoesSection = () => (
  <Section id="what-it-does">
    <SectionHeading
      eyebrow="What it does"
      title="The part of the pipeline that exists today."
      lede="One route is built, tested and running against a real queue. It accepts at the edge, retries with backoff, and records every attempt — so a silent stop on your side is never mistaken for a webhook that never arrived."
    />

    <div className="mt-10 grid gap-4 md:grid-cols-3">
      {capabilities.map((capability) => (
        <Card key={capability.title}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="max-w-[14rem] text-base font-semibold text-zinc-100">
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

export default WhatItDoesSection;
