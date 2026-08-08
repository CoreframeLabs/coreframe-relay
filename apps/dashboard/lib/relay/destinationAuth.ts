import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * [RELAY-59] Customer-configured destination auth headers, encrypted at rest.
 *
 * Threat model
 * ────────────
 * The values stored in `Route.destinationHeadersEncrypted` are customer credentials for
 * THEIR downstream systems — a CRM bearer token, a signing secret, an n8n webhook key.
 * The goal of this module is exactly one guarantee:
 *
 *   A database dump (or a `postgres` SQL connection, which the app path still is) must
 *   not yield a usable customer token.
 *
 * What it does NOT protect against:
 *
 *  - A running application process. The key is an env var (`RELAY_DESTINATION_HEADERS_KEY`)
 *    readable by any process that can also run the app. Envelope encryption, KMS, or a
 *    secrets manager would raise this — deliberately out of scope on the £0 budget, and
 *    named as such in the ticket. An attacker with code-execution on the app host already
 *    has the plaintext in memory.
 *  - QStash / the wire. Decrypted headers are placed into the destination request, which
 *    is the point. They must never reach a log line, `DeliveryLog`, or `DlqItem`, and no
 *    API ever returns them — enforced at the model layer, not here.
 *
 * Why AES-256-GCM rather than something else
 * ──────────────────────────────────────────
 * The key-at-rest decision named by the ticket. A random IV per value means two routes
 * holding the SAME header value produce unrelated ciphertexts, so a dump cannot be
 * cross-referenced across tenants. The GCM auth tag makes tampering detectable: a
 * bit-flip in the DB, a wrong key, or a hand-edited row all land in `decryptDestinationHeaders`
 * as an `{ error }`, never as garbled plaintext. Nothing downstream retries or
 * silently no-ops on tamper.
 *
 * Per-value encryption, keyed by header name
 * ──────────────────────────────────────────
 * The column is a JSON map of header NAME → `{ iv, ct, tag }`, not a single blob.
 * That makes add/remove one header independent of the others, and the masked list
 * (names only, masked indicator) is derivable without any decrypt. A single-blob
 * design would force a read-decrypt-write on every edit and would re-encrypt values
 * the caller never touched, which both costs the key exposure and loses the auditability
 * of "only the field the UI edited changed".
 *
 * Key rotation
 * ────────────
 * Reported as an open unknown in the ticket's notes, not silently decided. Until a
 * rotation path exists the operational answer is: generate a new key, decrypt every row
 * with the old key, re-encrypt with the new. Because the ciphertext carries no key-id,
 * the safest interim procedure is a one-shot sweep during a quiet window, not a lazy
 * rollover. The brief names envelope/KMS as out of scope; this is that boundary stated.
 *
 * Wire shape
 * ──────────
 * On disk: `{ "<header-name>": "<base64(JSON.stringify({iv,ct,tag}))>", ... }` where the
 * inner object is `Buffer.toString('base64', …)` of the IV, ciphertext and auth tag.
 * Header names are stored lowercase-trimmed (case is not part of a header's semantics —
 * HTTP/2 lowercase-names are the baseline).
 */

const KEY_ENV = 'RELAY_DESTINATION_HEADERS_KEY';
const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16;
const VERSION = 'v1' as const;

/** Thrown when the key is missing or malformed at the point a caller needs it. */
export class DestinationHeadersKeyError extends Error {
  constructor(message = `Missing or invalid ${KEY_ENV}`) {
    super(message);
    this.name = 'DestinationHeadersKeyError';
  }
}

/** Thrown when a stored header value cannot be decrypted (tamper, wrong key, corrupt). */
export class DestinationHeadersTamperError extends Error {
  constructor(message = 'destination header ciphertext failed authentication') {
    super(message);
    this.name = 'DestinationHeadersTamperError';
  }
}

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) throw new DestinationHeadersKeyError();

  // Accept hex (64 chars) or base64 (44 chars). Hex is what `openssl rand -hex 32`
  // gives you; base64 is what `randomBytes(32).toString('base64')` gives you. Anything
  // else is unusable and we fail closed rather than silently zero-padding.
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length === 32) return buf;
  throw new DestinationHeadersKeyError(`${KEY_ENV} must be 32 bytes (hex or base64)`);
}

function encryptValue(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.from(
    JSON.stringify({
      v: VERSION,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
    }),
    'utf8'
  ).toString('base64');
}

function decryptValue(encoded: string): string {
  if (typeof encoded !== 'string') {
    throw new DestinationHeadersTamperError('stored value is not a string');
  }

  let inner: { v?: string; iv?: string; ct?: string; tag?: string };
  try {
    inner = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new DestinationHeadersTamperError('stored value is not valid base64 JSON');
  }
  if (inner.v !== VERSION) {
    throw new DestinationHeadersTamperError(`unsupported envelope version ${String(inner.v)}`);
  }

  const key = loadKey();
  const iv = Buffer.from(String(inner.iv), 'base64');
  const ct = Buffer.from(String(inner.ct), 'base64');
  const tag = Buffer.from(String(inner.tag), 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ct.length === 0) {
    throw new DestinationHeadersTamperError('stored envelope is structurally invalid');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new DestinationHeadersTamperError();
  }
}

/** The stored shape is a JSON-serialisable map of lowercased header name → base64 envelope. */
export type StoredDestinationHeaders = Record<string, string>;

