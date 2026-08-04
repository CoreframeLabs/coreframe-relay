import { Hono } from 'hono';
import type { AppEnv } from '../types/bindings.js';

/**
 * GET /health — uptime and configuration check.
 *
 * Deliberately unauthenticated: this is what an uptime monitor and Cloudflare's own
 * health checks hit, and requiring a secret to learn "is it up" defeats the purpose.
 *
 * It therefore leaks NOTHING sensitive. `configured` reports whether each secret is
 * PRESENT — never its value, and never a prefix. That distinction matters: a health
 * endpoint that echoes even four characters of a token is a credential oracle.
 */
export const health = new Hono<AppEnv>().get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'coreframe-relay-proxy',
    environment: c.env.ENVIRONMENT ?? 'unknown',
    requestId: c.get('requestId'),
    // Booleans only. Presence, not content.
    configured: {
      relayApiSecret: Boolean(c.env.RELAY_API_SECRET),
      qstash: Boolean(c.env.UPSTASH_QSTASH_URL && c.env.UPSTASH_QSTASH_TOKEN),
      kv: Boolean(c.env.RELAY_KV),
      // [RELAY-4]: ingestion cannot resolve a route without this, so an operator needs to
      // see its absence here rather than infer it from a 503 on the hot path.
      dashboard: Boolean(c.env.RELAY_DASHBOARD_URL),
    },
    timestamp: new Date().toISOString(),
  });
});
