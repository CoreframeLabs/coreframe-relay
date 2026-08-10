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
  '/api/relay/qstash',
  // [RELAY-50] Local-only test delivery sink. Auth is NOT a signature — it is the
  // RELAY_API_SECRET shared with the proxy's dev environment, because the value of
  // the local loop is proving the pipeline end-to-end, and a signature-verified
  // receiver cannot be told "the signature was made by the proxy you are testing".
  '/api/relay/qstash-test',
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
];

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Bypass routes that don't require authentication
  if (micromatch.isMatch(pathname, unAuthenticatedRoutes)) {
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
