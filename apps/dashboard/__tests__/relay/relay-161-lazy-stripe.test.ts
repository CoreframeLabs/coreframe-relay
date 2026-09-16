/**
 * @jest-environment node
 */

/**
 * [RELAY-161] With STRIPE_SECRET_KEY unset — production's real state on 2026-09-16 —
 * `lib/stripe.ts` used to throw at import time, so every billing route 500'd before
 * its own feature-flag check ran. This suite reproduces that exact deployment shape
 * (no secret key, so `env.teamFeatures.payments` is false) with the REAL env module
 * and REAL handlers, and proves: importing does not throw, and each route answers the
 * flag's 404 rather than crashing.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';

jest.mock('models/team', () => ({
  __esModule: true,
  throwIfNoTeamAccess: jest.fn(),
  updateTeam: jest.fn(),
}));
jest.mock('lib/session', () => ({
  __esModule: true,
  getSession: jest.fn(async () => ({ user: { id: 'u1', email: 'x@example.test' } })),
}));
jest.mock('models/subscription', () => ({ __esModule: true, getByCustomerId: jest.fn() }));
jest.mock('models/service', () => ({ __esModule: true, getAllServices: jest.fn() }));
jest.mock('models/price', () => ({ __esModule: true, getAllPrices: jest.fn() }));

function makeRequest(method: string, body?: unknown): NextApiRequest {
  const raw = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(raw, {
    method,
    headers: { 'content-type': 'application/json' },
    query: { slug: 'team-slug' },
    body,
  }) as unknown as NextApiRequest;
}

function makeResponse() {
  const state = { status: 0, body: undefined as unknown };
  const res = {
    setHeader: () => res,
    status: (c: number) => ((state.status = c), res),
    json: (b: unknown) => ((state.body = b), res),
    _state: state,
  } as unknown as NextApiResponse & { _state: typeof state };
  return res;
}

describe('[RELAY-161] billing routes on a deployment with no STRIPE_SECRET_KEY', () => {
  const saved = { key: process.env.STRIPE_SECRET_KEY, wh: process.env.STRIPE_WEBHOOK_SECRET };

  beforeAll(() => {
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_present_like_production';
    jest.resetModules();
  });
  afterAll(() => {
    if (saved.key !== undefined) process.env.STRIPE_SECRET_KEY = saved.key;
    if (saved.wh !== undefined) process.env.STRIPE_WEBHOOK_SECRET = saved.wh;
    else delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it('importing lib/stripe and the three handlers does not throw', async () => {
    await expect(import('lib/stripe')).resolves.toBeDefined();
    await expect(import('../../pages/api/teams/[slug]/payments/products')).resolves.toBeDefined();
    await expect(import('../../pages/api/teams/[slug]/payments/create-portal-link')).resolves.toBeDefined();
    await expect(import('../../pages/api/teams/[slug]/payments/create-checkout-session')).resolves.toBeDefined();
  });

  it('the real env module derives payments=false from the missing key', async () => {
    const env = (await import('lib/env')).default;
    expect(env.teamFeatures.payments).toBe(false);
  });

  it.each([
    ['GET products', '../../pages/api/teams/[slug]/payments/products', 'GET', undefined],
    ['POST create-portal-link', '../../pages/api/teams/[slug]/payments/create-portal-link', 'POST', {}],
    ['POST create-checkout-session', '../../pages/api/teams/[slug]/payments/create-checkout-session', 'POST', { price: 'p', quantity: 1 }],
  ])('%s answers the feature-flag 404, not a 500', async (_l, mod, method, body) => {
    const handler = (await import(mod)).default;
    const res = makeResponse();
    await handler(makeRequest(method, body), res);
    expect(res._state.status).toBe(404);
  });

  it('touching the client only then reports the missing key, as a catchable error', async () => {
    const { stripe } = await import('lib/stripe');
    expect(() => stripe.customers).toThrow(/STRIPE_SECRET_KEY is not configured/);
  });
});
