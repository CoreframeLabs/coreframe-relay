import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayEnvelopeSchema } from '@coreframe-relay/types';

import app from '../src/index.js';
import { RATE_LIMIT_WINDOW_SECONDS } from '../src/middleware/rateLimit.js';
import { RELAY_KEY_HEADER, timingSafeEqualStrings } from '../src/middleware/relayKey.js';
import { MAX_BODY_BYTES } from '../src/routes/ingest.js';

/**
 * [RELAY-4] ingestion tests.
 *
 * The dashboard's `/api/relay/internal/route-lookup` is being built in parallel and may
 * not exist yet, and QStash is a paid external service — so both are driven through a
 * mocked `fetch`. That is not a weaker test: it is the only way to assert what we SEND,
 * which is the half of the contract this ticket actually owns.
 */

const SECRET = 'r'.repeat(48);
const ROUTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const TEAM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3303';
// 32 URL-safe base64url chars — the shape `generateIngestToken()` produces.
const INGEST_TOKEN = '0'.repeat(32);

/**
 * [RELAY-71] The lookup contract carries the token's SHA-256, not the token. Computed
 * here rather than hard-coded so the fixture cannot silently disagree with the dashboard's
 * `ingestTokenDigestHex`, which is the same operation.
 */
const sha256HexOf = (v: string) =>
  createHash('sha256').update(v, 'utf8').digest('hex');

/**
 * [RELAY-13] A rate-limiter double standing in for the Workers Rate Limiting binding.
 *
 * `baseEnv` carries an ALWAYS-ALLOW limiter on `RELAY_RATE_LIMITER_FREE` rather than
 * omitting the binding, and that is deliberate: an unbound limiter is a 503 in every
 * deployed environment, so leaving it out of the default env would make every unrelated
 * test in this file assert against a misconfigured Worker instead of a working one. It is
 * the FREE binding specifically because `activeRoute.plan` below is `'FREE'` — the two
 * have to agree, or every test using `baseEnv` would 503 on a real deployed Worker for the
 * same reason `RELAY_RATE_LIMITER_PRO`/`_ENTERPRISE` being unbound is a 503 for a PRO/
 * ENTERPRISE team: there is no fallback across tiers.
 */
function fakeLimiter(opts: { allowFirst?: number } = {}) {
  const allowFirst = opts.allowFirst ?? Number.POSITIVE_INFINITY;
  const seen: string[] = [];
  return {
    seen,
    limit: vi.fn(async ({ key }: { key: string }) => {
      seen.push(key);
      return { success: seen.filter((k) => k === key).length <= allowFirst };
    }),
  };
}

const baseEnv = {
  ENVIRONMENT: 'development' as const,
  RELAY_API_SECRET: SECRET,
  RELAY_DASHBOARD_URL: 'http://localhost:4002',
  UPSTASH_QSTASH_URL: 'https://qstash-eu-central-1.upstash.io',
  UPSTASH_QSTASH_TOKEN: 'qstash-token',
  RELAY_RATE_LIMITER_FREE: fakeLimiter(),
};

const activeRoute = {
  routeId: ROUTE_ID,
  teamId: TEAM_ID,
  destination: 'https://api.example.com/hook',
  maxRetries: 5,
  status: 'ACTIVE' as const,
  // [RELAY-71] The contract carries the DIGEST. A fixture that still carried the token
  // would keep passing against a proxy that had regressed to reading one.
  ingestTokenSha256: sha256HexOf(INGEST_TOKEN),
  // [RELAY-13] Matches `baseEnv`'s `RELAY_RATE_LIMITER_FREE` — see the comment on
  // `fakeLimiter`/`baseEnv` above for why these two have to agree.
  plan: 'FREE' as const,
};

type FetchCall = { url: string; init: RequestInit | undefined };
let calls: FetchCall[] = [];

/** A `fetch` double that answers route-lookup and QStash separately. */
function mockFetch(opts: {
  lookup?: { status: number; body?: unknown };
  publish?: { status: number; body?: unknown };
} = {}) {
  const lookup = opts.lookup ?? { status: 200, body: activeRoute };
  const publish = opts.publish ?? { status: 200, body: { messageId: 'msg_test' } };

  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });

    const spec = url.includes('/v2/publish/') ? publish : lookup;
    return new Response(spec.body === undefined ? '' : JSON.stringify(spec.body), {
      status: spec.status,
      headers: { 'content-type': 'application/json' },
    });
  });

  vi.stubGlobal('fetch', fn);
  return fn;
}

const lookupCalls = () => calls.filter((c) => c.url.includes('/route-lookup'));
const publishCalls = () => calls.filter((c) => c.url.includes('/v2/publish/'));

/**
 * POST an ingestion request the way a real sender does after [RELAY-71]: the per-route
 * token in the URL, and NO `X-Relay-Key`.
 *
 * The helper appends the token so that every test below exercises the only credential the
 * endpoint still accepts. It used to send `X-Relay-Key` on a two-segment path; that arm no
 * longer authenticates anything, so a suite still built on it would have been asserting
 * 404s for the rest of time.
 */
const post = (
  path: string,
  init: RequestInit = {},
  env: Record<string, unknown> = baseEnv,
  token: string = INGEST_TOKEN
) =>
  app.request(
    `${path}/${token}`,
    {
      method: 'POST',
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: init.body ?? '{"id":"evt_1"}',
    },
    env
  );

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * [RELAY-71] — the critical this ticket closes.
 *
 * Two separate defects shared one root cause, and both are asserted here because either
 * one alone reinstates the other's damage:
 *
 *   (1) `POST /in/:teamSlug/:routeSlug` accepted the GLOBAL `RELAY_API_SECRET` via
 *       `X-Relay-Key` on a PUBLIC endpoint. One shared secret authorised ingestion into
 *       every tenant's route — exactly the failure `Route.ingestToken` was introduced to
 *       remove, still live on a second arm.
 *   (2) The internal route-lookup contract shipped the raw `ingestToken` to the proxy.
 *       That endpoint is authenticated by the same one global secret and accepts
 *       arbitrary slugs, so a single leaked secret READ every tenant's live ingest
 *       credential — the same failure one layer down.
 *
 * Fixing only (1) leaves a secret that hands out every token. Fixing only (2) leaves a
 * secret that ingests into every route directly.
 */
