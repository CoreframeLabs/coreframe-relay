import micromatch from 'micromatch';
import { getToken } from 'next-auth/jwt';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import env from './lib/env';

// Constants for security headers
const SECURITY_HEADERS = {
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=()',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-site',
} as const;

// Generate CSP
const generateCSP = (): string => {
  const policies = {
    'default-src': ["'self'"],
    'img-src': [
      "'self'",
      'boxyhq.com',
      '*.boxyhq.com',
      '*.dicebear.com',
      'data:',
    ],
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      '*.gstatic.com',
      '*.google.com',
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'connect-src': [
      "'self'",
      '*.google.com',
      '*.gstatic.com',
      'boxyhq.com',
      '*.ingest.sentry.io',
      '*.mixpanel.com',
    ],
    'frame-src': ["'self'", '*.google.com', '*.gstatic.com'],
    'font-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };

  return Object.entries(policies)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .concat(['upgrade-insecure-requests'])
    .join('; ');
};

// Add routes that don't require authentication
const unAuthenticatedRoutes = [
  '/api/hello',
  '/api/health',
  '/api/auth/**',
  '/api/oauth/**',
  '/api/scim/v2.0/**',
  '/api/invitations/*',
  '/api/webhooks/stripe',
  '/api/webhooks/dsync',
  // ── Relay machine-to-machine endpoints [RELAY-5] ──
  // Both callers are programs, not browsers: the Cloudflare Worker proxy and QStash.
  // Left out of this list they would be redirected to `/auth/login`, so a Worker asking
  // for a route would receive a 307 and an HTML page instead of JSON — and QStash would
  // read that redirect as a delivery failure and retry a webhook that never arrived.
  //
  // Each is named EXACTLY, not by wildcard. `/api/relay/internal/*` would silently
  // un-authenticate any future file dropped into that directory; this way a new internal
  // endpoint has to make that choice explicitly.
  //
  // Neither is unauthenticated in the real sense — they authenticate themselves:
  // route-lookup by constant-time bearer comparison against RELAY_API_SECRET, qstash by
  // QStash's request signature, both before touching any data.
  '/api/relay/internal/route-lookup',
  // [RELAY-68] Internal n8n-channel metrics reporting endpoint — same reasoning as
  // route-lookup.ts above (a non-browser caller authenticating itself via
  // RELAY_API_SECRET, not a NextAuth session) and same exact-path-not-wildcard
  // discipline: /api/relay/internal/* would silently un-authenticate any future
  // file dropped into that directory.
  '/api/relay/internal/n8n-channel-metrics',
  '/api/relay/qstash',
  // [RELAY-44] Vercel Cron invokes this with no NextAuth session — only a
  // `CRON_SECRET` bearer token, checked inside the handler itself
  // (`pages/api/relay/internal/dlq-health-check.ts`). Left off this list it would
  // 307 to `/auth/login` before the handler's own auth ever ran, and the cron would
  // "succeed" against an HTML page every invocation. Named exactly, same reasoning
  // as route-lookup above: `/api/relay/internal/*` would silently un-authenticate
  // any future file dropped into that directory.
  '/api/relay/internal/dlq-health-check',
  // [RELAY-50] The catcher is a per-route webhook receiver, and its whole point is
  // reachable from the browser for a user who has not yet wired a destination. The URL
  // is the credential (same reasoning as the ingest token itself, RELAY-57). It must
  // therefore not be session-gated — the dashboard session is not what authenticates
  // a webhook receiver.
  '/api/relay/catcher/*',
  '/auth/**',
  '/invitations/*',
  '/terms-condition',
  '/unlock-account',
  '/login/saml',
  '/.well-known/*',
  // [RELAY-79 / RELAY-82] Terms of Service and the Refund/Cancellation Policy must be
  // readable by a signed-out visitor: `AgreeMessage.tsx` links `/terms` (via
  // `NEXT_PUBLIC_TERMS_URL`) from the join/login screens with `target="_blank"`, before
  // a session exists, and Stripe's own go-live requirements expect a terms/refund link
  // reachable without an account. Without this entry the middleware would 307 an
  // anonymous visitor to `/auth/login` instead of showing the page.
  '/terms',
  '/refund-policy',
  // [RELAY-80 / RELAY-81] Same reasoning as RELAY-79/82 above, for the Privacy Notice
  // and DPA (`NEXT_PUBLIC_PRIVACY_URL` / `NEXT_PUBLIC_DPA_URL`) — landed on a parallel
  // branch that never touched this file, so these two were missing from the allowlist
  // even after RELAY-79/82's entries above were added. Found 2026-08-20 by curling
  // production directly post-deploy: both 307'd to /auth/login instead of rendering,
  // which defeats a public legal document's entire purpose.
  '/privacy',
  '/dpa',
  // [RELAY-108] Docs surface and the public pricing page. Exact same failure mode
  // RELAY-80/81 hit above — a route existing under `pages/` is not enough, this
  // list is a *separate*, positive allowlist, and anything missing from it 307s to
  // `/auth/login` regardless of whether the page itself requires no auth. Verified
  // by curling this worktree's own build post-change (see the commit message for the
  // actual status codes measured, not "should work"): `/docs`, `/docs/integrations/n8n`
  // and `/pricing` all 307'd before this entry was added, exactly like /privacy and
  // /dpa did. `/docs/**` covers `/docs/integrations/n8n` and any future nested docs
  // page without a second entry per page — `/docs` itself still needs its own exact
  // entry because micromatch's `**` does not match a zero-segment remainder.
  '/docs',
  '/docs/**',
  '/pricing',
];

/**
 * Paths that are unauthenticated ONLY in a non-production build — [RELAY-72], [RELAY-74].
 *
 * Both are local-only test rigs, and both previously sat in the list above unconditionally:
 *
 *  - `/api/relay/qstash-test` [RELAY-50] is the local stand-in for the QStash consumer.
 *    It skips `verifySignature` and takes its destination from a caller-supplied envelope,
 *    so an unauthenticated production entry is a forged-envelope injection into the
 *    forward path. Its own auth is the RELAY_API_SECRET shared with the proxy's dev
 *    environment — a signature-verified receiver cannot be told "the signature was made
 *    by the proxy you are testing", which is why it is a bearer and not a signature.
 *  - `/api/relay/smoke-destination` [RELAY-66] is the faux destination the launch smoke
 *    drives a 500 and then a 200 through. It genuinely cannot hold a credential: the DLQ
 *    retry path (RELAY-8) replays the envelope with EMPTY headers, so no Bearer the route
 *    was created with could ever reach a retried delivery.
 *
 * Without an entry here in local dev the middleware would redirect the pipeline's own
 * outbound POST to `/auth/login`, and the smoke leg could never drive a failure or a retry
 * through the real pipeline. `NODE_ENV` is inlined into the Edge bundle at build time, so
 * in a production build these strings are not merely unmatched — the entries do not exist.
 *
 * This is the OUTER of two independent controls. Each handler also calls
 * `localOnlyVerdict` itself and answers 404, so a session-authenticated user on a deployed
 * dashboard (who would pass the middleware regardless of this list) still cannot reach one.
 */
const localOnlyUnauthenticatedRoutes =
  process.env.NODE_ENV === 'production'
    ? []
    : ['/api/relay/qstash-test', '/api/relay/smoke-destination'];

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Bypass routes that don't require authentication
  if (
    micromatch.isMatch(pathname, unAuthenticatedRoutes) ||
    micromatch.isMatch(pathname, localOnlyUnauthenticatedRoutes)
  ) {
    return NextResponse.next();
  }

  const redirectUrl = new URL('/auth/login', req.url);
  redirectUrl.searchParams.set('callbackUrl', encodeURI(req.url));

  // JWT strategy
  if (env.nextAuth.sessionStrategy === 'jwt') {
    const token = await getToken({
      req,
    });

    if (!token) {
      return NextResponse.redirect(redirectUrl);
    }
  }

  // Database strategy
  else if (env.nextAuth.sessionStrategy === 'database') {
    const url = new URL('/api/auth/session', req.url);

    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        cookie: req.headers.get('cookie') || '',
      },
    });

    const session = await response.json();

    if (!session.user) {
      return NextResponse.redirect(redirectUrl);
    }
  }

  const requestHeaders = new Headers(req.headers);
  const csp = generateCSP();

  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  if (env.securityHeadersEnabled) {
    // Set security headers
    response.headers.set('Content-Security-Policy', csp);
    Object.entries(SECURITY_HEADERS).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }

  // All good, let the request through
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth/session).*)'],
};
