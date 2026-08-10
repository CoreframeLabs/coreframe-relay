import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

import { generateCatcherToken } from '@/lib/relay/catcherTokens';

/**
 * GET/POST /api/relay/catcher/:token — the built-in catcher. [RELAY-50, last AC]
 *
 * Why this exists: onboarding must not stop at "point the destination at your server",
 * because a new user does not HAVE a server — they came to Relay because Stripe point-
 * to-point is the thing they are trying to avoid. The catcher is a per-route webhook
 * receiver reachable from any browser, so "send a test webhook to a real URL" works
 * the moment the route is created.
 *
 * The URL IS the credential, exactly like the ingest token itself. Routing by it is
 * a lookup, not an authentication: a guessed catcher URL can only append rows to the
 * one inbox it names, which is the same trust model as a Nylas/Webhook.site UUID.
 *
 * Ring buffer. State lives in a module-global `Map` keyed by digest(token), which
 * Next dev hot-reloading does NOT preserve — that is deliberate. The catcher is a
 * demonstration aid, not a message store. Bounded to the last 20 payloads per token
 * and 2,048 body bytes per payload, so the "viewed from two terminals at once"
 * failure of a naive singleton shows up in dev, not in a customer's first thirty seconds.
 *
 * No session auth; `middleware.ts` opts this path out of the dashboard session because
 * the receiver's whole point is to be callable from a webhook deliverer that has none.
 */

export const config = { api: { bodyParser: false } };

/** Cache-Control constant shared by GET and POST so neither end is stale. */
const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

const MAX_KEPT_PER_TOKEN = 20;
const MAX_BODY_BYTES = 2048;

/**
 * Token shape: 24 random bytes, base64url = 32 chars. The shape matters only to stop
 * enumeration-by-growing — a longer token gives the same search space and a shorter
 * one gives less, with zero useful signal in the difference.
 */
const CATCHER_TOKEN_REGEX = /^[A-Za-z0-9_-]{32}$/;

/**
 * Storage is per-process. The trade-off is honest: this is dev, and the
 * durability story for the destination the customer ACTUALLY owns is [RELAY-5]'s
 * DeliveryLog, not this inbox.
 */
const catcherStore = new Map<string, {
  requests: Array<{
    at: string;
    method: string;
    contentType: string | null;
    body: string;
  }>;
}>();

/** Key the ring buffer by digest so a memory-dump cannot be used as a token. */
function bufferKey(digest: string) {
  return digest;
}

function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Read the raw request body without letting Next parse it first. */
async function readRawBody(readable: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The exported helper lives in `lib/relay/catcherTokens.ts`; re-exports route handlers
 * import it from there so this file's only public symbols are its API contract. */
void generateCatcherToken;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const token = Array.isArray(req.query.token)
    ? req.query.token[0]
    : (req.query.token as string | undefined);

  // A malformed token shape answers 404, not 400 — the catcher tells the internet
  // nothing about what exists. Same reasoning as the ingest path itself.
  if (!token || !CATCHER_TOKEN_REGEX.test(token)) {
    return res.status(404).json({ error: 'not_found' });
  }

  const key = bufferKey(digestToken(token));

  if (req.method === 'GET') {
    const inbox = catcherStore.get(key);
    res.setHeader('Cache-Control', NO_STORE['Cache-Control']);
    res.setHeader('Content-Type', NO_STORE['Content-Type']);
    return res.status(200).json({
      data: {
        kept: inbox?.requests.length ?? 0,
        requests: inbox ? [...inbox.requests].reverse() : [],
      },
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'bad_request' });
  }

  const rawBody = await readRawBody(req);
  const body =
    rawBody.length > MAX_BODY_BYTES
      ? rawBody.slice(0, MAX_BODY_BYTES) + '…[truncated]'
      : rawBody;

  const entry = {
    at: new Date().toISOString(),
    method: req.method ?? 'POST',
    contentType: (req.headers['content-type'] as string | undefined) ?? null,
    body,
  };

  const existing = catcherStore.get(key) ?? { requests: [] };
  existing.requests.push(entry);
  if (existing.requests.length > MAX_KEPT_PER_TOKEN) {
    existing.requests.splice(0, existing.requests.length - MAX_KEPT_PER_TOKEN);
  }
  catcherStore.set(key, existing);

  res.setHeader('Cache-Control', NO_STORE['Cache-Control']);
  res.setHeader('Content-Type', NO_STORE['Content-Type']);
  return res.status(200).json({ ok: true, index: existing.requests.length - 1 });
}
