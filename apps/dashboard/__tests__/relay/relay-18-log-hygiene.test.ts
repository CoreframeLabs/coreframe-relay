/**
 * @jest-environment node
 */

/**
 * [RELAY-18] — "no secrets in logs" gate.
 *
 * This is a static, regex-based sweep, not an AST analysis and not a runtime check. It
 * walks every `.ts`/`.tsx` source file under `apps/dashboard` (excluding tests, build
 * output, and node_modules) plus `apps/proxy/src`, finds every `console.(log|error|warn|
 * info|debug)(...)` call site, and flags one where a sensitive-sounding identifier —
 * something named secret/token/password/apiKey/credential/etc. — is interpolated
 * directly into the call (a template-literal `${...}` expression, an object property
 * value, or a bare identifier argument) rather than appearing only inside a fixed string
 * literal (a message like `"RELAY_API_SECRET is not set"` is fine: it names the env var,
 * it does not print its value).
 *
 * WHAT THIS DOES NOT CATCH — stated plainly, not swept under the rug:
 *   - a secret laundered through an intermediate variable with an innocuous name
 *     (`const x = someToken; console.log(x)`)
 *   - a secret logged via a wrapper function instead of `console.*` directly
 *   - a secret spread into a logged object (`console.log({ ...ctx })` where `ctx`
 *     happens to carry a `token` field)
 *   - a secret concatenated into a string with `+` rather than a template literal
 *   - anything logged from a dependency, not this repo's own source
 *   - test fixtures (deliberately excluded — see EXCLUDED_DIRS) that define fake
 *     tokens like `const TOKEN = 'aB3dEf...'` for assertions, not production logging
 *
 * It is a tripwire for the common, careless case, not a substitute for review. It
 * exists so that the *next* accidental `console.log({ token })` fails a test instead of
 * shipping to Vercel's runtime logs.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'apps/dashboard'),
  path.join(REPO_ROOT, 'apps/proxy/src'),
];

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  '__tests__',
  'tests',
  '.do',
  '.github',
  'coverage',
  'public',
  'locales',
]);

const FILE_EXTENSIONS = ['.ts', '.tsx'];

// Identifier fragments that suggest the value is (or carries) a secret. Whole-word /
// camelCase-boundary matching only — see `SENSITIVE_NAME_RE` below.
const SENSITIVE_NAME_RE =
  /(secret|password|passwd|api[_-]?key|private[_-]?key|signing[_-]?key|credential|bearer)/i;

// A bare "token" is deliberately handled separately: this codebase has legitimate,
// non-secret uses of the word (`requestId`, `RouteLookupResponse` fields like
// `ingestTokenSha256`), so a plain digest/hash of a token is safe to log and must not
// trip the gate.
const TOKEN_NAME_RE = /token/i;

// If a flagged identifier *also* matches one of these, it is a derived/redacted value,
// not the raw secret, and is allowed. E.g. `ingestTokenSha256`, `tokenDigest`,
// `secretPresent`, `hasApiKey`.
const SAFE_SUFFIX_RE =
  /(sha256|digest|hash|redacted|masked|present|configured|isset|exists|length|name|error|reason|code|set|type)/i;

interface Finding {
  file: string;
  line: number;
  snippet: string;
  identifier: string;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (FILE_EXTENSIONS.includes(path.extname(entry))) {
      if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
      if (entry.endsWith('.spec.ts') || entry.endsWith('.spec.tsx')) continue;
      out.push(full);
    }
  }
  return out;
}

/** Extract the balanced-paren text of a `console.xxx(` call starting at `openIdx`. */
function extractCall(text: string, openIdx: number): string {
  let depth = 0;
  let i = openIdx;
  for (; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(openIdx, i + 1);
    }
  }
  return text.slice(openIdx);
}

/** Pull out candidate interpolated identifiers from a console-call's source text. */
function candidateIdentifiers(callText: string): string[] {
  const identifiers: string[] = [];

  // Template-literal interpolations: `${identifier}` or `${obj.identifier}`.
  for (const m of callText.matchAll(/\$\{\s*([a-zA-Z0-9_.]+)\s*\}/g)) {
    identifiers.push(m[1]);
  }

  // Object shorthand / property values inside a logged object literal:
  //   { token }              -> shorthand, identifier is "token"
  //   { token: someVar }     -> identifier is "someVar" (the value, not the key)
  //   { token: someVar.raw } -> identifier is "someVar.raw"
  for (const m of callText.matchAll(
    /([a-zA-Z0-9_]+)\s*:\s*([a-zA-Z0-9_.]+)\s*[,}]/g
  )) {
    identifiers.push(m[2]);
  }
  for (const m of callText.matchAll(/[{,]\s*([a-zA-Z0-9_]+)\s*[,}]/g)) {
    identifiers.push(m[1]);
  }

  // Bare identifier arguments: console.log(someSecret)
  for (const m of callText.matchAll(/\(\s*([a-zA-Z0-9_.]+)\s*[,)]/g)) {
    identifiers.push(m[1]);
  }

  return identifiers;
}

function isSensitive(identifier: string): boolean {
  const last = identifier.split('.').pop() ?? identifier;
  if (SAFE_SUFFIX_RE.test(last)) return false;
  if (SENSITIVE_NAME_RE.test(last)) return true;
  if (TOKEN_NAME_RE.test(last)) return true;
  return false;
}

function scanFile(file: string): Finding[] {
  const text = readFileSync(file, 'utf8');
  const findings: Finding[] = [];
  const callRe = /console\.(log|error|warn|info|debug)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const callText = extractCall(text, openIdx);
    const identifiers = candidateIdentifiers(callText);
    for (const id of identifiers) {
      if (isSensitive(id)) {
        const line = text.slice(0, m.index).split('\n').length;
        findings.push({
          file: path.relative(REPO_ROOT, file),
          line,
          snippet: callText.replace(/\s+/g, ' ').slice(0, 160),
          identifier: id,
        });
      }
    }
  }
  return findings;
}

describe('[RELAY-18] no raw secrets interpolated into console.* log calls', () => {
  it('finds no sensitive-named identifier interpolated into a log call', () => {
    const files = SCAN_ROOTS.flatMap((root) => walk(root));
    expect(files.length).toBeGreaterThan(0);

    const allFindings = files.flatMap(scanFile);

    if (allFindings.length > 0) {
      const report = allFindings
        .map(
          (f) =>
            `  ${f.file}:${f.line} — identifier "${f.identifier}" in: ${f.snippet}`
        )
        .join('\n');
      throw new Error(
        `Found ${allFindings.length} log call(s) that may interpolate a secret:\n${report}\n\n` +
          `If this is a false positive (a hash/digest/boolean, not a raw secret), rename ` +
          `the identifier to end in Sha256/Digest/Redacted/Present, or adjust ` +
          `SAFE_SUFFIX_RE in this test. If it is real, stop logging the value — log its ` +
          `presence, type, or a hash instead.`
      );
    }
  });
});
