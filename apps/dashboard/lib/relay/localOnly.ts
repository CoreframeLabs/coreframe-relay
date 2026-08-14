/**
 * Local-only endpoint guard — [RELAY-72], [RELAY-74].
 *
 * Two Relay endpoints exist so the pipeline can be proven end to end on one box:
 * `/api/relay/qstash-test` (the local stand-in for the QStash consumer) and
 * `/api/relay/smoke-destination` (the faux destination the launch smoke drives a 500
 * and a 200 through). Neither may answer on a deployed dashboard.
 *
 * WHY THIS IS A MODULE AND NOT A COMMENT.
 *
 * Both endpoints previously carried a *promise* rather than a control. `smoke-destination`
 * said "Local-only by construction ... must not ship on a deployed dashboard" and had
 * nothing enforcing it; `qstash-test` said "Never deployed, because the binding that routes
 * the proxy here (`RELAY_LOCAL_QUEUE_URL`) is never set on a deployed Worker" — which is a
 * statement about the PROXY's configuration, not about who can reach the DASHBOARD. Anyone
 * on the internet can POST to a Next.js API route regardless of what the Worker is bound to.
 * `next build` compiles everything under `pages/api/`, so both shipped.
 *
 * THE CONTROL, in the order it is evaluated. Any single failing arm refuses.
 *
 *  1. **Deploy-platform markers are an unconditional refusal.** Vercel, Render, Fly,
 *     Lambda, Cloud Run and Railway each inject a variable of their own into the runtime.
 *     This arm does not depend on one variable being *unset* — the failure mode that made
 *     `RELAY_LOCAL_QUEUE_URL` a bad gate — it depends on a *set* variable, which is the
 *     direction that fails safe. A new platform we have never deployed to falls through
 *     to arm 3 and is still refused by the Host check.
 *
 *  2. **A non-production build is allowed.** `next dev` and a local `NODE_ENV=test` run are
 *     the environments the smoke and the local loop actually run in.
 *
 *  3. **A production build is allowed only on a loopback Host.** `next build && next start`
 *     on a laptop sets `NODE_ENV=production`, and the smoke is meant to run against exactly
 *     that. The Host header is caller-controlled, which is why it is never the ONLY arm:
 *     on any real deployment arm 1 has already refused, and a platform that routes by Host
 *     will not deliver `Host: localhost` to our origin in the first place.
 *
 * The caller answers 404, not 401 or 403. There is no credential that makes these endpoints
 * legitimate on a deployed dashboard, so "unauthorized" would be a lie that invites a retry;
 * on a deployed dashboard the honest answer is that the endpoint does not exist there.
 */

/**
 * Variables injected by the platform, not by us. Presence means "this process is running
 * somewhere other than a developer's machine", whatever `NODE_ENV` claims.
 */
const DEPLOY_PLATFORM_MARKERS = [
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'RENDER',
  'FLY_APP_NAME',
  'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_EXECUTION_ENV',
  'K_SERVICE',
  'RAILWAY_ENVIRONMENT',
  'NETLIFY',
  'HEROKU_APP_NAME',
] as const;

/** Hosts that can only mean "the request never left this machine". */
const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '127.0.0.1',
  '::1',
]);

export type LocalOnlyVerdict =
  | { ok: true }
  | { ok: false; reason: 'deploy_platform' | 'remote_host' };

/**
 * Strip the port and the IPv6 brackets off a `Host` header.
 * `[::1]:4002` → `::1`, `localhost:4002` → `localhost`.
 */
export function hostnameFromHostHeader(host: string | undefined): string {
  if (!host) return '';
  const trimmed = host.trim().toLowerCase();

  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  if (v6?.[1]) return v6[1];

  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon > -1 && /^\d+$/.test(trimmed.slice(lastColon + 1))) {
    return trimmed.slice(0, lastColon);
  }
  return trimmed;
}

/** True when a deployment platform has stamped this process as its own. */
export function isDeployedPlatform(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return DEPLOY_PLATFORM_MARKERS.some((marker) => {
    const value = environment[marker];
    return typeof value === 'string' && value.length > 0;
  });
}

/**
 * The verdict for one request. Takes the `Host` header rather than the request object so
 * it is testable without constructing a `NextApiRequest`, and usable from the Edge
 * middleware, which has a different request type entirely.
 */
export function localOnlyVerdict(
  hostHeader: string | undefined,
  environment: NodeJS.ProcessEnv = process.env
): LocalOnlyVerdict {
  if (isDeployedPlatform(environment)) {
    return { ok: false, reason: 'deploy_platform' };
  }

  if (environment.NODE_ENV !== 'production') {
    return { ok: true };
  }

  const hostname = hostnameFromHostHeader(hostHeader);
  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    return { ok: true };
  }

  return { ok: false, reason: 'remote_host' };
}
