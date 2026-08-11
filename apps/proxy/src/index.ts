import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { health } from './routes/health.js';
import { ingest } from './routes/ingest.js';
import { requestId } from './middleware/requestId.js';
import type { AppEnv } from './types/bindings.js';

/**
 * Coreframe Relay — inbound webhook proxy.
 *
 * Deliberately separate from the Next.js dashboard: webhook ingestion must accept a POST
 * in single-digit milliseconds with no cold start, which is what a Cloudflare Worker gives
 * and a serverless Next.js function does not.
 *
 * [RELAY-3] is the skeleton — bindings, request ids, error handling, /health.
 * [RELAY-4] adds ingestion: `POST /in/:teamSlug/:routeSlug`, authenticated, SSRF-checked
 * and published to QStash.
 *
 * [RELAY-67] adds a Cron Trigger — the Worker fires once a day to hit the dashboard's
 * health endpoint, so a quiet week can never pause the production database. The
 * `scheduled` handler lives here with `fetch` because a Worker's entry module may
 * export at most one default ExportedHandler with all of its entry points on it.
 */
const app = new Hono<AppEnv>();

// First, so every log line and every error response carries a correlation id.
app.use('*', requestId);

app.route('/health', health);
app.route('/in', ingest);

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
 * The same rule holds for the Cron Trigger: `scheduled` lives here, not as a named export.
 */
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
 * The same rule holds for the Cron Trigger: `scheduled` lives here, not as a named export.
 */
/** The Hono app, exported for tests (`app.request(...)`) — not a service-binding name. */
export { app };

const relayWorker: ExportedHandler<AppEnv['Bindings']> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  async scheduled(
    controller: ScheduledController,
    env: AppEnv['Bindings'],
    ctx: ExecutionContext
  ): Promise<void> {
    // [RELAY-67] Keep-warm ping, daily. A non-2xx logs and the health-signal pipeline
    // (RELAY-44, when it exists) is where the alert goes; for now it is a console.error
    // visible in `wrangler tail`, which a human can see during bring-up. The dashboard's
    // /api/health exists and does the one real DB read — nothing to invent here.
    const target = env.RELAY_DASHBOARD_HEALTH_URL;
    if (!target) {
      // Explicit no-op: a missing binding is configuration, not a bug, and we want the
      // silence in the tail to still say the cron ran and why it did nothing.
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'proxy.keepwarm.no_target',
          cron: controller.cron,
          reason: 'RELAY_DASHBOARD_HEALTH_URL not set',
        })
      );
      return;
    }

    ctx.waitUntil(
      (async () => {
        const started = Date.now();
        const res = await fetch(target, {
          headers: { 'user-agent': 'coreframe-relay-proxy/keep-warm' },
        });
        const ms = Date.now() - started;
        const body = await res.text().catch(() => '');
        const log = {
          level: res.ok ? 'info' : 'error',
          event: 'proxy.keepwarm.ping',
          cron: controller.cron,
          target: new URL(target).pathname,
          status: res.status,
          ms,
          version: (() => {
            try {
              return JSON.parse(body)?.version ?? null;
            } catch {
              return null;
            }
          })(),
        };
        if (res.ok) {
          console.log(JSON.stringify(log));
        } else {
          console.error(JSON.stringify(log));
        }
      })()
    );
  },
};

// Unit tests run `app.request(...)` against a Hono app; the production runtime consumes
// the Module-Worker default export. Expose the test surface on the Module Worker too so
// the same import shape serves both (the property is ignored by `wrangler` and the
// Workers runtime — only `fetch`, `scheduled`, `queue`, `email`, `tail`, ` traces`,
// `rpc`, etc. are entry points).
const defaultExport = relayWorker as typeof relayWorker & {
  request: (input: string, init?: RequestInit, env?: AppEnv['Bindings']) => Promise<Response>;
};
defaultExport.request = app.request.bind(app);

export default defaultExport;