describe('[RELAY-71] the global secret no longer authenticates ingestion', () => {
  it('REFUSES a request bearing a VALID X-Relay-Key on the legacy two-segment path', async () => {
    // The exact request that used to succeed. This is the assertion S1 re-runs.
    mockFetch();
    const res = await app.request(
      '/in/acme/stripe',
      { method: 'POST', body: '{}', headers: { [RELAY_KEY_HEADER]: SECRET } },
      baseEnv
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not found' });
    expect(publishCalls()).toHaveLength(0);
  });

  it('REFUSES a valid X-Relay-Key presented alongside a WRONG path token', async () => {
    // The header must not rescue a bad token. If it did, the retired arm would still be
    // live — just harder to see.
    mockFetch();
    const res = await post(
      '/in/acme/stripe',
      { headers: { [RELAY_KEY_HEADER]: SECRET } },
      baseEnv,
      '1'.repeat(32)
    );

    expect(res.status).toBe(404);
    expect(publishCalls()).toHaveLength(0);
  });

  it('answers a missing credential and a valid global secret IDENTICALLY', async () => {
    mockFetch();
    const none = await app.request('/in/acme/stripe', { method: 'POST', body: '{}' }, baseEnv);
    const withSecret = await app.request(
      '/in/acme/stripe',
      { method: 'POST', body: '{}', headers: { [RELAY_KEY_HEADER]: SECRET } },
      baseEnv
    );

    expect(none.status).toBe(withSecret.status);
    expect((await none.json() as { error: string }).error).toBe(
      (await withSecret.json() as { error: string }).error
    );
  });

  it('the lookup contract carries NO usable credential — only a digest', async () => {
    // The second half of the finding. A response body that still contained the token
    // would be rejected by the contract schema, so the proxy 503s rather than trusting it.
    mockFetch({
      lookup: {
        status: 200,
        body: {
          routeId: ROUTE_ID,
          teamId: TEAM_ID,
          destination: 'https://api.example.com/hook',
          maxRetries: 5,
          status: 'ACTIVE',
          ingestToken: INGEST_TOKEN,
        },
      },
    });
    const res = await post('/in/acme/stripe');

    expect(res.status).toBe(503);
    expect(publishCalls()).toHaveLength(0);
  });

  it('a digest is not a credential — presenting it as the token is refused', async () => {
    // Anyone holding a leaked RELAY_API_SECRET can now read the digest. Proving the
    // digest cannot be replayed as the token is what makes that a metadata leak rather
    // than a credential handout.
    mockFetch();
    const res = await post('/in/acme/stripe', {}, baseEnv, sha256HexOf(INGEST_TOKEN));

    expect(res.status).toBe(404);
    expect(publishCalls()).toHaveLength(0);
  });

  it('still 503s — never 200 — when no secret is configured at all', async () => {
    mockFetch();
    const { RELAY_API_SECRET: _omitted, ...noSecret } = baseEnv;
    const res = await post('/in/acme/stripe', {}, noSecret);

    expect(res.status).toBe(503);
    expect(publishCalls()).toHaveLength(0);
  });

  it('compares constant-time and is still correct', async () => {
    expect(await timingSafeEqualStrings('abc', 'abc')).toBe(true);
    expect(await timingSafeEqualStrings('abc', 'abd')).toBe(false);
    expect(await timingSafeEqualStrings('', '')).toBe(true);
    expect(await timingSafeEqualStrings('', 'abc')).toBe(false);
    expect(await timingSafeEqualStrings('abc', 'abcd')).toBe(false);
  });
});

describe('route lookup', () => {
  it('calls the dashboard contract endpoint with the bearer secret', async () => {
    mockFetch();
    await post('/in/acme/stripe');

    const [call] = lookupCalls();
    expect(call).toBeDefined();
    const url = new URL(call!.url);
    expect(url.pathname).toBe('/api/relay/internal/route-lookup');
    expect(url.searchParams.get('teamSlug')).toBe('acme');
    expect(url.searchParams.get('routeSlug')).toBe('stripe');

    const headers = call!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it('404s an unknown route', async () => {
    mockFetch({ lookup: { status: 404, body: { error: 'not_found' } } });
    const res = await post('/in/acme/nope');

    expect(res.status).toBe(404);
    expect(publishCalls()).toHaveLength(0);
  });

  it('404s a malformed slug WITHOUT calling the dashboard', async () => {
    mockFetch();
    for (const path of ['/in/Acme/stripe', '/in/acme/has--dashes', '/in/acme/-lead']) {
      const res = await post(path);
      expect(res.status).toBe(404);
    }
    expect(lookupCalls()).toHaveLength(0);
  });

  it('503s — not 404 — when the dashboard is unreachable, so senders retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    const res = await post('/in/acme/stripe');
    expect(res.status).toBe(503);
  });

  it('503s when the dashboard answers 200 with a body that breaks the contract', async () => {
    mockFetch({ lookup: { status: 200, body: { routeId: 'not-a-uuid' } } });
    const res = await post('/in/acme/stripe');

    expect(res.status).toBe(503);
    expect(publishCalls()).toHaveLength(0);
  });

  it('503s when RELAY_DASHBOARD_URL is unset', async () => {
    mockFetch();
    const { RELAY_DASHBOARD_URL: _omitted, ...noDashboard } = baseEnv;
    const res = await post('/in/acme/stripe', {}, noDashboard);
    expect(res.status).toBe(503);
  });
});

describe('route status', () => {
  it('404s a PAUSED route — a paused route must not confirm it exists', async () => {
    mockFetch({ lookup: { status: 200, body: { ...activeRoute, status: 'PAUSED' } } });
    const res = await post('/in/acme/stripe');

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not found' });
    expect(publishCalls()).toHaveLength(0);
  });

  it('still accepts a FAILING route — failing means the destination is sick, not gone', async () => {
    mockFetch({ lookup: { status: 200, body: { ...activeRoute, status: 'FAILING' } } });
    const res = await post('/in/acme/stripe');

    expect(res.status).toBe(200);
    expect(publishCalls()).toHaveLength(1);
  });
});

describe('SSRF validation at ingestion', () => {
  const blocked = [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/hook',
    'http://10.1.2.3/hook',
    'http://localhost:3000/hook',
    'http://[::ffff:169.254.169.254]/hook',
  ];

  it('refuses to queue anything for a destination that points inward', async () => {
    for (const destination of blocked) {
      calls = [];
      mockFetch({ lookup: { status: 200, body: { ...activeRoute, destination } } });
      const res = await post('/in/acme/stripe');

      expect(res.status, destination).toBe(502);
      expect(publishCalls(), destination).toHaveLength(0);
    }
  });

  it('never echoes the destination back to the caller', async () => {
    mockFetch({ lookup: { status: 200, body: { ...activeRoute, destination: 'http://10.1.2.3/secret-path' } } });
    const raw = await (await post('/in/acme/stripe')).text();

    expect(raw).not.toContain('10.1.2.3');
    expect(raw).not.toContain('secret-path');
  });
});

describe('body handling', () => {
  it('413s a body over the cap', async () => {
    mockFetch();
    const res = await post('/in/acme/stripe', { body: 'x'.repeat(MAX_BODY_BYTES + 1) });

    expect(res.status).toBe(413);
    expect(publishCalls()).toHaveLength(0);
  });

  it('accepts a body at exactly the cap', async () => {
    mockFetch();
    const res = await post('/in/acme/stripe', { body: 'x'.repeat(MAX_BODY_BYTES) });
    expect(res.status).toBe(200);
  });

  it('forwards the raw bytes unaltered so signatures still verify', async () => {
    mockFetch();
    const body = '{"amount":1000,"currency":"gbp","nested":{"emoji":"é€"}}';
    await post('/in/acme/stripe', { body });

    const sent = JSON.parse(publishCalls()[0]!.init!.body as string);
    expect(sent.body).toBe(body);
  });
});

describe('header forwarding', () => {
  it('strips our own credential and hop-by-hop headers, keeps vendor signatures', async () => {
    mockFetch();
    await post('/in/acme/stripe', {
      headers: {
        'stripe-signature': 't=1,v1=deadbeef',
        'x-hub-signature-256': 'sha256=abc',
        'user-agent': 'Stripe/1.0',
        authorization: 'Bearer customer-token',
        cookie: 'session=abc',
        'cf-connecting-ip': '1.2.3.4',
        'x-forwarded-for': '1.2.3.4',
      },
    });

    const sent = JSON.parse(publishCalls()[0]!.init!.body as string);
    const headers = sent.headers as Record<string, string>;

    // Signature headers are the whole reason forwarding is a denylist and not an allowlist.
    expect(headers['stripe-signature']).toBe('t=1,v1=deadbeef');
    expect(headers['x-hub-signature-256']).toBe('sha256=abc');
    expect(headers['user-agent']).toBe('Stripe/1.0');

    // Forwarding any of these to a customer destination is a credential leak.
    expect(headers[RELAY_KEY_HEADER]).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
    expect(headers['cookie']).toBeUndefined();
    expect(headers['cf-connecting-ip']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();

    // And the raw request must not carry the secret anywhere in the published body.
    expect(publishCalls()[0]!.init!.body as string).not.toContain(SECRET);
  });
});

describe('QStash publish', () => {
  it('publishes to the consumer callback with the documented wire shape', async () => {
    mockFetch();
    const res = await post('/in/acme/stripe');
    expect(res.status).toBe(200);

    const call = publishCalls()[0];
    expect(call).toBeDefined();
    expect(call!.url).toBe(
      'https://qstash-eu-central-1.upstash.io/v2/publish/http://localhost:4002/api/relay/qstash'
    );

    const headers = call!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer qstash-token');
    expect(headers['content-type']).toBe('application/json');
    // Retry budget comes from the ROUTE, not a global default.
    expect(headers['Upstash-Retries']).toBe('5');
    // Upstash-Forward-* is how a header reaches the destination; the consumer reads it
    // back as `relay-request-id`.
    expect(headers['Upstash-Forward-relay-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('publishes a body that satisfies RelayEnvelopeSchema', async () => {
    mockFetch();
    const res = await post('/in/acme/stripe');

    const envelope = RelayEnvelopeSchema.safeParse(JSON.parse(publishCalls()[0]!.init!.body as string));
    expect(envelope.success).toBe(true);
    expect(envelope.success && envelope.data.routeId).toBe(ROUTE_ID);
    expect(envelope.success && envelope.data.teamId).toBe(TEAM_ID);
    expect(envelope.success && envelope.data.destination).toBe(activeRoute.destination);
    // The correlation id in the envelope is the one the caller was handed back.
    expect(envelope.success && envelope.data.requestId).toBe(res.headers.get('relay-request-id'));
  });

  it('503s when QStash rejects, so the sender retries rather than losing the webhook', async () => {
    mockFetch({ publish: { status: 400, body: { error: 'bad destination' } } });
    const res = await post('/in/acme/stripe');

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'service unavailable' });
  });

  it('503s when QStash is unconfigured rather than pretending the payload is queued', async () => {
    mockFetch();
    const { UPSTASH_QSTASH_TOKEN: _omitted, ...noToken } = baseEnv;
    const res = await post('/in/acme/stripe', {}, noToken);
    expect(res.status).toBe(503);
  });

  it('never leaks the QStash token in a response', async () => {
    mockFetch({ publish: { status: 500, body: { error: 'upstream' } } });
    const raw = await (await post('/in/acme/stripe')).text();
    expect(raw).not.toContain('qstash-token');
  });
});

describe('KV route-lookup cache', () => {
  /** Minimal KVNamespace double — only `get(key,'json')` and `put` are used. */
  function fakeKv() {
    const store = new Map<string, string>();
    return {
      store,
      get: vi.fn(async (key: string, type?: string) => {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === 'json' ? JSON.parse(raw) : raw;
      }),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    };
  }

  it('serves a second request from cache without a second dashboard call', async () => {
    mockFetch();
    const kv = fakeKv();
    const env = { ...baseEnv, RELAY_KV: kv as unknown as KVNamespace };

    expect((await post('/in/acme/stripe', {}, env)).status).toBe(200);
    expect((await post('/in/acme/stripe', {}, env)).status).toBe(200);

    expect(lookupCalls()).toHaveLength(1);
    expect(publishCalls()).toHaveLength(2);
  });

  it('writes with an expirationTtl at or above the 60s KV floor', async () => {
    mockFetch();
    const kv = fakeKv();
    await post('/in/acme/stripe', {}, { ...baseEnv, RELAY_KV: kv as unknown as KVNamespace });

    const [, , options] = kv.put.mock.calls[0] as unknown as [string, string, { expirationTtl: number }];
    // Cloudflare KV REJECTS a TTL below 60 — the contract's 30s window is enforced on
    // read against a stored timestamp instead.
    expect(options.expirationTtl).toBeGreaterThanOrEqual(60);
  });

  it('treats an entry older than the contract TTL as a miss', async () => {
    mockFetch();
    const kv = fakeKv();
    const env = { ...baseEnv, RELAY_KV: kv as unknown as KVNamespace };

    await post('/in/acme/stripe', {}, env);
    // Age the single stored entry past ROUTE_LOOKUP_CACHE_TTL_SECONDS (30).
    for (const [key, raw] of kv.store) {
      const entry = JSON.parse(raw);
      entry.cachedAt = Date.now() - 31_000;
      kv.store.set(key, JSON.stringify(entry));
    }
    await post('/in/acme/stripe', {}, env);

    expect(lookupCalls()).toHaveLength(2);
  });

  it('falls through gracefully when KV throws — a cache never drops a webhook', async () => {
    mockFetch();
    const broken = {
      get: vi.fn(async () => { throw new Error('kv down'); }),
      put: vi.fn(async () => { throw new Error('kv down'); }),
    } as unknown as KVNamespace;

    const res = await post('/in/acme/stripe', {}, { ...baseEnv, RELAY_KV: broken });
    expect(res.status).toBe(200);
    expect(publishCalls()).toHaveLength(1);
  });
});

describe('method and path surface', () => {
  it('does not answer GET on an ingestion path', async () => {
    mockFetch();
    const res = await app.request('/in/acme/stripe', { headers: { [RELAY_KEY_HEADER]: SECRET } }, baseEnv);
    expect(res.status).toBe(404);
  });

  it('carries the correlation id on every ingestion response, success or failure', async () => {
    mockFetch({ lookup: { status: 404, body: { error: 'not_found' } } });
    const res = await post('/in/acme/stripe');
    expect(res.headers.get('relay-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect((await res.json() as { requestId: string }).requestId).toBe(res.headers.get('relay-request-id'));
  });
});

describe('[RELAY-57] path ingest token', () => {
  const token = INGEST_TOKEN;

  it('(a) accepts a webhook with NO X-Relay-Key but a valid path token', async () => {
    mockFetch();
    const res = await app.request(
      `/in/acme/stripe/${token}`,
      { method: 'POST', body: '{"event":"ok"}' },
      baseEnv
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'queued' });
    expect(publishCalls()).toHaveLength(1);
  });

  it('(a) does not require the header when the path token is valid', async () => {
    mockFetch();
    // Explicitly send a WRONG header alongside a VALID token. The header must be
    // ignored — the path credential is the request's credential.
    const res = await app.request(
      `/in/acme/stripe/${token}`,
      {
        method: 'POST',
        body: '{}',
        headers: { [RELAY_KEY_HEADER]: 'x'.repeat(48) },
      },
      baseEnv
    );
    expect(res.status).toBe(200);
  });

  it('(b) 404s a wrong path token — never 401', async () => {
    mockFetch({ lookup: { status: 200, body: activeRoute } });
    const wrong = '1'.repeat(32);
    const res = await app.request(
      `/in/acme/stripe/${wrong}`,
      { method: 'POST', body: '{}' },
      baseEnv
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not found' });
    expect(publishCalls()).toHaveLength(0);
  });

  it('(b) 404s a malformed path token with the same body as a wrong one', async () => {
    mockFetch();
    const wrong = await app.request(
      `/in/acme/stripe/${'1'.repeat(32)}`,
      { method: 'POST', body: '{}' },
      baseEnv
    );
    const malformed = await app.request(
      `/in/acme/stripe/not-a-real-token`,
      { method: 'POST', body: '{}' },
      baseEnv
    );

    expect(wrong.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toMatchObject({ error: 'not found' });
  });

  it('(c) [RELAY-71] the legacy X-Relay-Key arm is GONE, not merely deprecated', async () => {
    // This assertion is inverted from the one RELAY-57 shipped. The migration window is
    // closed: `relayUrlFor()` has handed users the token URL since RELAY-57, so there was
    // nothing left to migrate, and a fallback credential nobody needs is one nobody
    // rotates. Left here rather than deleted so the inversion is visible in the diff.
    mockFetch();
    const res = await app.request(
      '/in/acme/stripe',
      { method: 'POST', body: '{}', headers: { [RELAY_KEY_HEADER]: SECRET } },
      baseEnv
    );
    expect(res.status).toBe(404);
    expect(publishCalls()).toHaveLength(0);
  });

  it('(d) never logs the token, and never returns it in an error body', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockFetch();

      // Failure arm: wrong token → 404.
      const bad = await app.request(
        `/in/acme/stripe/${'1'.repeat(32)}`,
        { method: 'POST', body: '{}' },
        baseEnv
      );
      const badBody = await bad.text();
      expect(badBody).not.toContain('1'.repeat(32));
      expect(badBody).not.toContain(token);

      // Success arm: the published envelope and the log lines.
      const ok = await app.request(
        `/in/acme/stripe/${token}`,
        { method: 'POST', body: '{"event":"ok"}' },
        baseEnv
      );
      expect(ok.status).toBe(200);

      const logged = spy.mock.calls.map((c) => c[0]).concat(errSpy.mock.calls.map((c) => c[0]));
      const all = logged.join('\n');
      expect(all).not.toContain(token);
      expect(all).not.toContain(`/${token}`);

      const published = publishCalls()[0]!.init!.body as string;
      expect(published).not.toContain(token);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('(e) rotation revokes the old token — server state changes, proxy re-reads', async () => {
    // Rotation is a dashboard-side write; this test proves the PROXY's behaviour:
    // the same URL that succeeded before the lookup body changed now 404s.
    const kv = fakeKvUnbound();
    const env = { ...baseEnv, RELAY_KV: kv as unknown as KVNamespace };

    mockFetch({ lookup: { status: 200, body: activeRoute } });
    const before = await app.request(`/in/acme/stripe/${token}`, { method: 'POST', body: '{}' }, env);
    expect(before.status).toBe(200);

    // Rotate: the dashboard now answers the SAME lookup path with a new token's digest.
    mockFetch({
      lookup: { status: 200, body: { ...activeRoute, ingestTokenSha256: sha256HexOf('z'.repeat(32)) } },
    });
    const after = await app.request(`/in/acme/stripe/${token}`, { method: 'POST', body: '{}' }, env);
    expect(after.status).toBe(404);

    // And the NEW token works on the same URL shape — rotation revokes, it does not brick.
    const rotated = await app.request(
      `/in/acme/stripe/${'z'.repeat(32)}`,
      { method: 'POST', body: '{}' },
      env
    );
    expect(rotated.status).toBe(200);
  });

  it('never forwards the path credential to the destination', async () => {
    mockFetch();
    await app.request(`/in/acme/stripe/${token}`, { method: 'POST', body: '{}' }, baseEnv);

    const sent = JSON.parse(publishCalls()[0]!.init!.body as string);
    const headers = sent.headers as Record<string, string>;
    const whole = JSON.stringify(sent);
    expect(headers[RELAY_KEY_HEADER]).toBeUndefined();
    expect(whole).not.toContain(token);
  });
});

/** A no-KV env: rotation must not be hidden by a cached lookup. */
function fakeKvUnbound(): undefined {
  return undefined;
}

// ─── [RELAY-73] The smoke waiver cannot be reached in a deployed environment ─────────

/**
 * The waiver used to fire on `x-relay-event: test` + `RELAY_LOCAL_QUEUE_URL` being bound.
 * That is a REQUEST HEADER switching off the product's central security control, with the
 * production guarantee resting on one environment variable being *unset* — which is the
 * absence of a control, not a control, and it fails open the moment a working dev config
 * is copied into a deployed environment.
 *
 * The structural arm is now "the request must have ARRIVED on a loopback host". Cloudflare
 * routes by Host, so no request bearing `Host: localhost` reaches a deployed Worker, and
 * there is no setting of any variable that makes that arm true in production. The cases
 * below drive each arm independently.
 */
describe('[RELAY-73] smoke-test SSRF waiver', () => {
  // The smoke destination: loopback, same origin as RELAY_DASHBOARD_URL. The literal-
  // address validator correctly rejects it, which is why the waiver exists at all.
  const smokeRoute = {
    ...activeRoute,
    destination: 'http://localhost:4002/api/relay/smoke-destination',
  };

  const localEnv = {
    ...baseEnv,
    RELAY_LOCAL_QUEUE_URL: 'http://localhost:4002',
  };

  const send = (origin: string, env: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.request(
      `${origin}/in/acme/stripe/${INGEST_TOKEN}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-relay-event': 'test', ...headers },
        body: '{"id":"evt_smoke"}',
      },
      env
    );

  beforeEach(() => {
    mockFetch({ lookup: { status: 200, body: smokeRoute } });
  });

  it('fires for the local smoke — dev, loopback arrival, local queue, test-marked', async () => {
    const res = await send('http://localhost:8787', localEnv);
    expect(res.status).toBe(200);
  });

  it('does NOT fire when the request arrived on a public hostname (the structural arm)', async () => {
    // Same env, same header, same destination — only the arrival host differs. This is
    // the arm that no environment variable can switch back on.
    const res = await send('https://relay-proxy.coreframe-labs.dev', localEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'route destination is not permitted' });
  });

  it('does NOT fire when ENVIRONMENT is production, even arriving on loopback', async () => {
    const res = await send('http://localhost:8787', {
      ...localEnv,
      ENVIRONMENT: 'production' as const,
    });
    expect(res.status).toBe(502);
  });

  it('does NOT fire when ENVIRONMENT is staging', async () => {
    const res = await send('http://localhost:8787', {
      ...localEnv,
      ENVIRONMENT: 'staging' as const,
    });
    expect(res.status).toBe(502);
  });

  it('does NOT fire without the local queue binding', async () => {
    const res = await send('http://localhost:8787', baseEnv);
    expect(res.status).toBe(502);
  });

  it('does NOT fire for a request that is not test-marked', async () => {
    const res = await send('http://localhost:8787', localEnv, { 'x-relay-event': 'real' });
    expect(res.status).toBe(502);
  });

  it('never waives a NON-loopback internal destination, even on the local smoke path', async () => {
    // The waiver is scoped to the dashboard's own origin. Cloud metadata is not it.
    mockFetch({
      lookup: { status: 200, body: { ...activeRoute, destination: 'http://169.254.169.254/latest/meta-data/' } },
    });
    const res = await send('http://localhost:8787', localEnv);
    expect(res.status).toBe(502);
  });
});

// ─── [RELAY-13] Per-team rate limiting ──────────────────────────────────────────────

/**
 * The control is a per-`teamId` budget enforced by the Workers Rate Limiting binding.
 *
 * Two properties get most of the attention below, because they are the two that turn a
 * rate limiter from a protection into a liability if they are wrong:
 *
 *   - It is keyed on `teamId`, NEVER on an IP. Cloudflare rotates client addresses, so an
 *     IP key throttles one legitimate sender's egress pool while an attacker on
 *     residential proxies never lands in the same bucket twice.
 *   - It runs AFTER authentication. A limiter in front of the credential check lets anyone
 *     who guesses a team/route slug pair — both are semi-public, they sit in the URL a
 *     customer pastes into Stripe — burn that team's budget with garbage tokens and take
 *     their webhooks offline. That is a DoS amplifier aimed at the customer it protects.
 */
describe('[RELAY-13] per-team rate limiting', () => {
  it('returns 429 with Retry-After once the team is over budget', async () => {
    // The S3 assertion, in unit form. `allowFirst: 2` stands in for the deployed
    // binding's 600/minute — the ceiling's VALUE is config; its BEHAVIOUR is this.
    mockFetch();
    const env = { ...baseEnv, RELAY_RATE_LIMITER_FREE: fakeLimiter({ allowFirst: 2 }) };

    expect((await post('/in/acme/stripe', {}, env)).status).toBe(200);
    expect((await post('/in/acme/stripe', {}, env)).status).toBe(200);

    const throttled = await post('/in/acme/stripe', {}, env);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe(String(RATE_LIMIT_WINDOW_SECONDS));
    expect(await throttled.json()).toMatchObject({ error: 'too many requests' });

    // Over-budget means nothing was queued — a 429 that still published would be a
    // limiter that costs money and protects nothing.
    expect(publishCalls()).toHaveLength(2);
  });

  it('keys the budget on teamId — not on an IP, not on a slug', async () => {
    mockFetch();
    const limiter = fakeLimiter();
    await post('/in/acme/stripe', { headers: { 'cf-connecting-ip': '1.2.3.4' } }, {
      ...baseEnv,
      RELAY_RATE_LIMITER_FREE: limiter,
    });

    expect(limiter.limit).toHaveBeenCalledWith({ key: TEAM_ID });
    expect(limiter.seen).toEqual([TEAM_ID]);
    expect(limiter.seen).not.toContain('1.2.3.4');
    expect(limiter.seen).not.toContain('acme');
  });

  it('one team hitting its limit does not throttle another team', async () => {
    // The ticket's own acceptance criterion. Two teams, one shared limiter, a budget of
    // one: team A is throttled on its second request while team B's first still passes.
    const OTHER_TEAM = '3f2504e0-4f89-41d3-9a0c-0305e82c3399';
    const limiter = fakeLimiter({ allowFirst: 1 });
    const env = { ...baseEnv, RELAY_RATE_LIMITER_FREE: limiter };

    mockFetch({ lookup: { status: 200, body: activeRoute } });
    expect((await post('/in/acme/stripe', {}, env)).status).toBe(200);
    expect((await post('/in/acme/stripe', {}, env)).status).toBe(429);

    mockFetch({ lookup: { status: 200, body: { ...activeRoute, teamId: OTHER_TEAM } } });
    expect((await post('/in/beta/stripe', {}, env)).status).toBe(200);

    expect(limiter.seen).toEqual([TEAM_ID, TEAM_ID, OTHER_TEAM]);
  });

  it('does NOT spend a team\'s budget on a request that failed authentication', async () => {
    // Position proof, first half: an unauthenticated caller must not be able to exhaust
    // a team it does not own.
    mockFetch();
    const limiter = fakeLimiter();
    const env = { ...baseEnv, RELAY_RATE_LIMITER_FREE: limiter };

    const res = await post('/in/acme/stripe', {}, env, '1'.repeat(32));
    expect(res.status).toBe(404);
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it('throttles BEFORE the body is buffered — 429 wins over 413', async () => {
    // Position proof, second half. An over-budget request carrying an oversized body must
    // be refused for the budget, not after a megabyte has already been read into the
    // isolate. If 413 came back, the limiter would be running too late to protect anything.
    mockFetch();
    const env = { ...baseEnv, RELAY_RATE_LIMITER_FREE: fakeLimiter({ allowFirst: 0 }) };

    const res = await post('/in/acme/stripe', { body: 'x'.repeat(MAX_BODY_BYTES + 1) }, env);
    expect(res.status).toBe(429);
  });

  it('refuses with 503 — never fails open — when deployed with no limiter bound', async () => {
    // The whole class of finding this sprint closed is "a control whose production
    // guarantee rests on a variable happening to be set". An absent limiter in a deployed
    // environment is a misconfiguration and says so, rather than silently passing traffic.
    mockFetch();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const ENVIRONMENT of ['production', 'staging'] as const) {
        const { RELAY_RATE_LIMITER_FREE: _unbound, ...noLimiter } = baseEnv;
        const res = await post('/in/acme/stripe', {}, { ...noLimiter, ENVIRONMENT });

        expect(res.status, ENVIRONMENT).toBe(503);
        expect(await res.json()).toMatchObject({ error: 'proxy not configured' });
      }
      expect(publishCalls()).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('falls open in development only, so an unrelated local edit is not bricked', async () => {
    mockFetch();
    const { RELAY_RATE_LIMITER_FREE: _unbound, ...noLimiter } = baseEnv;
    const res = await post('/in/acme/stripe', {}, noLimiter);
    expect(res.status).toBe(200);
  });

  it('treats a limiter that THROWS as over budget, not under it', async () => {
    // A limiter fails when the edge is already under stress — the one moment it matters.
    // Swallowing the error and allowing the request removes the control exactly then.
    mockFetch();
    const broken = {
      limit: vi.fn(async () => { throw new Error('rate limiter unavailable'); }),
    };
    const res = await post('/in/acme/stripe', {}, { ...baseEnv, RELAY_RATE_LIMITER_FREE: broken });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(RATE_LIMIT_WINDOW_SECONDS));
    expect(publishCalls()).toHaveLength(0);
  });

  it('carries the correlation id on a 429 and leaks nothing else', async () => {
    mockFetch();
    const env = { ...baseEnv, RELAY_RATE_LIMITER_FREE: fakeLimiter({ allowFirst: 0 }) };
    const res = await post('/in/acme/stripe', {}, env);
    const raw = await res.text();

    expect(res.headers.get('relay-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(raw).toContain(res.headers.get('relay-request-id'));
    expect(raw).not.toContain(INGEST_TOKEN);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(activeRoute.destination);
  });
});

// ─── [RELAY-13] Per-plan limits, configurable without a redeploy ───────────────────

/**
 * The AC these tests close: "Limits are per-plan and configurable without a redeploy."
 *
 * The mechanism (full reasoning in `middleware/rateLimit.ts`): three pre-declared
 * Cloudflare Rate Limiting bindings, one per `Plan`, selected in code by
 * `RouteLookupResponse.plan`. What has to be true for that mechanism to actually satisfy
 * the AC, and what each test below proves:
 *
 *   - A PRO team's budget is checked against the PRO binding, not FREE's — otherwise
 *     "per-plan" is cosmetic.
 *   - Two teams on DIFFERENT plans do not share a bucket, same as two teams on the same
 *     plan already don't (S3, above).
 *   - A team's plan changing (the dashboard's `Team.plan` column, no Worker redeploy) is
 *     picked up by the very next lookup — proven here as "the same env, a different
 *     lookup response, a different binding consulted", which is what a plan change looks
 *     like from the proxy's side without actually running a second deploy in a test.
 *   - There is no cross-tier fallback: a plan whose OWN binding is unbound 503s even when
 *     a different tier's binding is present and working, because falling back either
 *     direction would silently misstate the team's real ceiling.
 */
describe('[RELAY-13] per-plan rate limits', () => {
  it('a PRO team is checked against RELAY_RATE_LIMITER_PRO, not _FREE', async () => {
    const freeLimiter = fakeLimiter();
    const proLimiter = fakeLimiter();
    const env = {
      ...baseEnv,
      RELAY_RATE_LIMITER_FREE: freeLimiter,
      RELAY_RATE_LIMITER_PRO: proLimiter,
    };
    mockFetch({ lookup: { status: 200, body: { ...activeRoute, plan: 'PRO' } } });

    const res = await post('/in/acme/stripe', {}, env);

    expect(res.status).toBe(200);
    expect(proLimiter.limit).toHaveBeenCalledWith({ key: TEAM_ID });
    expect(freeLimiter.limit).not.toHaveBeenCalled();
  });

  it('an ENTERPRISE team is checked against RELAY_RATE_LIMITER_ENTERPRISE', async () => {
    const enterpriseLimiter = fakeLimiter();
    const env = { ...baseEnv, RELAY_RATE_LIMITER_ENTERPRISE: enterpriseLimiter };
    mockFetch({ lookup: { status: 200, body: { ...activeRoute, plan: 'ENTERPRISE' } } });

    const res = await post('/in/acme/stripe', {}, env);

    expect(res.status).toBe(200);
    expect(enterpriseLimiter.limit).toHaveBeenCalledWith({ key: TEAM_ID });
  });

  it('a PRO team hitting its own budget does not throttle a FREE team, or vice versa', async () => {
    // Same shape as the existing "one team does not throttle another" proof, but across
    // TIERS rather than across teams on the same tier — the two limiters must be
    // genuinely independent buckets, not the same counter read two ways.
    const freeLimiter = fakeLimiter({ allowFirst: 0 });
    const proLimiter = fakeLimiter({ allowFirst: 0 });
    const env = {
      ...baseEnv,
      RELAY_RATE_LIMITER_FREE: freeLimiter,
      RELAY_RATE_LIMITER_PRO: proLimiter,
    };

    mockFetch({ lookup: { status: 200, body: { ...activeRoute, plan: 'FREE' } } });
    expect((await post('/in/acme/stripe', {}, env)).status).toBe(429);

    mockFetch({ lookup: { status: 200, body: { ...activeRoute, plan: 'PRO' } } });
    expect((await post('/in/beta/stripe', {}, env)).status).toBe(429);

    expect(freeLimiter.seen).toEqual([TEAM_ID]);
    expect(proLimiter.seen).toEqual([TEAM_ID]);
  });

  it('a plan change is visible on the very next lookup — no redeploy in this path', async () => {
    // Simulates what a `Team.plan` UPDATE looks like from the proxy's side: the SAME
    // Worker env (no binding added, nothing redeployed), a fresh dashboard response with
    // a different `plan`. No KV in this env, so every request is an uncached lookup.
    const freeLimiter = fakeLimiter();
    const proLimiter = fakeLimiter();
    const env = {
      ...baseEnv,
      RELAY_RATE_LIMITER_FREE: freeLimiter,
      RELAY_RATE_LIMITER_PRO: proLimiter,
    };

    mockFetch({ lookup: { status: 200, body: { ...activeRoute, plan: 'FREE' } } });
    await post('/in/acme/stripe', {}, env);
    expect(freeLimiter.limit).toHaveBeenCalledTimes(1);
    expect(proLimiter.limit).not.toHaveBeenCalled();

    mockFetch({ lookup: { status: 200, body: { ...activeRoute, plan: 'PRO' } } });
    await post('/in/acme/stripe', {}, env);
    expect(proLimiter.limit).toHaveBeenCalledTimes(1);
    expect(freeLimiter.limit).toHaveBeenCalledTimes(1); // unchanged — the second call went to PRO
  });

  it('503s a PRO team when ONLY the PRO binding is unbound, even with FREE bound and working', async () => {
    // The no-fallback proof. If this silently fell back to `_FREE`, a misconfigured
    // deploy would quietly give a PRO team the FREE ceiling instead of failing loudly.
    mockFetch({ lookup: { status: 200, body: { ...activeRoute, plan: 'PRO' } } });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await post('/in/acme/stripe', {}, { ...baseEnv, ENVIRONMENT: 'production' as const });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'proxy not configured' });
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ─── [S8] No credential in any log line ─────────────────────────────────────────────

/**
 * Gate condition S8, as an executable assertion rather than a promise.
 *
 * Every log line this Worker can emit on the ingestion path is captured across the full
 * spread of outcomes — success, both authentication failures, throttle, SSRF refusal,
 * oversized body, publish failure, dashboard outage, misconfiguration — and the whole
 * transcript is searched for each credential the request had access to.
 *
 * It is written as a sweep over outcomes rather than one assertion per handler branch
 * because the failure this catches is a log line added LATER on a branch nobody thought
 * to re-check. A new branch that logs a secret has to also avoid every outcome below,
 * which is a much harder accident to have.
 */
describe('[S8] no credential reaches a log line', () => {
  const CREDENTIALS: Array<[string, string]> = [
    ['ingest token', INGEST_TOKEN],
    ['RELAY_API_SECRET', SECRET],
    ['QStash token', 'qstash-token'],
  ];

  it('emits no credential across every ingestion outcome', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // 1. Success.
      mockFetch();
      await post('/in/acme/stripe');

      // 2. Wrong token → 404.
      mockFetch();
      await post('/in/acme/stripe', {}, baseEnv, '1'.repeat(32));

      // 3. No token at all → 404.
      mockFetch();
      await app.request(
        '/in/acme/stripe',
        { method: 'POST', body: '{}', headers: { [RELAY_KEY_HEADER]: SECRET } },
        baseEnv
      );

      // 4. Throttled → 429.
      mockFetch();
      await post('/in/acme/stripe', {}, { ...baseEnv, RELAY_RATE_LIMITER_FREE: fakeLimiter({ allowFirst: 0 }) });

      // 5. Limiter unbound in a deployed env → 503.
      mockFetch();
      const { RELAY_RATE_LIMITER_FREE: _unbound, ...noLimiter } = baseEnv;
      await post('/in/acme/stripe', {}, { ...noLimiter, ENVIRONMENT: 'production' as const });

      // 6. SSRF refusal → 502. The reason names the customer's host; it is logged, and
      //    the log line is part of what is swept here.
      mockFetch({ lookup: { status: 200, body: { ...activeRoute, destination: 'http://169.254.169.254/' } } });
      await post('/in/acme/stripe');

      // 7. Paused route → 404.
      mockFetch({ lookup: { status: 200, body: { ...activeRoute, status: 'PAUSED' } } });
      await post('/in/acme/stripe');

      // 8. Oversized body → 413.
      mockFetch();
      await post('/in/acme/stripe', { body: 'x'.repeat(MAX_BODY_BYTES + 1) });

      // 9. QStash rejects → 503.
      mockFetch({ publish: { status: 400, body: { error: 'bad destination' } } });
      await post('/in/acme/stripe');

      // 10. Dashboard unreachable → 503.
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
      await post('/in/acme/stripe');

      // 11. Contract violation from the dashboard → 503.
      mockFetch({ lookup: { status: 200, body: { routeId: 'not-a-uuid' } } });
      await post('/in/acme/stripe');

      const transcript = [...logSpy.mock.calls, ...errSpy.mock.calls]
        .map((c) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .join('\n');

      // Sanity: the sweep actually produced log lines. Without this, a Worker that logged
      // nothing at all would pass this test while telling an operator nothing.
      expect(transcript.length).toBeGreaterThan(0);
      expect(transcript).toContain('proxy.ingest.queued');

      for (const [label, credential] of CREDENTIALS) {
        expect(transcript, `${label} appeared in a log line`).not.toContain(credential);
      }
      // Nor the digest's preimage by another name: the raw Authorization header value.
      expect(transcript).not.toContain(`Bearer ${SECRET}`);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
