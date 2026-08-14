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
