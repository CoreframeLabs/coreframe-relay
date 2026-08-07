import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-route ingest tokens — [RELAY-57].
 *
 * 24 random bytes → base64url-unpadded, 32 chars, 192-bit entropy. The token is the
 * credential Stripe/Shopify/GitHub/Meta cannot attach to a header, so it travels as a
 * URL path segment: `POST /in/:teamSlug/:routeSlug/:ingestToken`.
 *
 * High-entropy means GUESSING is the only attack, and the proxy answers every bad
 * guess with the same 404 it answers a mistyped slug with — a brute-forcer learns
 * nothing per attempt.
 *
 * RELAY-4's shared `RELAY_API_SECRET` remains an accepted alternative during the
 * migration; the two credentials are generated and compared in separate arms and
 * neither is ever derived from the other.
 */

/** Raw token for the URL path. Never logs, never returned in an error body. */
export function generateIngestToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Constant-time compare against a stored token, digest-first for the same reason as
 * `lib/relay/internalAuth.ts`: the digests are always 32 bytes, so the loop length
 * cannot leak the secret length, and neither side is recoverable from the digest.
 * Zero-dependency analogue of the proxy's `timingSafeEqualStrings`.
 */
export function ingestTokenMatches(presented: string, expected: string): boolean {
  const digest = (v: string): Buffer =>
    createHash('sha256').update(v, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}
