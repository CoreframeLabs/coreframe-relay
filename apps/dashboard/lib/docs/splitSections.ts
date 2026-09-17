/**
 * [RELAY-163] Splits a Markdown body into DocsPage's `{ intro, sections }` shape.
 *
 * `DocsPage` (see `components/docs/DocsPage.tsx`) was built for hand-curated JSX
 * pages that already arrive as a list of `{id, title, body}` sections — that's
 * what drives its "On this page" sidebar nav. A Markdown-sourced page has none of
 * that structure up front, just a flat document, so this turns every top-level
 * `##` heading into one DocsSection (title = heading text, id = a slug of it) and
 * treats everything before the first `##` as the page's `intro` — which lines up
 * exactly with the spec's body rule that "the first paragraph under the H1 states
 * the diagnosis path," i.e. DocsPage's existing `intro` slot.
 *
 * Deliberately line-based rather than a full remark AST walk: a full AST split
 * would need to re-serialize each section back to Markdown (or render fragments
 * from parsed mdast nodes directly), and remark's own heading nodes don't carry
 * fence state for us for free either way. The only correctness risk with a
 * text-level split is a `##`-looking line inside a fenced code block being
 * mistaken for a heading, so fence state (```` ``` ````) is tracked explicitly
 * below and headings are never split out while inside one.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type MarkdownSection = {
  id: string;
  title: string;
  body: string;
};

export function splitMarkdownSections(markdown: string): {
  intro: string;
  sections: MarkdownSection[];
} {
  const lines = markdown.split('\n');
  const sections: MarkdownSection[] = [];
  let introLines: string[] = [];
  let currentTitle: string | null = null;
  let currentLines: string[] = [];
  let inFence = false;

  const flush = () => {
    if (currentTitle === null) {
      introLines = currentLines;
    } else {
      sections.push({
        id: slugify(currentTitle),
        title: currentTitle,
        body: currentLines.join('\n').trim(),
      });
    }
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
    }

    const isH2 = !inFence && /^##(?!#)\s+/.test(line);
    if (isH2) {
      flush();
      // Headings may carry inline code (`FOO=true`); the TOC and section heading
      // render plain text, so strip the backticks rather than show them literally.
      currentTitle = line.replace(/^##\s+/, '').replace(/`/g, '').trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return { intro: introLines.join('\n').trim(), sections };
}
