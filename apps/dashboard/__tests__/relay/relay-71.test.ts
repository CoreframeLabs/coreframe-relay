/**
 * @jest-environment node
 */

/**
 * [RELAY-71] — the dashboard half of the critical.
 *
 * The proxy half is asserted in `apps/proxy/test/ingest.test.ts`: the global
 * `RELAY_API_SECRET` no longer authenticates ingestion. This file asserts the half that
 * lives here, which is the one that is easier to regress silently:
 *
 *   `/api/relay/internal/route-lookup` is authenticated by ONE global secret and accepts
 *   ARBITRARY `teamSlug`/`routeSlug`. It used to answer with the route's live
 *   `ingestToken`, so a single leaked secret read EVERY tenant's ingest credential — the
 *   exact shared-secret failure `Route.ingestToken` was introduced to remove, reappearing
 *   one layer down. It now answers with the token's SHA-256, which is not usable to
 *   ingest anything.
 *
 * The regression this pins is not "someone deletes the fix". It is "someone adds a field".
 * The handler builds its body through `RouteLookupResponseSchema.parse`, and a Zod object
 * STRIPS unknown keys — so the schema, not the handler, is what keeps a future column from
 * leaking. That property is asserted directly below, because it is invisible at the call
 * site and would be the first thing lost in a refactor to a plain object literal.
 */

import { createHash } from 'node:crypto';

import { ingestTokenDigestHex } from '@/lib/relay/ingestToken';
import { RouteLookupResponseSchema } from '@coreframe-relay/types/internal';

const TOKEN = 'aB3dEf7hIjK1mNoPqR5tUvWxYz09_-Ab';
const ROUTE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const TEAM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3303';

const validBody = {
  routeId: ROUTE_ID,
  teamId: TEAM_ID,
  destination: 'https://api.example.com/hook',
  maxRetries: 5,
  status: 'ACTIVE' as const,
  ingestTokenSha256: createHash('sha256').update(TOKEN, 'utf8').digest('hex'),
  // [RELAY-13] Required by the contract since the rate limiter's binding selection
  // needs it. Unrelated to what this file tests, but the schema now requires it.
  plan: 'FREE' as const,
};

describe('[RELAY-71] ingestTokenDigestHex', () => {
  it('is SHA-256, lower-case hex, 64 chars', () => {
    const digest = ingestTokenDigestHex(TOKEN);

    expect(digest).toBe(createHash('sha256').update(TOKEN, 'utf8').digest('hex'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not contain the token, in whole or in any 8-char run', () => {
    // The point of sending a digest is that the response is no longer credential-shaped.
    // A "digest" that embedded the input would defeat the entire change.
    const digest = ingestTokenDigestHex(TOKEN);

    expect(digest).not.toContain(TOKEN);
    for (let i = 0; i + 8 <= TOKEN.length; i++) {
      expect(digest).not.toContain(TOKEN.slice(i, i + 8));
    }
  });

  it('is deterministic, so a cached lookup keeps comparing equal', () => {
    expect(ingestTokenDigestHex(TOKEN)).toBe(ingestTokenDigestHex(TOKEN));
  });

  it('changes completely when the token rotates', () => {
    const before = ingestTokenDigestHex(TOKEN);
    const after = ingestTokenDigestHex(`${TOKEN.slice(0, -1)}Z`);

    expect(after).not.toBe(before);
  });
});

describe('[RELAY-71] the route-lookup contract cannot carry a credential', () => {
  it('accepts a body carrying the digest', () => {
    expect(RouteLookupResponseSchema.safeParse(validBody).success).toBe(true);
  });

  it('REJECTS the pre-RELAY-71 body — a raw ingestToken and no digest', () => {
    const { ingestTokenSha256: _dropped, ...withoutDigest } = validBody;
    const legacy = { ...withoutDigest, ingestToken: TOKEN };

    expect(RouteLookupResponseSchema.safeParse(legacy).success).toBe(false);
  });

  it('STRIPS a token smuggled in alongside the digest', () => {
    // This is the regression that would otherwise reach production unnoticed: a
    // developer adds `ingestToken` back "for debugging", the digest is still present, so
    // every assertion about the digest keeps passing. Zod's strip is what stops it, and
    // this is the only place that behaviour is stated out loud.
    const parsed = RouteLookupResponseSchema.parse({ ...validBody, ingestToken: TOKEN });

    expect(parsed).not.toHaveProperty('ingestToken');
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
  });

  it('rejects a digest that is not lower-case 64-hex', () => {
    const bad = [
      validBody.ingestTokenSha256.toUpperCase(),
      validBody.ingestTokenSha256.slice(0, 63),
      `${validBody.ingestTokenSha256}0`,
      TOKEN,
      '',
    ];

    for (const ingestTokenSha256 of bad) {
      expect(
        RouteLookupResponseSchema.safeParse({ ...validBody, ingestTokenSha256 }).success
      ).toBe(false);
    }
  });

  it('a serialised 200 body contains no value usable as an ingest credential', () => {
    // What a leaked RELAY_API_SECRET still buys an attacker is tenant METADATA. That is
    // real and tracked. What it no longer buys is a credential.
    const wire = JSON.stringify(RouteLookupResponseSchema.parse(validBody));

    expect(wire).not.toContain(TOKEN);
    expect(wire).toContain(validBody.ingestTokenSha256);
  });
});