/**
 * Header names a customer is allowed to SET. Applied at WRITE time only — see the
 * structural-check split below. A name that is structurally valid but not in this set
 * can round-trip (so a future allowed-name tightening does not silently brick existing
 * stored rows) but can no longer be written.
 *
 * A deliberate subset of Relay's own outbound denylist: the names Relay could forward
 * safely if the route configured them, and no more. `authorization` is the obvious one;
 * the rest are the shapes real CRM / n8n / self-hosted receivers actually check.
 */
const ALLOWED_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-auth-token',
  'x-access-token',
  'x-signature',
  'x-hmac-signature',
  'x-webhook-secret',
  'x-github-hook-secret', // some self-hosted GitHub receivers
]);

/**
 * Hard floor on the value. An empty string is a typo, not a credential, and would
 * otherwise encrypt to an inert no-op that looks set.
 */
const MIN_VALUE_CHARS = 1;
const MAX_VALUE_CHARS = 4096;
const MAX_HEADERS_PER_ROUTE = 8;

function normaliseHeaderName(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.trim().toLowerCase();
}

/**
 * STRUCTURAL validity only — is this a legal header name at all?
 * Distinct from allowlist membership on purpose:
 *   - structurally invalid  → tamper: refuse to decode/decrypt, fail closed
 *   - structurally valid but not on ALLOWED_HEADER_NAMES → lawful old data: decrypt fine,
 *     but cannot be newly written via `encryptDestinationHeaders`
 */
function assertStructurallyValidHeaderName(name: string): void {
  if (!name) throw new DestinationHeadersTamperError('header name is empty');
  if (name.length > 128) throw new DestinationHeadersTamperError(`header name "${name}" too long`);
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new DestinationHeadersTamperError(`header name "${name}" is structurally invalid`);
  }
}

function isAllowedHeaderName(name: string): boolean {
  return ALLOWED_HEADER_NAMES.has(name);
}

function validateHeaderValue(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== 'string') return { ok: false, reason: 'header value must be a string' };
  if (value.length < MIN_VALUE_CHARS) return { ok: false, reason: 'header value is empty' };
  if (value.length > MAX_VALUE_CHARS) return { ok: false, reason: `header value exceeds ${MAX_VALUE_CHARS} characters` };
  if (/[\r\n]/.test(value)) return { ok: false, reason: 'header value must not contain newlines' };
  return { ok: true, value };
}

/**
 * Accepts `{ name: value }`, validates and encrypts each value, returns the stored map.
 *
 * Validation is ALL-OR-NOTHING: a single bad entry rejects the whole set, because a
 * partial write would leave the route in a state nobody chose. Callers wanting a
 * "remove" pass the new full map; removal is just "the map no longer has it".
 */
export function encryptDestinationHeaders(
  input: Record<string, unknown>
): StoredDestinationHeaders {
  const names = Object.keys(input).map(normaliseHeaderName);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) {
    throw new Error('duplicate header name');
  }
  if (uniqueNames.size === 0) return {};
  if (uniqueNames.size > MAX_HEADERS_PER_ROUTE) {
    throw new Error(`at most ${MAX_HEADERS_PER_ROUTE} destination headers per route`);
  }

  const out: StoredDestinationHeaders = {};
  for (const rawName of Object.keys(input)) {
    const name = normaliseHeaderName(rawName);
    try {
      assertStructurallyValidHeaderName(name);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'invalid header name');
    }
    if (!isAllowedHeaderName(name)) {
      throw new Error(`header "${name}" is not on the allowed list`);
    }
    const valueCheck = validateHeaderValue(input[rawName]);
    if (!valueCheck.ok) throw new Error(`header "${name}": ${valueCheck.reason}`);
    out[name] = encryptValue(valueCheck.value);
  }
  return out;
}

/**
 * Parse + decrypt a stored map. Throws `DestinationHeadersTamperError` on ANY tamper —
 * wrong key, flipped bit, wrong table. A caller that catches this knows the route's
 * stored auth can no longer be trusted and should refuse to forward rather than try the
 * next route.
 */
export function decryptDestinationHeaders(
  stored: unknown
): Record<string, string> {
  if (stored === null || stored === undefined) return {};
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    throw new DestinationHeadersTamperError('stored headers are not a map');
  }

  const out: Record<string, string> = {};
  for (const [name, encoded] of Object.entries(stored as Record<string, unknown>)) {
    const normalised = normaliseHeaderName(name);
    // Structural validation only — NOT allowlist membership. A name Relay stopped
    // accepting in the future must still decrypt for a row already stored (otherwise
    // a code change would brick live routes). What we refuse to decode is a name that
    // cannot legally be a header at all, which is tamper.
    assertStructurallyValidHeaderName(normalised);
    out[normalised] = decryptValue(String(encoded));
  }
  return out;
}

/**
 * Returns only the names, which is the ONLY thing any API or UI is permitted to show the
 * client. The masked indicator is derived from the column shape, never from a decrypt.
 */
export function destinationHeaderNames(stored: unknown): string[] {
  if (stored === null || stored === undefined) return [];
  if (typeof stored !== 'object' || Array.isArray(stored)) return [];
  return Object.keys(stored as Record<string, unknown>)
    .map(normaliseHeaderName)
    .filter(Boolean)
    .sort();
}

/** Public, for the UI and any tests that need to know which names the product accepts. */
export const DESTINATION_HEADER_ALLOWED_NAMES: ReadonlyArray<string> = Array.from(
  ALLOWED_HEADER_NAMES
).sort();
