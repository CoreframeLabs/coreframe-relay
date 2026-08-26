import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * [RELAY-67 / RELAY-44] Proves the Sentry wiring in `src/index.ts` actually fires — not
 * that `@sentry/cloudflare` itself works (that is Sentry's own test suite's job).
 *
 * The SDK is mocked wholesale: `withSentry` is a passthrough (`(_, handler) => handler`)
 * so `relayWorker.fetch`/`.scheduled` run as plain, un-instrumented functions and this
 * file asserts on OUR `Sentry.captureException` calls, not on the real SDK's network or
 * AsyncLocalStorage behaviour, which would require a live DSN and the Workers runtime.
 */
vi.mock('@sentry/cloudflare', () => ({
  withSentry: vi.fn((_optionsCallback: unknown, handler: unknown) => handler),
  captureException: vi.fn(() => 'mock-event-id'),
}));

import * as Sentry from '@sentry/cloudflare';
import app, { app as honoApp } from '../src/index.js';

const env = { ENVIRONMENT: 'development' as const };

function fakeExecutionContext() {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        waitUntilPromises.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    settle: () => Promise.allSettled(waitUntilPromises),
  };
}

describe('Sentry capture — fetch handler unexpected errors', () => {
  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear();
  });

  it('captures a genuinely unexpected (non-HTTPException) error at error level', async () => {
    honoApp.get('/__test/unexpected-error', () => {
      throw new Error('kaboom - unexpected');
    });

    const res = await app.request('/__test/unexpected-error', {}, env);

    expect(res.status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    const [capturedError, options] = vi.mocked(Sentry.captureException).mock.calls[0] as [unknown, { level: string }];
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toBe('kaboom - unexpected');
    // Explicit 'error' level, matching the dashboard's dlq-health-check.ts pattern —
    // NOT the SDK's default level for an implicit capture.
    expect(options).toEqual({ level: 'error' });
  });

  it('does NOT capture deliberate, already-correct HTTPException responses (404)', async () => {
    const res = await app.request('/route-that-does-not-exist', {}, env);

    expect(res.status).toBe(404);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('Sentry capture — keep-warm cron (scheduled) failure path', () => {
  const controller = { cron: '17 4 * * *' } as ScheduledController;

  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures a non-2xx keep-warm ping response at error level', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('service unavailable', { status: 503 }))
    );
    const { ctx, settle } = fakeExecutionContext();

    // Non-null assertion: `ExportedHandler.scheduled` is optional per its own type
    // (a fetch-only Worker is valid), but this one always defines it — real at runtime,
    // just not narrowed by the type since `withSentry`'s return type re-widens it.
    await app.scheduled!(
      controller,
      { ...env, RELAY_DASHBOARD_HEALTH_URL: 'https://dashboard.example/api/health' },
      ctx
    );
    await settle();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [capturedError, options] = vi.mocked(Sentry.captureException).mock.calls[0] as [unknown, { level: string }];
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toContain('503');
    expect(options).toEqual({ level: 'error' });
  });

  it('captures a thrown network error from the keep-warm ping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND dashboard.example');
      })
    );
    const { ctx, settle } = fakeExecutionContext();

    // Non-null assertion: `ExportedHandler.scheduled` is optional per its own type
    // (a fetch-only Worker is valid), but this one always defines it — real at runtime,
    // just not narrowed by the type since `withSentry`'s return type re-widens it.
    await app.scheduled!(
      controller,
      { ...env, RELAY_DASHBOARD_HEALTH_URL: 'https://dashboard.example/api/health' },
      ctx
    );
    await settle();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [capturedError, options] = vi.mocked(Sentry.captureException).mock.calls[0] as [unknown, { level: string }];
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).toBe('getaddrinfo ENOTFOUND dashboard.example');
    expect(options).toEqual({ level: 'error' });
  });

  it('does NOT capture anything on a healthy 2xx ping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 }))
    );
    const { ctx, settle } = fakeExecutionContext();

    // Non-null assertion: `ExportedHandler.scheduled` is optional per its own type
    // (a fetch-only Worker is valid), but this one always defines it — real at runtime,
    // just not narrowed by the type since `withSentry`'s return type re-widens it.
    await app.scheduled!(
      controller,
      { ...env, RELAY_DASHBOARD_HEALTH_URL: 'https://dashboard.example/api/health' },
      ctx
    );
    await settle();

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('does NOT capture anything when RELAY_DASHBOARD_HEALTH_URL is unset (config, not a failure)', async () => {
    const { ctx, settle } = fakeExecutionContext();

    await app.scheduled!(controller, { ...env }, ctx);
    await settle();

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
