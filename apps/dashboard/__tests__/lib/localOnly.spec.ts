/**
 * @jest-environment node
 */

/**
 * Unit tests for the local-only guard and the secret comparison — [RELAY-72], [RELAY-74].
 *
 * These pin the two primitives the endpoint tests exercise end to end:
 *   1. `localOnlyVerdict`'s three arms, including the one that matters most — a spoofed
 *      loopback `Host` on a deploy platform is still refused.
 *   2. `timingSafeEqualSecrets` is length-INDEPENDENT. The compare it replaced opened
 *      with `a.length !== b.length -> return false`, which leaks the secret's length by
 *      timing before it leaks anything else.
 */
import {
  hostnameFromHostHeader,
  isDeployedPlatform,
  localOnlyVerdict,
} from '@/lib/relay/localOnly';
import { timingSafeEqualSecrets } from '@/lib/relay/internalAuth';

describe('hostnameFromHostHeader', () => {
  it.each([
    ['localhost:4002', 'localhost'],
    ['localhost', 'localhost'],
    ['127.0.0.1:4002', '127.0.0.1'],
    ['[::1]:4002', '::1'],
    ['[::1]', '::1'],
    ['RELAY.COREFRAME-LABS.DEV', 'relay.coreframe-labs.dev'],
    [undefined, ''],
  ])('%s -> %s', (input, expected) => {
    expect(hostnameFromHostHeader(input as string | undefined)).toBe(expected);
  });
});

describe('isDeployedPlatform', () => {
  it('is false for a bare local environment', () => {
    expect(isDeployedPlatform({ NODE_ENV: 'development' })).toBe(false);
  });

  it.each(['VERCEL', 'VERCEL_ENV', 'RENDER', 'FLY_APP_NAME', 'K_SERVICE'])(
    'is true when %s is set',
    (marker) => {
      expect(isDeployedPlatform({ [marker]: '1' })).toBe(true);
    }
  );

  it('ignores a marker that is set but empty', () => {
    expect(isDeployedPlatform({ VERCEL: '' })).toBe(false);
  });
});

describe('localOnlyVerdict', () => {
  it('allows a non-production build on any host', () => {
    expect(
      localOnlyVerdict('relay.coreframe-labs.dev', { NODE_ENV: 'development' })
    ).toEqual({ ok: true });
  });

  it('allows a production build on loopback — the local `next start` smoke', () => {
    expect(
      localOnlyVerdict('127.0.0.1:4002', { NODE_ENV: 'production' })
    ).toEqual({ ok: true });
  });

  it('refuses a production build on a remote host', () => {
    expect(
      localOnlyVerdict('relay.coreframe-labs.dev', { NODE_ENV: 'production' })
    ).toEqual({ ok: false, reason: 'remote_host' });
  });

  it('refuses a deploy platform even with a spoofed loopback Host', () => {
    // The Host header is caller-controlled. This is why it is never the only arm.
    expect(
      localOnlyVerdict('localhost', { NODE_ENV: 'production', VERCEL: '1' })
    ).toEqual({ ok: false, reason: 'deploy_platform' });
  });

  it('refuses a deploy platform even when NODE_ENV claims development', () => {
    expect(
      localOnlyVerdict('localhost:4002', {
        NODE_ENV: 'development',
        VERCEL_ENV: 'preview',
      })
    ).toEqual({ ok: false, reason: 'deploy_platform' });
  });

  it('refuses a production build with no Host header at all', () => {
    expect(localOnlyVerdict(undefined, { NODE_ENV: 'production' })).toEqual({
      ok: false,
      reason: 'remote_host',
    });
  });
});

describe('timingSafeEqualSecrets [RELAY-72]', () => {
  const secret = 's'.repeat(48);

  it('matches an identical secret', () => {
    expect(timingSafeEqualSecrets(secret, secret)).toBe(true);
  });

  it('rejects a same-length wrong secret', () => {
    expect(timingSafeEqualSecrets('x'.repeat(48), secret)).toBe(false);
  });

  it('rejects a DIFFERENT-length secret without throwing or short-circuiting', () => {
    // The replaced implementation returned early here. This one hashes both sides to a
    // fixed 32 bytes first, so a length mismatch costs exactly the same work as a
    // same-length mismatch and reveals nothing about how long the real secret is.
    expect(timingSafeEqualSecrets('x', secret)).toBe(false);
    expect(timingSafeEqualSecrets('x'.repeat(4096), secret)).toBe(false);
  });

  it('fails closed on an empty expected secret', () => {
    expect(timingSafeEqualSecrets('', '')).toBe(false);
    expect(timingSafeEqualSecrets('anything', '')).toBe(false);
  });
});
