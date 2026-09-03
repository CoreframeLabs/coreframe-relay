/**
 * @jest-environment node
 */

/**
 * [security-hardening] Regression test for a real gap found reviewing `middleware.ts`:
 * the CSP / `Referrer-Policy` / `Permissions-Policy` / `Cross-Origin-*` header block
 * only ran on the FINAL return of `middleware()` — the branch reached only by a
 * request that (a) did not match the unauthenticated allowlist AND (b) already had a
 * valid session. Every early return skipped it entirely:
 *
 *   - the unauthenticated-allowlist bypass (`/pricing`, `/docs`, `/terms`, `/privacy`,
 *     every webhook endpoint, `/auth/**` itself, …) returned `NextResponse.next()`
 *     with no headers at all;
 *   - an anonymous visitor being redirected to `/auth/login` got a bare redirect with
 *     no headers either — meaning the login page an attacker would try to iframe for
 *     clickjacking is exactly the response this bug left unprotected.
 *
 * Confirmed empirically against production BEFORE this fix (curl -D- against
 * relay.coreframe-labs.dev/auth/login and /pricing): no `content-security-policy`,
 * `referrer-policy`, `permissions-policy`, or `cross-origin-*` header on either
 * response — only the static HSTS/X-Frame-Options/X-Content-Type-Options headers
 * `next.config.js`'s `headers()` sets independently.
 *
 * A second, compounding bug: even the one branch that DID set these headers gated
 * them on `env.securityHeadersEnabled` (`SECURITY_HEADERS_ENABLED` env var), which is
 * unset in every `.env*` in this repo and undocumented in `.env.example` — so even a
 * request that reached the final branch got no CSP in practice. This test asserts the
 * headers are present unconditionally, with no env var required, matching the fix in
 * `middleware.ts` that removed the gate entirely.
 */

import { NextRequest } from 'next/server';

