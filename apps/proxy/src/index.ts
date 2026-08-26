import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as Sentry from '@sentry/cloudflare';
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

  // [RELAY-44] Only genuinely unexpected errors reach here — HTTPException (the
  // deliberate, already-correct 413/502/429/etc. responses) is handled and returned
  // above without ever hitting this branch. Explicit `error` level, matching the
  // dashboard's own established pattern (`dlq-health-check.ts`'s
  // `Sentry.captureException(..., { level: 'error' })`) so this rides the SAME
  // confirmed-firing Sentry alert rule (id 739692) rather than the SDK's default level.
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
    level: 'error',
  });

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
        try {
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
            // [RELAY-67/RELAY-44] This is the exact gap both tickets track: a non-2xx
            // keep-warm response previously only reached `console.error`, visible only
            // to a human already running `wrangler tail`. Explicit `error` level,
            // mirroring the dashboard's `dlq-health-check.ts` pattern, so it rides the
            // SAME confirmed-firing Sentry alert rule (id 739692) the dashboard side
            // already uses.
            Sentry.captureException(
              new Error(
                `[RELAY-67] Keep-warm ping to ${new URL(target).pathname} failed with status ${res.status}`
              ),
              { level: 'error' }
            );
          }
        } catch (error) {
          // A thrown fetch (DNS failure, connection refused, etc.) previously became an
          // unhandled rejection inside this `waitUntil` promise with NO log line at
          // all — worse than the non-2xx case above, and exactly the kind of silent
          // loss RELAY-44 is about. Logged AND captured for the same reason.
          const ms = Date.now() - started;
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'proxy.keepwarm.ping_error',
              cron: controller.cron,
              target: new URL(target).pathname,
              ms,
              reason: error instanceof Error ? error.message : String(error),
            })
          );
          Sentry.captureException(
            error instanceof Error ? error : new Error(String(error)),
            { level: 'error' }
          );
        }
      })()
    );
  },
};

/**
 * [RELAY-67 / RELAY-44] `@sentry/cloudflare` — Sentry's own documented SDK for a plain
 * Cloudflare Workers `ExportedHandler` (NOT `@sentry/nextjs`, which the dashboard uses
 * and which never runs in the Workers runtime — see `apps/dashboard/instrumentation.ts`
 * for that side, kept as reference only, not reused).
 *
 * `withSentry` MUTATES `relayWorker` in place (wraps its `.fetch`/`.scheduled` methods)
 * and returns that SAME object reference — confirmed by reading the installed package's
 * `withSentry.js`, not assumed — so this composes safely with the `.request` test-surface
 * property attached below; there is no second object whose extra properties would be
 * dropped.
 *
 * The options callback returning `undefined` when `SENTRY_DSN` is unset is the SDK's own
 * documented way to leave Sentry fully disabled — required here because this Worker must
 * still boot and answer /health with no secret configured, same as every other optional
 * binding in `types/bindings.ts`. `nodejs_compat` (which this SDK needs for
 * `AsyncLocalStorage`) is already set in `wrangler.toml`'s `compatibility_flags` — no
 * change needed there.
 *
 * PINNED (not caret) at `10.67.0` in `package.json`, not the newest `@sentry/cloudflare`
 * (10.71.0 at research time): `npm view @sentry/cloudflare@10.68.0 peerDependencies`
 * shows 10.68.0 added a `wrangler: ^4.x` peer, and this repo pins `wrangler ^3.99.0`.
 * `10.67.0` is the newest release before that peer requirement landed and has no
 * wrangler peer at all. Bumping to wrangler 4 to unlock a newer Sentry SDK is a real,
 * separate decision, not made here.
 */
const instrumentedWorker = Sentry.withSentry(
  (env: AppEnv['Bindings']) =>
    env.SENTRY_DSN ? { dsn: env.SENTRY_DSN, tracesSampleRate: 0 } : undefined,
  relayWorker
);

// Unit tests run `app.request(...)` against a Hono app; the production runtime consumes
// the Module-Worker default export. Expose the test surface on the Module Worker too so
// the same import shape serves both (the property is ignored by `wrangler` and the
// Workers runtime — only `fetch`, `scheduled`, `queue`, `email`, `tail`, ` traces`,
// `rpc`, etc. are entry points).
const defaultExport = instrumentedWorker as typeof relayWorker & {
  request: (input: string, init?: RequestInit, env?: AppEnv['Bindings']) => Promise<Response>;
};
defaultExport.request = app.request.bind(app);

export default defaultExport;
