import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextApiRequest } from 'next';

/**
 * Bearer authentication for the proxy → dashboard internal endpoints. Added in [RELAY-5].
 *
 * The caller is a Cloudflare Worker, not a user, so none of BoxyHQ's session machinery
 * applies. What authenticates it is a single shared secret, which makes the comparison
 * itself a security control rather than a formality:
 *
 *  - **Constant time.** `a === b` on a secret returns as soon as it finds a differing
 *    byte, so the time it takes leaks how many leading bytes were right. That is a
 *    practical byte-at-a-time oracle against an attacker who can measure it. Both sides
 *    are hashed to a fixed 32 bytes first, which also removes the length leak
 *    `timingSafeEqual` would otherwise cause by throwing on mismatched buffer lengths.
 *
 *  - **Fail closed.** If `RELAY_API_SECRET` is unset or empty, every request is rejected.
 *    The tempting alternative — skip the check when no secret is configured, "for local
 *    dev" — turns a missing environment variable in production into an open endpoint,
 *    which is the worst possible way to learn a deploy was misconfigured.
 */

/** Hash to a fixed width so the comparison is length-independent and constant time. */
const digest = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

/** Extracts the token from `Authorization: Bearer <token>`; '' when absent or malformed. */
const bearerToken = (header: string | undefined): string => {
  if (!header) return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
};

/**
 * True only when the request carries the configured `RELAY_API_SECRET` as a bearer token.
 *
 * Deliberately returns a boolean rather than throwing a typed error: the caller must not
 * be able to tell "no secret configured" from "wrong secret" from the response, and a
 * distinct error type invites a distinct error body.
 */
export function isAuthorizedInternalRequest(req: NextApiRequest): boolean {
  const expected = process.env.RELAY_API_SECRET;
  if (!expected) {
    // Logged, because a permanently-401ing internal endpoint is otherwise silent and
    // looks identical to the proxy being misconfigured. The secret itself never appears.
    console.error(
      '[relay] RELAY_API_SECRET is not set — internal endpoints are refusing every request.'
    );
    return false;
  }

  const provided = bearerToken(req.headers.authorization);
  if (!provided) return false;

  return timingSafeEqual(digest(provided), digest(expected));
}