jest.mock('next-auth/jwt', () => ({
  __esModule: true,
  getToken: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getToken } = require('next-auth/jwt') as { getToken: jest.Mock };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const middleware = require('../../middleware').default;

const EXPECTED_HEADERS: Record<string, string> = {
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=()',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
};

function assertFullySecured(response: Response) {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    expect(response.headers.get(name)).toBe(value);
  }
  const csp = response.headers.get('content-security-policy');
  expect(csp).toBeTruthy();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
}

describe('[security-hardening] middleware stamps security headers on every response path', () => {
  beforeEach(() => {
    getToken.mockReset();
  });

  it('the unauthenticated-allowlist bypass (e.g. /pricing) still gets full headers', async () => {
    const req = new NextRequest(new URL('https://relay.coreframe-labs.dev/pricing'));
    const res = await middleware(req);

    // Bug behaviour would have been NextResponse.next() with none of these set.
    assertFullySecured(res);
  });

  it('/auth/login itself (also allowlisted) gets full headers', async () => {
    const req = new NextRequest(new URL('https://relay.coreframe-labs.dev/auth/login'));
    const res = await middleware(req);

    assertFullySecured(res);
  });

  it('the anonymous-visitor redirect to /auth/login gets full headers, not a bare redirect', async () => {
    getToken.mockResolvedValue(null);
    const req = new NextRequest(new URL('https://relay.coreframe-labs.dev/dashboard'));
    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/auth/login');
    assertFullySecured(res);
  });

  it('an authenticated request on the normal pass-through path keeps getting full headers', async () => {
    getToken.mockResolvedValue({ sub: 'user-1' });
    const req = new NextRequest(new URL('https://relay.coreframe-labs.dev/dashboard'));
    const res = await middleware(req);

    assertFullySecured(res);
  });

  it('does not require SECURITY_HEADERS_ENABLED to be set — the old gate is gone', async () => {
    const original = process.env.SECURITY_HEADERS_ENABLED;
    delete process.env.SECURITY_HEADERS_ENABLED;
    try {
      const req = new NextRequest(new URL('https://relay.coreframe-labs.dev/pricing'));
      const res = await middleware(req);
      assertFullySecured(res);
    } finally {
      if (original !== undefined) process.env.SECURITY_HEADERS_ENABLED = original;
    }
  });
});

/**
 * [RELAY-112] Regression test for the middleware/handler local-only mismatch.
 *
 * `localOnlyUnauthenticatedRoutes` used to be `NODE_ENV === 'production' ? [] :
 * [...]` — no Host check at all, so a local `next build && next start` run
 * (`NODE_ENV=production`, no deploy-platform marker, loopback Host) could never
 * reach `/api/relay/qstash-test` / `/api/relay/smoke-destination` through this
 * file, even though both handlers' OWN `localOnlyVerdict` explicitly allow exactly
 * that case. Every call 307'd to `/auth/login` instead — found running
 * `consumer-journey.spec.ts` for real against a local production build, not from
 * reading the code. `qstash-test.ts`'s own `[RELAY-72]` unit tests
 * (`relay-50.test.ts`) never caught this because they call the handler directly
 * and never go through `middleware.ts` at all.
 *
 * `jest.replaceProperty` (not a plain `process.env.NODE_ENV = …` assignment) so
 * this file does not pick up the pre-existing `TS2540` "NODE_ENV is read-only"
 * baseline error the three OTHER NODE_ENV-mutating test files already carry.
 */
describe('[RELAY-112] middleware allows the local-only endpoints on a local production build over loopback, and nowhere else', () => {
  beforeEach(() => {
    // Explicit and UNauthenticated by default: every test in this block asserts
    // what the LOCAL-ONLY-PATH bypass itself decides, and a stale `getToken` mock
    // leaking in from another describe block's last test (this file's outer block
    // ends on an AUTHENTICATED mock) would make a broken bypass pass for the
    // wrong reason — through the normal "has a valid session" path instead of
    // through the bypass this suite exists to test.
    getToken.mockReset();
    getToken.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes /api/relay/qstash-test through on NODE_ENV=production + a loopback Host', async () => {
    jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    for (const marker of ['VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'RENDER'] as const) {
      delete process.env[marker];
    }

    const req = new NextRequest(new URL('http://localhost:4002/api/relay/qstash-test'), {
      headers: { host: 'localhost:4002' },
    });
    const res = await middleware(req);

    // NextResponse.next() carries no redirect status/location — a 307 here would
    // mean the old bug is back.
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    // The outer allowlist bypass still stamps the same security headers as every
    // other unauthenticated path.
    assertFullySecured(res);
  });

  it('still 307s /api/relay/qstash-test on NODE_ENV=production + a REMOTE Host (a real deployment)', async () => {
    jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    for (const marker of ['VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'RENDER'] as const) {
      delete process.env[marker];
    }
    getToken.mockResolvedValue(null);

    const req = new NextRequest(
      new URL('https://relay.coreframe-labs.dev/api/relay/qstash-test'),
      { headers: { host: 'relay.coreframe-labs.dev' } }
    );
    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/auth/login');
  });

  it('still 307s /api/relay/qstash-test when a deploy-platform marker is set, even on a loopback Host', async () => {
    jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    process.env.VERCEL = '1';
    getToken.mockResolvedValue(null);

    const req = new NextRequest(new URL('http://localhost:4002/api/relay/qstash-test'), {
      headers: { host: 'localhost:4002' },
    });
    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/auth/login');

    delete process.env.VERCEL;
  });

  it('passes /api/relay/smoke-destination through on the same terms', async () => {
    jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    for (const marker of ['VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'RENDER'] as const) {
      delete process.env[marker];
    }

    const req = new NextRequest(
      new URL('http://localhost:4002/api/relay/smoke-destination'),
      { headers: { host: 'localhost:4002' } }
    );
    const res = await middleware(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('does NOT affect an unrelated path — /dashboard still redirects an anonymous visitor regardless of NODE_ENV', async () => {
    jest.replaceProperty(process.env, 'NODE_ENV', 'production');
    getToken.mockResolvedValue(null);

    const req = new NextRequest(new URL('http://localhost:4002/dashboard'), {
      headers: { host: 'localhost:4002' },
    });
    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/auth/login');
  });
});
