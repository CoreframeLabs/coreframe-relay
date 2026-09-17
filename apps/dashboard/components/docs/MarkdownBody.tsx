/**
 * [RELAY-163] Renders one Markdown-sourced docs section's body.
 *
 * Styling is not invented fresh — every class below is lifted from
 * `pages/docs/integrations/n8n.tsx`'s hand-written JSX (its bug/capability table,
 * `CodeWindow` for fenced blocks, `extLink`/`inlineLink` for anchors) so a
 * Markdown-rendered troubleshooting page looks like the same product as the
 * hand-transcribed pillar it links back to, not a second visual language.
 * Wrapped in `@tailwindcss/typography`'s `prose` for baseline spacing/line-height;
 * the explicit `components` overrides below take precedence over prose's own
 * element styling for the pieces that have to match n8n.tsx exactly (tables,
 * code blocks, links).
 *
 * `landing-*` colours are CSS-variable-backed (see `styles/globals.css`, `.dark`
 * block) and already re-theme on their own — no `dark:` variants needed here,
 * same as every other docs page.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';

import { CodeWindow } from '@/components/docs/CodeWindow';
import { focusRing } from '@/components/defaultLanding/LandingPrimitives';

const inlineLink = `rounded text-landing-accent-text underline underline-offset-2 hover:text-landing-accent-text-hover ${focusRing}`;
const extLink = inlineLink;

export function MarkdownBody({ markdown }: { markdown: string }) {
  return (
    <div className="prose prose-sm max-w-none sm:prose-base prose-headings:text-landing-primary prose-p:text-landing-secondary prose-strong:text-landing-primary prose-a:no-underline prose-li:text-landing-secondary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: ({ children }) => (
            <h2 className="text-xl font-semibold text-landing-primary">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold text-landing-primary">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="mb-4 leading-relaxed text-landing-secondary">{children}</p>
          ),
          strong: ({ children }) => (
            <strong className="text-landing-primary">{children}</strong>
          ),
          ul: ({ children }) => (
            <ul className="mb-4 list-disc space-y-2 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-4 list-decimal space-y-2 pl-5">{children}</ol>
          ),
          li: ({ children }) => <li className="text-landing-secondary">{children}</li>,
          a: ({ href, children }) => {
            // A plain <a>, not next/link, for both branches: internal docs links
            // don't need client-side prefetching badly enough to be worth the
            // `next/link` children-type friction against react-markdown's own
            // node types, and every other inline link on this page family
            // (n8n.tsx's `extLink`) is a plain <a> too.
            const isExternal = /^https?:\/\//.test(href ?? '');
            return (
              <a
                href={href}
                {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                className={isExternal ? extLink : inlineLink}
              >
                {children}
              </a>
            );
          },
          table: ({ children }) => (
            // Header vs body row borders are applied via descendant selectors on
            // <table> itself, not a `tr` override — react-markdown gives `thead`
            // and `tbody` each their own `<tr>`, and a single `tr` override can't
            // tell which parent it's in, but Tailwind's `[&_thead_tr]`/
            // `[&_tbody_tr]` arbitrary variants can, so the two row styles from
            // n8n.tsx's table (header: solid border + primary text; body: faint
            // border + secondary text) are preserved exactly.
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[36rem] border-collapse text-sm [&_tbody_tr]:border-b [&_tbody_tr]:border-landing-border/60 [&_tbody_tr]:align-top [&_thead_tr]:border-b [&_thead_tr]:border-landing-border [&_thead_tr]:text-left [&_thead_tr]:text-landing-primary">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => <th className="py-2 pr-4 font-semibold">{children}</th>,
          td: ({ children }) => (
            <td className="py-3 pr-4 text-landing-secondary">{children}</td>
          ),
          pre: ({ children }) => <CodeWindow>{children as ReactNode}</CodeWindow>,
          code: ({ className, children }) => (
            <code className={`rounded bg-landing-border/40 px-1.5 py-0.5 font-mono text-[0.85em] ${className ?? ''}`}>
              {children}
            </code>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownBody;
