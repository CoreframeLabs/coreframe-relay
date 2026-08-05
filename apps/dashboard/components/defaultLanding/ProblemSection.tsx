/**
 * [RELAY-64] The problem, stated without a number attached to it.
 *
 * The framing is the one approved in the project brief §3: fast agents pushing into slow
 * systems, and a four-second CRM read as a failure. The "four seconds" is the sender's
 * timeout behaviour, not a measurement of Relay.
 */
import { Card, Section, SectionHeading } from './LandingPrimitives';

const problems = [
  {
    title: 'The sender gives up',
    body: 'Most webhook senders wait a few seconds and then treat the request as failed. If your endpoint is mid-restart, cold, or just slow, the event is gone. Nothing on your side ever knew it existed.',
  },
  {
    title: 'Or it fires twice',
    body: 'Senders that do retry will happily deliver the same event again. Without an idempotency key on your side, that is a duplicate lead, a duplicate order, or a refund issued twice.',
  },
  {
    title: 'And nothing recorded it',
    body: 'A dropped webhook leaves no row in any table. The first signal is a person asking where the lead went, which is usually days later and unanswerable.',
  },
];

const ProblemSection = () => (
  <Section className="bg-zinc-950">
    <SectionHeading
      eyebrow="The problem"
      title="A timeout is not a delivery guarantee."
      lede="Fast AI agents and automation runners push webhooks into slow, fragile business systems. When a CRM takes four seconds to answer, the sender assumes failure — and the two things it does next are both bad."
    />

    <div className="mt-10 grid gap-4 md:grid-cols-3">
      {problems.map((problem) => (
        <Card key={problem.title}>
          <h3 className="text-base font-semibold text-zinc-100">
            {problem.title}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            {problem.body}
          </p>
        </Card>
      ))}
    </div>
  </Section>
);

export default ProblemSection;
