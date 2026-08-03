import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../types/bindings.js';

/** Header carrying the correlation id, end to end: proxy → QStash → consumer → DB row. */
export const REQUEST_ID_HEADER = 'relay-request-id';

/**
 * Attach a request id to every request and echo it on the response.
 *
 * An inbound id is honoured so a caller can correlate across their own systems, but only
 * if it is a well-formed UUID. Accepting arbitrary caller-controlled strings would let
 * them collide ids deliberately — and `requestId` is `@unique` on DeliveryLog, so a
 * collision is not cosmetic: it would suppress a legitimate delivery as a duplicate.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const inbound = c.req.header(REQUEST_ID_HEADER);
  const id = inbound && UUID_RE.test(inbound) ? inbound.toLowerCase() : crypto.randomUUID();

  c.set('requestId', id);
  c.header(REQUEST_ID_HEADER, id);
  await next();
});
