#!/usr/bin/env node
/**
 * [RELAY-145] Copies the repo-root `docs/integrations/n8n.md` — the file
 * `pages/docs/integrations/n8n.tsx`'s own header comment names as its source of
 * truth ("Content below is transcribed from `docs/integrations/n8n.md` at the
 * repo root, not reinvented") — into `public/docs/integrations/n8n.md` so it is
 * servable as a static file at `/docs/integrations/n8n.md`.
 *
 * This is a copy, not a second hand-transcription: the AC for RELAY-145 requires
 * the mirror's body to be "generated from the same source as the page, not a
 * hand-copied second file." The .tsx page and this mirror both trace to the one
 * root `docs/integrations/n8n.md` file, so neither can drift from the wording of
 * the other without someone touching that one file — the same source-of-truth
 * discipline `aeo-gap-audit.md` §1.1 credits the parent site's mirror generation
 * with, applied here without needing that site's full data-module pipeline.
 *
 * Run as part of `npm run build` (see `scripts/build.sh`) so the published mirror
 * can never be stale relative to the committed source file. There is
 * deliberately no reverse direction: this script only ever writes into
 * `public/`, never back into `docs/`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dashboardRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(dashboardRoot, '..', '..');

const mirrors = [
  {
    source: join(repoRoot, 'docs', 'integrations', 'n8n.md'),
    dest: join(dashboardRoot, 'public', 'docs', 'integrations', 'n8n.md'),
  },
];

for (const { source, dest } of mirrors) {
  const body = readFileSync(source, 'utf8');
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  console.log(`[sync-doc-mirrors] ${source} -> ${dest} (${body.length} bytes)`);
}

// [RELAY-163] `docs/troubleshooting/*.md` is a growing, Markdown-file-drop set
// (one file per page, RELAY-149 onward) rather than the single hand-added entry
// each integration above got — the whole point of RELAY-163's route is that
// dropping a new file here is enough, with nothing else to edit. So this half
// mirrors every file in the directory instead of extending the `mirrors` array
// per page. `existsSync` guard: at the time this ticket lands the directory has
// zero real pages (RELAY-149 is being drafted in parallel), so this must not
// throw on a missing/empty directory.
const troubleshootingSrcDir = join(repoRoot, 'docs', 'troubleshooting');
const troubleshootingDestDir = join(dashboardRoot, 'public', 'docs', 'troubleshooting');

if (existsSync(troubleshootingSrcDir)) {
  const files = readdirSync(troubleshootingSrcDir).filter((name) => name.endsWith('.md'));
  for (const name of files) {
    const source = join(troubleshootingSrcDir, name);
    const dest = join(troubleshootingDestDir, name);
    const body = readFileSync(source, 'utf8');
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    console.log(`[sync-doc-mirrors] ${source} -> ${dest} (${body.length} bytes)`);
  }
}
