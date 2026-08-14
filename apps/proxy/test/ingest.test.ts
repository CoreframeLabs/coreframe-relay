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
// 32 URL-safe base64url chars — the shape `generateIngestToken()` produces.
const INGEST_TOKEN = '0'.repeat(32);

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
  ingestToken: INGEST_TOKEN,
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
  it('rejects a request with no key — on the legacy two-segment path', async () => {
    // Updated for [RELAY-57]: the header-first gate moved inside the handler, and a
    // route lookup must happen before EITHER credential arm is reached — the path
    // token belongs to the route row, and there is no route here to compare against.
    mockFetch({ lookup: { status: 404, body: { error: 'not_found' } } });
    const res = await app.request('/in/acme/stripe', { method: 'POST', body: '{}' }, baseEnv);

    expect(res.status).toBe(404);
    expect(lookupCalls()).toHaveLength(1);
    expect(publishCalls()).toHaveLength(0);
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

  it('(c) still accepts the legacy X-Relay-Key header during the migration', async () => {
    mockFetch();
    const res = await post('/in/acme/stripe');
    expect(res.status).toBe(200);
    expect(publishCalls()).toHaveLength(1);
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

    // Rotate: the dashboard now answers the SAME lookup path with a new token.
    mockFetch({
      lookup: { status: 200, body: { ...activeRoute, ingestToken: 'z'.repeat(32) } },
    });
    const after = await app.request(`/in/acme/stripe/${token}`, { method: 'POST', body: '{}' }, env);
    expect(after.status).toBe(404);
  });

  it('(a+c) both arms work against the same route in one session', async () => {
    mockFetch();
    const byHeader = await post('/in/acme/stripe');
    const byPath = await app.request(
      `/in/acme/stripe/${token}`,
      { method: 'POST', body: '{}' },
      baseEnv
    );
    expect(byHeader.status).toBe(200);
    expect(byPath.status).toBe(200);
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
