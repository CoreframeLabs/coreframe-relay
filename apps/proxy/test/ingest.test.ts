import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayEnvelopeSchema } from '@coreframe-relay/types';

import app from '../src/index.js';
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

const baseEnv = {
  ENVIRONMENT: 'development' as const,
  RELAY_API_SECRET: SECRET,
  RELAY_DASHBOARD_URL: 'http://localhost:4002',
  UPSTASH_QSTASH_URL: 'https://qstash-eu-central-1.upstash.io',
  UPSTASH_QSTASH_TOKEN: 'qstash-token',
};

const activeRoute = {
  routeId: ROUTE_ID,
  teamId: TEAM_ID,
  destination: 'https://api.example.com/hook',
  maxRetries: 5,
  status: 'ACTIVE' as const,
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

const post = (path: string, init: RequestInit = {}, env: Record<string, unknown> = baseEnv) =>
  app.request(
    path,
    {
      method: 'POST',
      ...init,
      headers: { [RELAY_KEY_HEADER]: SECRET, 'content-type': 'application/json', ...(init.headers ?? {}) },
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

describe('X-Relay-Key authentication', () => {
  it('rejects a request with no key, before any route lookup happens', async () => {
    mockFetch();
    const res = await app.request('/in/acme/stripe', { method: 'POST', body: '{}' }, baseEnv);

    expect(res.status).toBe(401);
    // An unauthenticated caller must not be able to make us spend a subrequest.
    expect(lookupCalls()).toHaveLength(0);
  });

  it('rejects a wrong key with the same body as a missing one', async () => {
    mockFetch();
    const missing = await app.request('/in/acme/stripe', { method: 'POST', body: '{}' }, baseEnv);
    const wrong = await post('/in/acme/stripe', { headers: { [RELAY_KEY_HEADER]: 'x'.repeat(48) } });

    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: 'unauthorized' });
    expect((await missing.json() as { error: string }).error).toBe('unauthorized');
  });

  it('rejects a key that is a PREFIX of the real secret', async () => {
    mockFetch();
    const res = await post('/in/acme/stripe', { headers: { [RELAY_KEY_HEADER]: SECRET.slice(0, -1) } });
    expect(res.status).toBe(401);
  });

  it('refuses everything with 503 when no secret is configured — never fails open', async () => {
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
