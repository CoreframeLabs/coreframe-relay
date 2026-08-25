/**
 * @jest-environment node
 */

/**
 * [RELAY-9] "API key tests verify 401 on bad keys" — closing the one real gap this old
 * ticket's AC3 pointed at.
 *
 * WHERE THIS SITS RELATIVE TO EXISTING COVERAGE
 * ------------------------------------------------
 * The ingest path's per-route credential (`apps/proxy/test/ingest.test.ts`, "[RELAY-57]
 * path ingest token") is deliberately tested against 404, not 401 — a wrong or malformed
 * path token answers identically to a route that does not exist, by design, to avoid a
 * route-enumeration oracle (see that file, cases (b)). That is real, passing coverage,
 * but it is not "401 on a bad key": it is the opposite decision, made on purpose.
 *
 * The credential that DOES gate on 401 is the shared `Authorization: Bearer <secret>`
 * used by the proxy -> dashboard internal endpoints (`lib/relay/internalAuth.ts`,
 * [RELAY-5]/[RELAY-44]/[RELAY-72]). `route-lookup.ts`, `dlq-health-check.ts`, `qstash.ts`
 * and `qstash-test.ts` each return literal 401s on a bad/missing secret, and
 * `timingSafeEqualSecrets` / `isAuthorizedInternalRequest` have their own unit coverage
 * in `__tests__/lib/localOnly.spec.ts` — but nothing before this file drove an actual
 * handler end to end and asserted the HTTP-layer 401. `n8n-channel-metrics.test.ts`
 * exercises `getN8nChannelMetrics` (the model function) directly and never touches the
 * handler's auth gate at all.
 *
 * This file closes that: two handlers, each authenticated by a different bearer secret
 * (`RELAY_API_SECRET` vs the Vercel-mandated `CRON_SECRET`), each proven to 401 on a
 * missing key, a wrong key, a malformed header, and — the fail-closed case — an unset
 * secret; and, for `route-lookup.ts`, a positive control proving a correct key clears the
 * gate rather than the test only ever asserting the failure arm.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';

// route-lookup.ts's only non-stdlib dependency beyond internalAuth/ingestToken. Mocking
// it out means this file never touches Prisma or the DB — the auth gate runs (or
// doesn't) entirely before this would be called.
jest.mock('models/route', () => ({
  fetchRouteBySlugs: jest.fn(),
}));

import { fetchRouteBySlugs } from 'models/route';

const mockFetchRouteBySlugs = fetchRouteBySlugs as jest.Mock;

// ─── req/res doubles — same shape as __tests__/relay/relay-63-cross-team-404.test.ts ──

function makeRequest(
  method: string,
  query: Record<string, string>,
  headers: Record<string, string> = {}
): NextApiRequest {
  const raw = Readable.from([]);
  return Object.assign(raw, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    query,
  }) as unknown as NextApiRequest;
}

function makeResponse() {
  const state = { status: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const resBase = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
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
      if (prop === '_headers') return state.headers;
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as NextApiResponse & { _status: number; _body: unknown; _headers: Record<string, string> };
  return res;
}

const statusOf = (res: ReturnType<typeof makeResponse>) => (res as any)._status as number;
const bodyOf = <T>(res: ReturnType<typeof makeResponse>) => (res as any)._body as T;

function loadHandler(
  path: string
): (req: NextApiRequest, res: NextApiResponse) => Promise<void> {
  let handler: ((req: NextApiRequest, res: NextApiResponse) => Promise<void>) | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    handler = require(path).default;
  });
  if (!handler) throw new Error(`${path} failed to load`);
  return handler;
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.restoreAllMocks();
  mockFetchRouteBySlugs.mockReset();
});

describe('[RELAY-9] GET /api/relay/internal/route-lookup — Bearer RELAY_API_SECRET', () => {
  const load = () => loadHandler('../../pages/api/relay/internal/route-lookup');

  it('401s a request with no Authorization header at all', async () => {
    process.env.RELAY_API_SECRET = 'r'.repeat(48);
    const handler = load();
    const req = makeRequest('GET', { teamSlug: 'acme', routeSlug: 'hook' });
    const res = makeResponse();

    await handler(req, res);

    expect(statusOf(res)).toBe(401);
    expect(bodyOf(res)).toEqual({ error: 'unauthorized' });
    expect(mockFetchRouteBySlugs).not.toHaveBeenCalled();
  });

  it('401s a request bearing the WRONG secret', async () => {
    process.env.RELAY_API_SECRET = 'r'.repeat(48);
    const handler = load();
    const req = makeRequest(
      'GET',
      { teamSlug: 'acme', routeSlug: 'hook' },
      { authorization: `Bearer ${'x'.repeat(48)}` }
    );
    const res = makeResponse();

    await handler(req, res);

    expect(statusOf(res)).toBe(401);
    expect(bodyOf(res)).toEqual({ error: 'unauthorized' });
    expect(mockFetchRouteBySlugs).not.toHaveBeenCalled();
  });

  it('401s a malformed Authorization header (missing the "Bearer " scheme)', async () => {
    process.env.RELAY_API_SECRET = 'r'.repeat(48);
    const handler = load();
    const req = makeRequest(
      'GET',
      { teamSlug: 'acme', routeSlug: 'hook' },
      { authorization: 'r'.repeat(48) } // the raw secret, no "Bearer " prefix
    );
    const res = makeResponse();

    await handler(req, res);

    expect(statusOf(res)).toBe(401);
    expect(mockFetchRouteBySlugs).not.toHaveBeenCalled();
  });

  it('fails CLOSED — 401, not open — when RELAY_API_SECRET is unset, even with a plausible-looking token', async () => {
    delete process.env.RELAY_API_SECRET;
    const handler = load();
    const req = makeRequest(
      'GET',
      { teamSlug: 'acme', routeSlug: 'hook' },
      { authorization: `Bearer ${'r'.repeat(48)}` }
    );
    const res = makeResponse();

    await handler(req, res);

    expect(statusOf(res)).toBe(401);
    expect(mockFetchRouteBySlugs).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: the CORRECT secret clears the auth gate — 401 is a real gate, not a tautology', async () => {
    const secret = 'r'.repeat(48);
    process.env.RELAY_API_SECRET = secret;
    mockFetchRouteBySlugs.mockResolvedValue({
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
      teamId: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
      destination: 'https://api.example.com/hook',
      maxRetries: 5,
      status: 'ACTIVE',
      ingestToken: '0'.repeat(32),
      team: { plan: 'FREE' },
    });
    const handler = load();
    const req = makeRequest(
      'GET',
      { teamSlug: 'acme', routeSlug: 'hook' },
      { authorization: `Bearer ${secret}` }
    );
    const res = makeResponse();

    await handler(req, res);

    expect(statusOf(res)).not.toBe(401);
    expect(statusOf(res)).toBe(200);
    expect(mockFetchRouteBySlugs).toHaveBeenCalledWith('acme', 'hook');
  });
});

describe('[RELAY-9] GET /api/relay/internal/dlq-health-check — Bearer CRON_SECRET', () => {
  const load = () => loadHandler('../../pages/api/relay/internal/dlq-health-check');

  it('401s a request with no Authorization header at all', async () => {
    process.env.CRON_SECRET = 'c'.repeat(32);
    const handler = load();
    const req = makeRequest('GET', {});
    const res = makeResponse();

    await handler(req, res);

    expect(statusOf(res)).toBe(401);
    expect(bodyOf(res)).toEqual({ error: 'unauthorized' });
  });

  it('401s a request bearing the WRONG secret', async () => {
    process.env.CRON_SECRET = 'c'.repeat(32);
    const handler = load();
    const req = makeRequest('GET', {}, { authorization: `Bearer ${'z'.repeat(32)}` });
    const res = makeResponse();

    await handler(req, res);

    expect(statusOf(res)).toBe(401);
    expect(bodyOf(res)).toEqual({ error: 'unauthorized' });
  });

  it('fails CLOSED — 401, not open — when CRON_SECRET is unset, even with a plausible-looking token', async () => {
    delete process.env.CRON_SECRET;
    const handler = load();
    const req = makeRequest('GET', {}, { authorization: `Bearer ${'c'.repeat(32)}` });
    const res = makeResponse();

    await handler(req, res);

    expect(statusOf(res)).toBe(401);
  });
});
