import type { ReactNode } from 'react';

/**
 * [design-overhaul 2026-08] Shared code/flow block for public docs pages.
 *
 * Before this, `pages/docs/integrations/n8n.tsx` had exactly zero styled code blocks —
 * every technical detail, including the request flow ("sender → Relay ingest URL → …"),
 * rendered as plain prose. That is the concrete gap behind the "docs need real code block
 * styling" ask: there was nothing to style because nothing was marked up as code.
 *
 * Visual language is deliberately copied from `GapSection.tsx`'s terminal panes and
 * `ProofSection.tsx`'s delivery-log figure, not invented fresh: traffic-light dots, a
 * mono label bar, opaque `#191b20` surface. Those two components already establish, with
 * measured contrast numbers in their own file headers, that a code/log block is a fixed
 * dark island in both themes on this site — the same convention a code block on a docs
 * site typically follows (it doesn't flip white under a light theme). This component is
 * that same convention, generalised so a docs page doesn't need to hand-roll it.
 */
export function CodeWindow({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="my-5 overflow-hidden rounded-xl border border-[#24262c] bg-[#191b20]">
      <div className="flex items-center gap-2 border-b border-[#24262c] bg-[#131518] px-4 py-2.5">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
        {label ? (
          <p className="ml-2 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
            {label}
          </p>
        ) : null}
      </div>
      <div className="overflow-x-auto p-4">
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6 text-zinc-300">
          {children}
        </pre>
      </div>
    </div>
  );
}

export default CodeWindow;
