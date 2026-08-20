/**
 * [RELAY-64] The flow diagram: sender → Relay edge → your endpoint.
 *
 * Schematic, not data. It deliberately shows no timings, counts or rates — the only
 * literal strings on it are the request line and the response body, and both are copied
 * from `apps/proxy/src/routes/ingest.ts` (`c.json({ status: 'queued', requestId }, 200)`,
 * with the comment there explaining why it is 200 and not 202) and from
 * `models/route.ts#relayUrlFor` (`{base}/in/{teamSlug}/{routeSlug}/{ingestToken}` —
 * [RELAY-57]; the token segment is elided here because a landing-page mock must never
 * train a reader to copy a real credential shape).
 *
 * v2: two rendering modes. Default keeps the v1 panel (chrome + caption) for the
 * how-it-works section. `bare` renders just the terminal block with no wrapper, no
 * motion classes and no caption — the Gap's With pane nests it per the contract
 * ("the surviving RelayFlowDiagram terminal sits inside the With pane") so the
 * packet-on-wire animation is NOT doubled under the Gap's own replay.
 *
 * v2 tokens: violet accents → teal (contract §4). Motion is CSS only (no dependency
 * could be installed — RELAY-62) and is switched off wholesale by
 * `prefers-reduced-motion: reduce` in `styles/globals.css`.
 *
 * [ui-revamp Phase 1/4] `Node`/`Wire`/the outer diagram wrapper are tokenized onto
 * `--landing-*` (see `LandingPrimitives.tsx`'s file header) and flip with the rest
 * of the page. `Terminal` deliberately stays fixed dark in both themes — it's a
 * simulated `curl` + response, same reasoning as `GapSection.tsx`'s panes.
 */
import type { ReactNode } from 'react';

const Node = ({
  label,
  sub,
  accent = false,
}: {
  label: string;
  sub: string;
  accent?: boolean;
}) => (
  <div
    className={`rounded-lg border p-4 text-center ${
      accent
        ? 'border-landing-accent/50 bg-landing-accent/10'
        : 'border-landing-border bg-landing-surface'
    }`}
  >
    <p
      className={`text-sm font-semibold ${accent ? 'text-landing-accent-text' : 'text-landing-primary'}`}
    >
      {label}
    </p>
    <p className="mt-1 text-xs leading-snug text-landing-secondary">{sub}</p>
  </div>
);

/** Horizontal on md+, vertical below it, so nothing overflows at 360px. */
const Wire = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col items-center gap-1 py-1 md:py-0">
    <span className="relay-wire-y relay-wire-animated md:hidden" />
    <span className="relay-wire-x relay-wire-animated hidden md:block" />
    <span className="font-mono text-[10px] uppercase tracking-wider text-landing-muted">
      {children}
    </span>
  </div>
);

/** Simulated terminal output — deliberately fixed dark in both themes. See file header. */
const Terminal = () => (
  <div className="overflow-x-auto rounded-lg border border-[#24262c] bg-[#0d0f12] p-4">
    <pre className="font-mono text-xs leading-6 text-zinc-300">
      <code>
        <span className="text-zinc-500">$</span> curl -X POST
        https://relay.example/in/<span className="text-teal-300">acme</span>/
        <span className="text-teal-300">orders</span>/
        <span className="text-teal-300">&#123;ingest-token&#125;</span> -d
        @event.json{'\n'}
        <span className="text-emerald-400">200</span>{' '}
        {'{"status":"queued","requestId":"…"}'}
      </code>
    </pre>
  </div>
);

const RelayFlowDiagram = ({ bare = false }: { bare?: boolean }) => {
  if (bare) return <Terminal />;

  return (
    <div className="rounded-2xl border border-landing-border bg-landing-surface/40 p-5 sm:p-8">
      <div className="grid items-center gap-2 md:grid-cols-[1fr_7rem_1fr_7rem_1fr]">
        <Node label="Sender" sub="your service, your agent, n8n, Make" />
        <Wire>accepts</Wire>
        <Node label="Relay" sub="Cloudflare Worker, then a durable queue" accent />
        <Wire>delivers</Wire>
        <Node label="Your endpoint" sub="CRM, internal API, workflow runner" />
      </div>

      <p className="mt-6 text-center text-sm leading-relaxed text-landing-secondary">
        Relay answers the sender as soon as the payload is on the queue — before
        your endpoint is touched at all. Delivery happens afterwards, and keeps
        retrying with backoff until your endpoint returns a 2xx or the attempts run
        out.
      </p>

      <div className="mt-6">
        <Terminal />
      </div>
    </div>
  );
};

export default RelayFlowDiagram;
