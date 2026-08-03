import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { health } from './routes/health.js';
import { requestId } from './middleware/requestId.js';
import type { AppEnv } from './types/bindings.js';

/**
 * Coreframe Relay — inbound webhook proxy.
 *
 * Deliberately separate from the Next.js dashboard: webhook ingestion must accept a POST
 * in single-digit milliseconds with no cold start, which is what a Cloudflare Worker gives
 * and a serverless Next.js function does not.
 *
 * [RELAY-3] is the skeleton only — bindings, request ids, error handling, /health.
 * Ingestion (`POST /in/:teamSlug/:routeSlug`), the SSRF validator and the QStash publish
 * are [RELAY-4].
 */
const app = new Hono<AppEnv>();

// First, so every log line and every error response carries a correlation id.
app.use('*', requestId);

app.route('/health', health);

/**
 * Global error handler.
 *
 * Two rules. Callers get the request id, so a support conversation can start with a fact
 * instead of a timestamp. Callers never get an internal message: an unexpected throw can
 * carry a connection string or a destination URL, and this endpoint is public.
 */
app.onError((err, c) => {
  const id = c.get('requestId');

  if (err instanceof HTTPException) {
    // Intentional, already-safe messages — raised by our own middleware and routes.
    return c.json({ error: err.message, requestId: id }, err.status);
  }

  console.error(
    JSON.stringify({
      level: 'error',
      event: 'proxy.unhandled_error',
      requestId: id,
      path: c.req.path,
      method: c.req.method,
      reason: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
  );

  return c.json({ error: 'internal error', requestId: id }, 500);
});

app.notFound((c) =>
  c.json({ error: 'not found', requestId: c.get('requestId') }, 404)
);

/**
 * Default export ONLY.
 *
 * The Workers runtime treats every named export of the entry module as a service-binding
 * target and requires each to be a function or ExportedHandler. Re-exporting a plain
 * constant here fails the whole Worker at startup with:
 *
 *   Incorrect type for map entry 'REQUEST_ID_HEADER': the provided value is not of
 *   type 'function or ExportedHandler'
 *
 * `app.request()` unit tests cannot catch this — it only appears under the real runtime.
 * Import shared constants from their own module (`./middleware/requestId.js`) instead.
 */
export default app;
