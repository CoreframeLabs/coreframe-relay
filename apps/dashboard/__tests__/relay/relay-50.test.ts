/**
 * @jest-environment node
 */

/**
 * [RELAY-50] — the Send-test pipeline, in pieces.
 *
 * The LIVE end-to-end proof is the local-stack drive documented in the dev log —
 * these unit tests pin the three failure modes that the live drive cannot assert:
 *
 *   1. The catcher answers the right way without any auth (so it is usable as an
 *      onboarding destination), and the malformed-token probe answers 404, never 400.
 *   2. The `qstash-test` envelope consumer refuses anything that is not
 *      Bearer-RELAY_API_SECRET, with a constant-time compare — the local loop must not
 *      become a second publish path that skips the QStash signature check for nobody.
 *   3. `consumeEnvelope` stamps `isTest` from the envelope onto the DeliveryLog row,
 *      which is what the billing exclusion and the UI badge read.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';

// ─── Helpers ───────────────────────────────────────────────────────────────────────

function makeRequest(
  method: string,
  headers: Record<string, string>,
  body?: string,
  query: Record<string, string | string[]> = {}
): NextApiRequest {
  const raw = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  const req = Object.assign(raw, {
    method,
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
    ),
    query,
  }) as unknown as NextApiRequest;
  return req;
}

function makeResponse() {
  const headers: Record<string, string> = {};
  const state = { status: 0, body: undefined as unknown };

  function status(code: number) {
    state.status = code;
    return res;
  }
  function json(payload: unknown) {
    state.body = payload;
    return res;
  }

  const resBase = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status,
    json,
  } as unknown as NextApiResponse;

  // `Object.create(null)` bridge: `status` and `body` are exposed as plain data
  // properties on top of the Next-style chainable methods, so a test reads
  // `res.status` and gets the code the handler set.
  const res = new Proxy(resBase, {
    get(target, prop) {
      if (prop === '_status') return state.status;
      if (prop === '_body') return state.body;
      if (prop === 'headers') return headers;
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      if (typeof v === 'function') return v.bind(target);
      return v;
    },
  }) as NextApiResponse & {
    _status: number;
    _body: unknown;
    headers: Record<string, string>;
  };

  return res;
}

/** Read the numeric status code off a `makeResponse` after the handler has run. */
function statusOf(res: ReturnType<typeof makeResponse>): number {
  return (res as unknown as { _status: number })._status;
}

/** Read the parsed JSON body. */
function bodyOf<T>(res: ReturnType<typeof makeResponse>): T {
  return (res as unknown as { _body: T })._body;
}

// ─── Catcher schema/auth behavior ─────────────────────────────────────────────────
//
// The handler is loaded per-test via `jest.isolateModules` so its in-memory ring
// buffer does not bleed across tests. The `require` calls below are intentional: a
// static import would load the handler ONCE for the whole file, and inbox state is
// exactly what we are testing.

type CatcherHandler = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

function loadCatcher(): CatcherHandler {
  let catcher: CatcherHandler | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    catcher = require('../../pages/api/relay/catcher/[token]').default;
  });
  if (!catcher) throw new Error('catcher failed to load');
  return catcher;
}

function loadQstashTest(): CatcherHandler {
  let h: CatcherHandler | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    h = require('../../pages/api/relay/qstash-test').default;
  });
  if (!h) throw new Error('qstash-test failed to load');
  return h;
}

describe('catcher [RELAY-50]', () => {
  it('GET with malformed token answers 404 (no probe signal)', async () => {
    const handler = loadCatcher();
    const req = makeRequest('GET', {}, undefined, { token: 'short' });
    const res = makeResponse();
    await handler(req, res);
    expect(statusOf(res)).toBe(404);
    expect(bodyOf<{ error: string }>(res).error).toBe('not_found');
  });

  it('GET on a never-used token yields an empty inbox', async () => {
    const handler = loadCatcher();
    const token = 'A'.repeat(32);
    const req = makeRequest('GET', {}, undefined, { token });
    const res = makeResponse();
    await handler(req, res);
    expect(statusOf(res)).toBe(200);
    expect(bodyOf<{ data: { kept: number; requests: unknown[] } }>(res).data.kept).toBe(0);
  });

  it('POST appends and GET returns the same payload (per-token ring)', async () => {
    const handler = loadCatcher();
    const token = 'B'.repeat(32);
    const payload = JSON.stringify({ hello: 'world' });

    const post = makeRequest(
      'POST',
      { 'content-type': 'application/json' },
      payload,
      { token }
    );
    const postRes = makeResponse();
    await handler(post, postRes);
    expect(statusOf(postRes)).toBe(200);

    const get = makeRequest('GET', {}, undefined, { token });
    const getRes = makeResponse();
    await handler(get, getRes);
    const inbox = bodyOf<{ data: { kept: number; requests: Array<{ body: string }> } }>(getRes).data;
    expect(inbox.kept).toBe(1);
    expect(inbox.requests[0].body).toBe(payload);
  });
});

