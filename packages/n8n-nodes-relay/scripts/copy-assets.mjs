// tsc compiles .ts -> .js into dist/ but never touches non-TS assets (icons). n8n
// resolves a node's `icon: 'file:relay.svg'` relative to the COMPILED node file's own
// directory, so the icon has to land at dist/nodes/Relay/relay.svg, not just src/. This
// is a two-line copy rather than a bundler dependency because there is exactly one
// asset file in this package today.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const assets = [['src/nodes/Relay/relay.svg', 'dist/nodes/Relay/relay.svg']];

for (const [from, to] of assets) {
	const src = join(root, from);
	const dest = join(root, to);
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(src, dest);
	console.log(`copied ${from} -> ${to}`);
}
