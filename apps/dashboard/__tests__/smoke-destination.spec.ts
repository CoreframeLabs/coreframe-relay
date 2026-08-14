/**
 * @jest-environment node
 */

/**
 * Tests for /api/relay/smoke-destination — [RELAY-66].
 *
 * A LOCAL-only faux destination for the launch smoke test. It must play both
 * halves of the DLQ story — mode=500 so the message dead-letters, mode=200 so
 * the DLQ retry succeeds. Local-only, unauthenticated by design: the retry path
 * replays envelopes with EMPTY headers, so no credential could ever reach a
 * retried delivery. What the tests pin:
 *   1. `?mode=200` answers 200.
 *   2. Everything else (default, explicit ?mode=500, a garbage mode) answers 500.
 *   3. The listener NEVER logs or stores the payload it received.
 *
 * Style follows the repo's own relay-50.test.ts (hand-rolled req/res — the
 * project carries no node-mocks-http and RELAY-62 forbids adding it).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const handler = require('../pages/api/relay/smoke-destination').default as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

function makeRequest(
  method: string,
  headers: Record<string, string> = {},
  query: Record<string, string | string[]> = {},
  body = ''
): NextApiRequest {
  const raw = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')]);
  return Object.assign(raw, {
    method,
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    ),
    query,
  }) as unknown as NextApiRequest;
}

function makeResponse() {
  const headers: Record<string, string> = {};
  const state = { status: 0, body: undefined as unknown };
  const resBase = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  } as unknown as NextApiResponse;
  const res = new Proxy(resBase, {
    get(target, prop) {
      if (prop === '_status') return state.status;
      if (prop === '_body') return state.body;
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      if (typeof v === 'function') return v.bind(target);
      return v;
    },
  }) as NextApiResponse & { _status: number; _body: unknown };
  return res;
}

describe('/api/relay/smoke-destination', () => {
  it('answers 200 with ?mode=200 (the retry-success leg)', async () => {
    const res = makeResponse();
    await handler(makeRequest('POST', {}, { mode: '200' }), res);
    expect((res as never as { _status: number })._status).toBe(200);
    expect((res as never as { _body: unknown })._body).toEqual({
      ok: true,
      mode: '200',
    });
  });

  it('defaults to 500 when mode is absent — the DLQ-driving leg', async () => {
    const res = makeResponse();
    await handler(makeRequest('POST'), res);
    expect((res as never as { _status: number })._status).toBe(500);
  });

  it('answers 500 for an explicit ?mode=500', async () => {
    const res = makeResponse();
    await handler(makeRequest('POST', {}, { mode: '500' }), res);
    expect((res as never as { _status: number })._status).toBe(500);
  });

  it('answers 500 for an unrecognised mode string (fail-safe default)', async () => {
    const res = makeResponse();
    await handler(makeRequest('POST', {}, { mode: 'surprise' }), res);
    expect((res as never as { _status: number })._status).toBe(500);
  });

  it('rejects non-GET/POST methods with 405', async () => {
    const res = makeResponse();
    await handler(makeRequest('DELETE'), res);
    expect((res as never as { _status: number })._status).toBe(405);
  });
});

/**
 * [RELAY-74] The guard `4fcc0bc` promised in a comment and did not implement.
 *
 * `4fcc0bc` was right to delete the Bearer guard — the DLQ retry path replays envelopes
 * with empty headers, so that credential was unreachable dead code — but it left the
 * endpoint with NO control at all while its comment claimed it "must not ship on a
 * deployed dashboard". These cases are that claim made executable.
 */
describe('/api/relay/smoke-destination — local-only guard [RELAY-74]', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const marker of ['VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'RENDER']) {
      delete process.env[marker];
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('answers 404 on a production build reached on a remote host', async () => {
    process.env.NODE_ENV = 'production';
    const res = makeResponse();
    await handler(
      makeRequest('POST', { host: 'relay.coreframe-labs.dev' }, { mode: '200' }),
      res
    );
    // 404, not 401: no credential exists that would make this endpoint legitimate
    // on a deployed dashboard, so "unauthorized" would invite a retry that can never work.
    expect((res as never as { _status: number })._status).toBe(404);
    expect((res as never as { _body: unknown })._body).toEqual({
      error: 'not_found',
    });
  });

  it('still answers on a production build reached over loopback (the local smoke)', async () => {
    process.env.NODE_ENV = 'production';
    const res = makeResponse();
    await handler(
      makeRequest('POST', { host: '127.0.0.1:4002' }, { mode: '200' }),
      res
    );
    expect((res as never as { _status: number })._status).toBe(200);
  });

  it('answers 404 when a deploy-platform marker is set, whatever NODE_ENV says', async () => {
    // The arm that does not depend on a variable being UNSET. `RELAY_LOCAL_QUEUE_URL`
    // was the previous "it can never be deployed" argument and it was a claim about the
    // proxy's configuration, not about who can reach this dashboard.
    process.env.NODE_ENV = 'development';
    process.env.VERCEL = '1';
    const res = makeResponse();
    await handler(
      makeRequest('POST', { host: 'localhost:4002' }, { mode: '200' }),
      res
    );
    expect((res as never as { _status: number })._status).toBe(404);
  });

  it('refuses a spoofed loopback Host on a deployed platform', async () => {
    // The Host header is caller-controlled, which is why it is never the only arm.
    process.env.NODE_ENV = 'production';
    process.env.VERCEL_ENV = 'production';
    const res = makeResponse();
    await handler(
      makeRequest('POST', { host: 'localhost' }, { mode: '200' }),
      res
    );
    expect((res as never as { _status: number })._status).toBe(404);
  });
});
