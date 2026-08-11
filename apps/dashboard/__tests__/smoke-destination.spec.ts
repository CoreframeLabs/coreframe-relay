/**
 * @jest-environment node
 */

/**
 * Tests for /api/relay/smoke-destination — [RELAY-66].
 *
 * A LOCAL-only faux destination for the launch smoke test. It must be able to
 * play both halves of the DLQ story — a mode=500 receiver that fails so the
 * message dead-letters, and a mode=200 receiver that lets the DLQ retry succeed
 * — while never becoming an unauthenticated open receiver.
 *
 * These tests pin the two promises the smoke leg actually depends on:
 *   1. A missing or wrong Bearer token is a 401 before any mode logic runs.
 *   2. A valid Bearer yields the asked-for status (200 → 200, anything else →
 *      500) so the smoke script can drive both legs through one URL.
 *
 * Style follows the repo's own relay-50.test.ts (hand-rolled req/res — the
 * project carries no node-mocks-http and RELAY-62 forbids adding it).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';

const SECRET = 'smoke-test-secret';

// The handler is loaded once per process; it reads RELAY_API_SECRET at request
// time, so setting the env at module scope is enough and deterministic.
process.env.RELAY_API_SECRET = SECRET;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require('../pages/api/relay/smoke-destination').default as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

function makeRequest(
  method: string,
  headers: Record<string, string> = {},
  query: Record<string, string | string[]> = {}
): NextApiRequest {
  const raw = Readable.from([]);
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
      if (prop === 'headers') return headers;
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      if (typeof v === 'function') return v.bind(target);
      return v;
    },
  }) as NextApiResponse & { _status: number; _body: unknown };

  return res;
}

describe('/api/relay/smoke-destination', () => {
  it('rejects a missing Bearer token with 401 before anything else', async () => {
    const res = makeResponse();
    await handler(makeRequest('POST'), res);
    expect((res as never as { _status: number })._status).toBe(401);
    expect((res as never as { _body: unknown })._body).toEqual({
      error: 'unauthorized',
    });
  });

  it('rejects a wrong Bearer token with 401', async () => {
    const res = makeResponse();
    await handler(
      makeRequest('POST', { authorization: 'Bearer definitely-wrong' }),
      res
    );
    expect((res as never as { _status: number })._status).toBe(401);
  });

  it('defaults to mode=500 for a valid Bearer — the DLQ-driving leg', async () => {
    const res = makeResponse();
    await handler(
      makeRequest('POST', { authorization: `Bearer ${SECRET}` }),
      res
    );
    expect((res as never as { _status: number })._status).toBe(500);
    expect((res as never as { _body: { mode: string } })._body.mode).toBe('500');
  });

  it('answers 200 with ?mode=200 for a valid Bearer — the retry-success leg', async () => {
    const res = makeResponse();
    await handler(
      makeRequest(
        'POST',
        { authorization: `Bearer ${SECRET}` },
        { mode: '200' }
      ),
      res
    );
    expect((res as never as { _status: number })._status).toBe(200);
    expect((res as never as { _body: unknown })._body).toEqual({
      ok: true,
      mode: '200',
    });
  });

  it('treats an explicit ?mode=500 identically to the default', async () => {
    const res = makeResponse();
    await handler(
      makeRequest(
        'POST',
        { authorization: `Bearer ${SECRET}` },
        { mode: '500' }
      ),
      res
    );
    expect((res as never as { _status: number })._status).toBe(500);
  });

  it('rejects non-GET/POST methods even with a valid Bearer', async () => {
    const res = makeResponse();
    await handler(
      makeRequest('DELETE', { authorization: `Bearer ${SECRET}` }),
      res
    );
    expect((res as never as { _status: number })._status).toBe(405);
  });
});
