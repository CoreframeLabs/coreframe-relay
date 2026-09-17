/**
 * [RELAY-163] Shared build-time fs/frontmatter helpers for the Markdown-sourced
 * `/docs/troubleshooting/<slug>` route.
 *
 * Per `growth/content/relay-seo-content-location-decision-2026-09-17.md`
 * ("Implementation spec"): one Markdown file per page lives at repo root
 * `docs/troubleshooting/<slug>.md` and is simultaneously (a) the reviewed source,
 * (b) the public `.md` mirror (via `scripts/sync-doc-mirrors.mjs`), and (c) the
 * input `pages/docs/troubleshooting/[slug].tsx` renders from. This module is used
 * by that page AND by `pages/docs/index.tsx` (the "Troubleshooting" index section)
 * AND by `pages/docs/integrations/n8n.tsx` (the "Troubleshooting specific failures"
 * pillar→satellite section) so all three stay driven by the same files on disk —
 * dropping a new `docs/troubleshooting/<slug>.md` is enough to make it show up
 * everywhere it needs to, with no other file requiring a manual edit. That is the
 * whole point of this ticket per its own problem statement: "so RELAY-149 and every
 * later page is a Markdown file drop, not a JSX transcription."
 *
 * At the time this ticket lands there are ZERO real files in `docs/troubleshooting/`
 * — RELAY-149 (the first real article) is being drafted in parallel and will be
 * dropped in later. Every function here is therefore written to behave correctly
 * against an empty (or even missing) directory: `listSlugs()` returns `[]`,
 * `getPage()` is the only thing that ever throws, and every caller that lists pages
 * (`listAllPages`, `listSatellitesForPillar`) is used behind an
 * `pages.length > 0` guard by its caller so nothing renders an empty heading.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import matter from 'gray-matter';

export const CANONICAL_ORIGIN = 'https://relay.coreframe-labs.dev';

// `process.cwd()` is `apps/dashboard` for every caller here (Next.js build/dev
// always runs with the app directory as cwd — confirmed against
// `scripts/build.sh`, which `cd`s into `apps/dashboard` before `next build`, and
// `scripts/sync-doc-mirrors.mjs`, which computes the identical repo root this way
// from its own file location rather than from cwd).
const DASHBOARD_ROOT = process.cwd();
const REPO_ROOT = join(DASHBOARD_ROOT, '..', '..');
export const TROUBLESHOOTING_DIR = join(REPO_ROOT, 'docs', 'troubleshooting');

export type TroubleshootingFrontmatter = {
  title: string;
  metaTitle: string;
  description: string;
  slug: string;
  canonical: string;
  datePublished: string;
  dateModified: string;
  n8nVersionVerified?: string;
  verifiedOn: string;
  verifiedBy: string;
  targetQueries: string[];
  pillar: string;
  relatedTroubleshooting?: string[];
};

export type TroubleshootingPage = {
  slug: string;
  data: TroubleshootingFrontmatter;
  content: string;
};

// Every field required unless it's in this list, per the spec's frontmatter
// block ("all fields required unless marked optional"). `n8nVersionVerified` is
// spec'd as "omit only for non-n8n pages" — there is no separate frontmatter flag
// for "this is an n8n page" to gate that on, so this uses the same signal the URL
// pattern itself uses (every n8n example slug in the spec is prefixed `n8n-`) and
// documents that heuristic here rather than silently guessing.
const OPTIONAL_FIELDS = new Set(['relatedTroubleshooting']);
const REQUIRED_FIELDS: (keyof TroubleshootingFrontmatter)[] = [
  'title',
  'metaTitle',
  'description',
  'slug',
  'canonical',
  'datePublished',
  'dateModified',
  'verifiedOn',
  'verifiedBy',
  'targetQueries',
  'pillar',
];

/**
 * Build-time failure (not a silent skip), per this ticket's own acceptance
 * criteria, when a required frontmatter field is missing. Thrown, not logged —
 * throwing inside `getStaticProps`/`getStaticPaths` fails `next build` with this
 * message, which is the whole point.
 */
function assertFrontmatter(
  data: Record<string, unknown>,
  filePath: string
): asserts data is TroubleshootingFrontmatter {
  const missing = REQUIRED_FIELDS.filter((field) => {
    const value = data[field];
    if (Array.isArray(value)) return value.length === 0;
    return value === undefined || value === null || value === '';
  });

  const slug = typeof data.slug === 'string' ? data.slug : undefined;
  const looksLikeN8n = slug?.startsWith('n8n-') ?? filePath.includes('/n8n-');
  if (looksLikeN8n && !data.n8nVersionVerified) {
    missing.push('n8nVersionVerified');
  }

  if (missing.length > 0) {
    throw new Error(
      `[docs/troubleshooting] ${filePath} is missing required frontmatter field(s): ${missing.join(', ')}. ` +
        `See growth/content/relay-seo-content-location-decision-2026-09-17.md ("Required frontmatter").`
    );
  }

  if (!Array.isArray(data.targetQueries)) {
    throw new Error(
      `[docs/troubleshooting] ${filePath}: "targetQueries" must be a YAML list, got ${typeof data.targetQueries}.`
    );
  }
};

export function buildCanonical(slug: string): string {
  return `${CANONICAL_ORIGIN}/docs/troubleshooting/${slug}`;
}

/** Slugs derived from filenames on disk — `[]` if the directory doesn't exist yet. */
export function listSlugs(): string[] {
  if (!existsSync(TROUBLESHOOTING_DIR)) return [];
  return readdirSync(TROUBLESHOOTING_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.replace(/\.md$/, ''));
}

/**
 * Reads and validates one page by slug. Throws (build-time failure) on a missing
 * file, a missing required field, or a `canonical`/`slug` value that disagrees
 * with the file's own name and the URL this page will actually be built at —
 * the spec requires the canonical to "equal the built URL, assert at build time."
 */
export function getPage(slug: string): TroubleshootingPage {
  const filePath = join(TROUBLESHOOTING_DIR, `${slug}.md`);
  const raw = readFileSync(filePath, 'utf8');
  const { data, content } = matter(raw);

  assertFrontmatter(data, filePath);

  if (data.slug !== slug) {
    throw new Error(
      `[docs/troubleshooting] ${filePath}: frontmatter "slug: ${data.slug}" does not match the filename-derived slug "${slug}".`
    );
  }

  const expectedCanonical = buildCanonical(slug);
  if (data.canonical !== expectedCanonical) {
    throw new Error(
      `[docs/troubleshooting] ${filePath}: frontmatter "canonical" is "${data.canonical}", ` +
        `but the built URL is "${expectedCanonical}". These must match exactly.`
    );
  }

  return { slug, data, content };
}

export function listAllPages(): TroubleshootingPage[] {
  return listSlugs()
    .map((slug) => getPage(slug))
    .sort((a, b) => a.data.title.localeCompare(b.data.title));
}

/** Live satellites whose frontmatter `pillar` points at the given pillar path. */
export function listSatellitesForPillar(pillarPath: string): TroubleshootingPage[] {
  return listAllPages().filter((page) => page.data.pillar === pillarPath);
}
