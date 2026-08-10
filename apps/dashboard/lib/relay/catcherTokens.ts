import { randomBytes } from 'node:crypto';

/**
 * Per-catcher-URL tokens — [RELAY-50].
 *
 * A catcher inbox is reachable at `/api/relay/catcher/:token`, and the URL IS the
 * credential, same shape as the ingest token itself (RELAY-57). 24 random bytes,
 * base64url: 32 chars, 192-bit entropy, URL-safe by construction.
 */
export function generateCatcherToken(): string {
  return randomBytes(24).toString('base64url');
}
