/**
 * [RELAY-64] Gate and Shield — labelled as not built.
 *
 * Per RELAY-55 these two phases appear only as clearly-named roadmap. Each card names
 * the phase it belongs to, what it would eventually do, and is labelled "Roadmap" so a
 * reader cannot mistake it for a capability. The word "eventually" is doing real work:
 * nothing here exists, nothing is promised, and the copy does not imply the team is
 * partly through either phase.
 */
import { Card, Section, SectionHeading, StatusChip } from './LandingPrimitives';

const roadmap = [
  {
    phase: 'Gate',
    headline: 'Ask before the risky one ships',
    body: 'Hold specific deliveries for a human decision. The shape that is planned: when a payload matches a rule you set, the delivery pauses and one of your team approves or rejects before it resumes. Nothing of that exists in code today.',
  },
  {
    phase: 'Shield',
    headline: 'Contain an agent that misbehaves',
    body: 'Scope and slow the agents you let talk to your endpoints. Planned as a separate layer on top of Buffer, with its own cost model, and deliberately dependent on Gate. None of it exists in code today either.',
  },
];

const RoadmapSection = () => (
  <Section id="roadmap">
    <SectionHeading
      eyebrow="Roadmap"
      title="Two more phases are on the drawing board — not on the wire."
      lede="Relay’s current phase is Buffer, the one you just read about. Gate and Shield are documented below so you can see where this is headed, but they are unbuilt, unpriced, and not being sold here."
    />

    <div className="mt-10 grid gap-4 md:grid-cols-2">
      {roadmap.map((item) => (
        <Card key={item.phase}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-zinc-100">
              {item.phase} — {item.headline}
            </h3>
            <StatusChip tone="planned">Roadmap</StatusChip>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            {item.body}
          </p>
        </Card>
      ))}
    </div>
  </Section>
);

export default RoadmapSection;
