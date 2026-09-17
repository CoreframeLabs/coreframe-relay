import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Delivery read tokens — [RELAY-119].
 *
 * The credential an n8n workflow (or any non-browser caller) presents to
 * `GET /api/relay/deliveries?requestId=…` as `Authorization: Bearer relay_rt_…`. Pure
 * functions only: no database, no request object, so every rule here is unit-testable
 * with nothing mocked. `models/readToken.ts` owns persistence; the handlers own HTTP.
 *
 * FORMAT
 *   `relay_rt_` + 24 random bytes base64url-unpadded (32 chars) — 192 bits of entropy,
 *   the same generator shape as `lib/relay/ingestToken.ts`. The fixed prefix is for
 *   secret scanners and log redactors (a `relay_rt_[A-Za-z0-9_-]{32}` pattern), and it
 *   lets the read endpoint reject a non-token bearer BEFORE touching the database.
 *
 * STORAGE
 *   Unsalted SHA-256 hex of the full token string, exactly as `models/apiKey.ts`'s
 *   `hashApiKey` and `ingestTokenDigestHex` do. Correct for a 192-bit random secret:
 *   there is no dictionary to precompute against it, and the unsalted digest is what
 *   makes the lookup one indexed equality (`RelayReadToken.hashedToken @unique`).
 *
 * COMPARE
 *   The database equality already finds the row; `readTokenDigestMatches` is run
 *   ANYWAY, in constant time, on the row that came back. Belt and braces, deliberately:
 *   a future refactor that turns the lookup into a prefix match, a LIKE, or a
 *   case-insensitive collation would otherwise silently authenticate the wrong token.
 *   Both sides are fixed-width 32-byte digests, so `timingSafeEqual` cannot throw on a
 *   length mismatch and the comparison cannot leak the secret's length — same reasoning
 *   as `lib/relay/internalAuth.ts`.
 */

export const READ_TOKEN_PREFIX = 'relay_rt_';

/** The only scope v1 mints, and the only one the read endpoint accepts. */
export const DELIVERY_READ_SCOPE = 'delivery:read';

/** Fixed in v1: mint + 365 days. Rotation is mint-new-then-revoke-old. */
export const READ_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Per-token rate floor — [decision §1 "Rate limiting"]. No Redis exists on this
 * deployment, so v1 uses the `lastUsedAt` column the row already maintains: an
 * accepted request must be at least this far after the previous accepted one.
 */
export const READ_TOKEN_MIN_INTERVAL_MS = 1000;

/** Raw token. Returned to the caller exactly once at mint, never logged, never stored. */
export function generateReadToken(): string {
  return READ_TOKEN_PREFIX + randomBytes(24).toString('base64url');
}

/** SHA-256 of the full token, lower-case hex — the value persisted as `hashedToken`. */
export function readTokenDigestHex(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The display fragments a list view may show. `prefix` is the fixed `relay_rt_`
 * (kept as a column so a future format bump is per-row data, not a code-level guess);
 * `lastFour` is the trailing four characters — 24 bits, not enough to recover anything.
 */
export function readTokenDisplayParts(token: string): {
  prefix: string;
  lastFour: string;
} {
  return { prefix: READ_TOKEN_PREFIX, lastFour: token.slice(-4) };
}

/**
 * Cheap shape check, no crypto: fixed prefix + exactly 32 base64url characters. Its job
 * is to keep a stray session cookie, a `RELAY_API_SECRET`, or an ingest token from ever
 * reaching the lookup — a bearer that is not a read token is rejected without a query.
 */
export function isWellFormedReadToken(token: string): boolean {
  return /^relay_rt_[A-Za-z0-9_-]{32}$/.test(token);
}

/** Extracts the token from `Authorization: Bearer <token>`; '' when absent or malformed. */
export function bearerTokenFrom(header: string | string[] | undefined): string {
  if (!header || Array.isArray(header)) return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

/**
 * Constant-time compare of a presented token against a stored SHA-256 hex digest.
 * Both sides are reduced to 32-byte buffers first; a malformed stored digest (wrong
 * length) is a mismatch, not an exception.
 */
export function readTokenDigestMatches(
  presented: string,
  storedHashedToken: string
): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  let b: Buffer;
  try {
    b = Buffer.from(storedHashedToken, 'hex');
  } catch {
    return false;
  }
  if (b.length !== a.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Liveness, decided in the application rather than in SQL so every dead state maps to
 * the same 401 body (the lookup function returns the row regardless). `now` is a
 * parameter so tests do not have to fake the clock.
 */
export function isReadTokenLive(
  row: { revokedAt: Date | null; expiresAt: Date },
  now: Date = new Date()
): boolean {
  if (row.revokedAt !== null) return false;
  return row.expiresAt.getTime() > now.getTime();
}