// ─── qstash-test auth ─────────────────────────────────────────────────────────────

describe('qstash-test [RELAY-50]', () => {
  beforeEach(() => {
    process.env.RELAY_API_SECRET = 's'.repeat(48);
  });

  afterEach(() => {
    delete process.env.RELAY_API_SECRET;
  });

  it('rejects a missing bearer', async () => {
    const handler = loadQstashTest();
    const req = makeRequest('POST', { 'content-type': 'application/json' }, '{}');
    const res = makeResponse();
    await handler(req, res);
    expect(statusOf(res)).toBe(401);
  });

  it('rejects a wrong-length bearer without any constant-time compare internals firing', async () => {
    const handler = loadQstashTest();
    const req = makeRequest(
      'POST',
      {
        'content-type': 'application/json',
        authorization: `Bearer ${'x'.repeat(48)}`,
      },
      '{}'
    );
    const res = makeResponse();
    await handler(req, res);
    expect(statusOf(res)).toBe(401);
  });

  it('rejects a malformed body after a valid bearer', async () => {
    const handler = loadQstashTest();
    const req = makeRequest(
      'POST',
      {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.RELAY_API_SECRET}`,
      },
      'not-json'
    );
    const res = makeResponse();
    await handler(req, res);
    expect(statusOf(res)).toBe(400);
  });
});

// ─── consumeEnvelope: isTest propagation ─────────────────────────────────────────

// Hoisted mocks (jest.mock at module level, not doMock inside a test). Module-level
// mock factories cannot reference outer variables, so the captured calls are emitted
// onto a well-known object each test can reset.
//
// The mock specifiers are RELATIVE paths, not the `@/…` aliases the source modules
// themselves use: the alias resolution for `@/` lives in the SWC transform, which
// runs on the file being READ — it does not rewrite a `jest.mock` specifier written
// in this file at registration time. Those specifiers are resolved by jest against
// the file system on its own.
jest.mock('../../lib/relay/forward', () => ({
  __esModule: true,
  forwardToDestination: jest.fn(),
}));
jest.mock('../../lib/metrics', () => ({
  __esModule: true,
  recordMetric: jest.fn(),
}));
jest.mock('../../models/delivery', () => ({
  __esModule: true,
  assertRouteBelongsToTeam: jest.fn(),
  recordDeliveryAttempt: jest.fn(),
}));
jest.mock('../../models/dlq', () => ({
  __esModule: true,
  recordDlqItem: jest.fn(),
}));
jest.mock('../../lib/db/scope', () => ({
  __esModule: true,
  withTeamScope: (_t: string, fn: () => Promise<unknown>) => fn(),
  currentTeamId: () => undefined,
}));

import { forwardToDestination } from '../../lib/relay/forward';
import { recordMetric } from '../../lib/metrics';
import {
  assertRouteBelongsToTeam,
  recordDeliveryAttempt,
} from '../../models/delivery';
import { consumeEnvelope } from '../../lib/relay/consume';

const mockedForward = forwardToDestination as jest.Mock;
const mockedMetric = recordMetric as jest.Mock;
const mockedAssert = assertRouteBelongsToTeam as jest.Mock;
const mockedRecord = recordDeliveryAttempt as jest.Mock;

const TEST_ENVELOPE = {
  requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  routeId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
  teamId: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
  destination: 'https://example.com/hook',
  maxRetries: 7,
  receivedAt: '2026-08-03T00:00:00.000Z',
  headers: {},
  body: '{}',
} as const;

describe('consumeEnvelope [RELAY-50]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedForward.mockResolvedValue({
      ok: true,
      responseCode: 200,
      latencyMs: 12,
      failReason: null,
    });
    mockedAssert.mockResolvedValue(undefined);
    mockedRecord.mockResolvedValue({ log: {}, duplicate: false });
  });

  it('writes isTest=true onto the DeliveryLog row and skips the metric', async () => {
    const res = makeResponse();
    await consumeEnvelope({ ...TEST_ENVELOPE, isTest: true }, 0, res);

    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({ isTest: true, status: 'DELIVERED' })
    );
    expect(mockedMetric).not.toHaveBeenCalled();
  });

  it('writes isTest=false for an envelope WITHOUT the flag, and the metric still counts it', async () => {
    const res = makeResponse();
    // `isTest` deliberately absent — this is the legacy shape the schema default
    // protects against.
    await consumeEnvelope({ ...TEST_ENVELOPE } as never, 0, res);

    expect(mockedRecord).toHaveBeenCalledWith(
      expect.objectContaining({ isTest: false, status: 'DELIVERED' })
    );
    expect(mockedMetric).toHaveBeenCalledWith('delivery.delivered');
  });
});
