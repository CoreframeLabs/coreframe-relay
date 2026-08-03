import { describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { REQUEST_ID_HEADER } from '../src/middleware/requestId.js';
// Imported to prove the workspace dependency resolves and is usable from the Worker —
// this is the [RELAY-3] acceptance criterion about shared types, made executable.
import { RouteSchema, RouteSlugSchema, RelayEnvelopeSchema } from '@coreframe-relay/types';

const env = { ENVIRONMENT: 'development' as const };

/**
 * `Response.json()` is typed `unknown` — correct, since nothing has validated the body.
 * Casting at each call site would scatter the assertion; naming it once keeps the tests
 * readable and makes the unchecked step explicit.
 */
type HealthBody = {
  status: string;
  service: string;
  environment: string;
  requestId: string;
  configured: { relayApiSecret: boolean; qstash: boolean; kv: boolean };
};
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

describe('GET /health', () => {
  it('returns ok without any authentication', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);

    const body = await json<HealthBody>(res);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('coreframe-relay-proxy');
    expect(body.environment).toBe('development');
  });

  it('reports secret PRESENCE as booleans and never the values', async () => {
    const secret = 'a'.repeat(40);
    const res = await app.request('/health', {}, { ...env, RELAY_API_SECRET: secret });
    const raw = await res.text();

    expect(JSON.parse(raw).configured).toEqual({
      relayApiSecret: true,
      qstash: false,
      kv: false,
    });
    // The real assertion: a health endpoint that echoes even a prefix of a token is a
    // credential oracle.
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(secret.slice(0, 8));
  });

  it('reports qstash configured only when BOTH url and token are set', async () => {
    const partial = await app.request('/health', {}, { ...env, UPSTASH_QSTASH_URL: 'https://q.example' });
    expect((await json<HealthBody>(partial)).configured.qstash).toBe(false);

    const full = await app.request('/health', {}, {
      ...env,
      UPSTASH_QSTASH_URL: 'https://q.example',
      UPSTASH_QSTASH_TOKEN: 'tok',
    });
    expect((await json<HealthBody>(full)).configured.qstash).toBe(true);
  });

  it('answers even with no secrets set, so a misconfigured deploy reports itself', async () => {
    const res = await app.request('/health', {}, { ENVIRONMENT: 'production' as const });
    expect(res.status).toBe(200);
    expect((await json<HealthBody>(res)).configured.relayApiSecret).toBe(false);
  });
});

describe('request id middleware', () => {
  it('generates a uuid and echoes it on the response', async () => {
    const res = await app.request('/health', {}, env);
    const header = res.headers.get(REQUEST_ID_HEADER);

    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    expect((await json<HealthBody>(res)).requestId).toBe(header);
  });

  it('honours a well-formed inbound uuid so callers can correlate', async () => {
    const mine = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const res = await app.request('/health', { headers: { [REQUEST_ID_HEADER]: mine } }, env);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(mine);
  });

  it('REJECTS a malformed inbound id and generates its own', async () => {
    // requestId is @unique on DeliveryLog, so an attacker who can choose it can suppress
    // a legitimate delivery as a duplicate. Caller-supplied ids must be validated.
    for (const bad of ['not-a-uuid', '', '../../etc/passwd', 'x'.repeat(200), '00000000-0000-0000-0000-000000000000']) {
      const res = await app.request('/health', { headers: { [REQUEST_ID_HEADER]: bad } }, env);
      expect(res.headers.get(REQUEST_ID_HEADER)).not.toBe(bad);
      expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('error surface', () => {
  it('404s unknown paths with a request id, not an HTML page', async () => {
    const res = await app.request('/nope', {}, env);
    expect(res.status).toBe(404);

    const body = await json<{ error: string; requestId: string }>(res);
    expect(body.error).toBe('not found');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('@coreframe-relay/types resolves from the worker', () => {
  it('validates a route and rejects a bad slug', () => {
    expect(RouteSlugSchema.safeParse('stripe-prod').success).toBe(true);
    for (const bad of ['Stripe', 'has space', '-lead', 'trail-', 'a--b', '']) {
      expect(RouteSlugSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('rejects a non-http destination — shape check only, not the SSRF defence', () => {
    const base = {
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      teamId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
      name: 'Stripe',
      slug: 'stripe',
      maxRetries: 7,
      status: 'ACTIVE',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    expect(RouteSchema.safeParse({ ...base, destination: 'https://api.example.com/hook' }).success).toBe(true);
    expect(RouteSchema.safeParse({ ...base, destination: 'file:///etc/passwd' }).success).toBe(false);
    expect(RouteSchema.safeParse({ ...base, destination: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('round-trips a relay envelope', () => {
    const envelope = {
      requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      routeId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
      teamId: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
      destination: 'https://api.example.com/hook',
      maxRetries: 7,
      receivedAt: '2026-08-03T00:00:00.000Z',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    };
    expect(RelayEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });
});
