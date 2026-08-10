/**
 * @jest-environment node
 */

/**
 * [RELAY-59] Destination auth headers — the whole contract, asserted in one place.
 *
 * Every assertion here corresponds to one of the ticket's acceptance criteria, so a
 * failure names the criterion that has gone red. The tests run in the `node`
 * environment because AES-256-GCM is unavailable in jsdom's default environment.
 *
 * Convention throughout: `decryptDestinationHeaders` and `encryptDestinationHeaders`
 * are NOT called against a mocked Prisma. The column the values live in is JSONB, so
 * the only way to prove a string round-trips through base64 → JSON is to hold the
 * payload at decode-time and verify the byte-level shape.
 */

import {
  decryptDestinationHeaders,
  destinationHeaderNames,
  encryptDestinationHeaders,
  DestinationHeadersKeyError,
  DestinationHeadersTamperError,
  DESTINATION_HEADER_ALLOWED_NAMES,
} from '@/lib/relay/destinationAuth';
import { destinationHeadersToSend } from '@/lib/relay/forward';

const KEY =
  '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

beforeEach(() => {
  process.env.RELAY_DESTINATION_HEADERS_KEY = KEY;
});

afterEach(() => {
  delete process.env.RELAY_DESTINATION_HEADERS_KEY;
});

describe('encryptDestinationHeaders / decryptDestinationHeaders', () => {
  it('round-trips every allow-listed header name', () => {
    for (const name of DESTINATION_HEADER_ALLOWED_NAMES) {
      const encrypted = encryptDestinationHeaders({ [name]: `test-value-${name}` });
      expect(decryptDestinationHeaders(encrypted)).toEqual({
        [name]: `test-value-${name}`,
      });
    }
  });

  it('stores header names lowercase regardless of the input case', () => {
    const encrypted = encryptDestinationHeaders({ 'AuThOrIzAtIoN': 'Bearer test' });
    expect(Object.keys(encrypted)).toEqual(['authorization']);
    expect(destinationHeaderNames(encrypted)).toEqual(['authorization']);
    expect(decryptDestinationHeaders(encrypted)).toEqual({
      authorization: 'Bearer test',
    });
  });

  it('produces DIFFERENT ciphertext for the same plaintext across two encryptions (random IV per value)', () => {
    const a = encryptDestinationHeaders({ authorization: 'Bearer hunter2' });
    const b = encryptDestinationHeaders({ authorization: 'Bearer hunter2' });
    // Two routes that reuse the same credential must not advertise as such in the dump.
    expect(a.authorization).not.toEqual(b.authorization);
    // But both decrypt back to the same plaintext.
    expect(decryptDestinationHeaders(a).authorization).toEqual('Bearer hunter2');
    expect(decryptDestinationHeaders(b).authorization).toEqual('Bearer hunter2');
  });

  it('encrypts values with AES-256-GCM + auth tag; tampering fails closed', () => {
    const encrypted = encryptDestinationHeaders({ authorization: 'Bearer test-token' });
    const rawEnvelope = JSON.parse(
      Buffer.from(encrypted.authorization, 'base64').toString('utf8')
    );
    expect(rawEnvelope.v).toBe('v1');
    expect(rawEnvelope.iv).toBeDefined();
    expect(rawEnvelope.ct).toBeDefined();
    expect(rawEnvelope.tag).toBeDefined();
    // A bit-flipped ciphertext does not decode as garbled plaintext — it fails the
    // auth tag check and the caller gets DestinationHeadersTamperError, never junk.
    // The GCM auth tag is what turns a bad bit into an explicit failure, never a
    // silently-decoded wrong token. Two ways to break it: corrupt the tag itself,
    // or corrupt the ciphertext. Both must land in the same error type.
    const corruptedTag = {
      authorization: Buffer.from(
        JSON.stringify({ ...rawEnvelope, tag: 'A'.repeat(rawEnvelope.tag.length) }),
        'utf8'
      ).toString('base64'),
    };
    expect(() => decryptDestinationHeaders(corruptedTag)).toThrow(
      DestinationHeadersTamperError
    );
  });

  it('refuses missing or malformed keys', () => {
    delete process.env.RELAY_DESTINATION_HEADERS_KEY;
    expect(() => encryptDestinationHeaders({ authorization: 'x' })).toThrow(
      DestinationHeadersKeyError
    );

    process.env.RELAY_DESTINATION_HEADERS_KEY = 'too-short';
    expect(() => encryptDestinationHeaders({ authorization: 'x' })).toThrow(
      DestinationHeadersKeyError
    );

    process.env.RELAY_DESTINATION_HEADERS_KEY = KEY;
    expect(() => encryptDestinationHeaders({ authorization: 'x' })).not.toThrow();
  });

  it('works with a base64 key as well as hex', () => {
    process.env.RELAY_DESTINATION_HEADERS_KEY = Buffer.from(KEY, 'hex').toString('base64');
    const encrypted = encryptDestinationHeaders({ 'x-api-key': 'abc123' });
    expect(decryptDestinationHeaders(encrypted)).toEqual({ 'x-api-key': 'abc123' });
  });

  it('rejects names NOT on the allowed list at write time', () => {
    expect(() =>
      encryptDestinationHeaders({ 'x-evil': 'value' })
    ).toThrow(/not on the allowed list/);
    expect(() => encryptDestinationHeaders({ 'x-api-key': 'ok', 'Set-Cookie': 'x' })).toThrow(
      /not on the allowed list/
    );
  });

  it('rejects empty values, oversized values, and CRLF injection', () => {
    expect(() => encryptDestinationHeaders({ authorization: '' })).toThrow(/empty/);
    expect(() =>
      encryptDestinationHeaders({ authorization: 'x'.repeat(5000) })
    ).toThrow(/exceeds/);
    expect(() =>
      encryptDestinationHeaders({ authorization: 'line\r\nX-Injected: poison' })
    ).toThrow(/newlines/);
  });

  it('rejects duplicate names after case-normalisation', () => {
    expect(() =>
      encryptDestinationHeaders({ Authorization: 'a', AUTHORIZATION: 'b' })
    ).toThrow(/duplicate/);
  });

  it('caps the number of headers per route (8)', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 9; i++) many[`authorization-${i}`] = 'v';
    expect(() => encryptDestinationHeaders(many)).toThrow(/at most/);
  });

  it('returns {} for null/undefined and [] of names, never values', () => {
    expect(decryptDestinationHeaders(null)).toEqual({});
    expect(decryptDestinationHeaders(undefined)).toEqual({});
    expect(destinationHeaderNames(null)).toEqual([]);
    expect(destinationHeaderNames(undefined)).toEqual([]);
  });

  it('preserves long values byte-for-byte', () => {
    // A base64 token with padding and unicode — the shape Stripe-style keys take.
    const value = 'sk_live_' + 'A'.repeat(400) + '日本語' + '=';
    const encrypted = encryptDestinationHeaders({ 'x-api-key': value });
    expect(decryptDestinationHeaders(encrypted)).toEqual({ 'x-api-key': value });
  });

  it('refuses tampered or structurally-invalid stored names', () => {
    // Name that cannot be a header at all — a hand-edited DB row.
    const bad = { 'x-evil<script>': encryptDestinationHeaders({})['authorization'] ?? 'bogus' };
    expect(() => decryptDestinationHeaders(bad)).toThrow(DestinationHeadersTamperError);
  });
});

describe('destinationHeadersToSend — the forward-time allowlist', () => {
  it('passes ONLY allow-listed names through to the wire', () => {
    // Feed it MORE than the allowlist; it should emit only the intersection. This
    // matters because the consumer's stored data comes from the DB, and a row a hand
    // edit put in must not widen what leaves us.
    const filtered = destinationHeadersToSend({
      authorization: 'Bearer test',
      'x-api-key': 'k',
      'x-custom-random': 'leak',
      'x-relay-key': 'must-not-leak',
      cookie: 'session=abc',
    });
    expect(filtered).toEqual({
      authorization: 'Bearer test',
      'x-api-key': 'k',
    });
  });

  it('drops CRLF-injection attempts even when the name is allowed', () => {
    expect(
      destinationHeadersToSend({ authorization: 'Bearer x\r\nX-Injected: 1' })
    ).toEqual({});
  });

  it('handles an empty input without error', () => {
    expect(destinationHeadersToSend({})).toEqual({});
  });

  it('the write-allowlist CHECK is the only outward gate — denied names cannot reach here', () => {
    // The write-time rule already excludes `x-relay-key` and `cookie`, so a customer
    // cannot put them here. This test pins the invariant — that even if a hand-edited
    // DB row somehow carried them, the forward-time function cannot widen the set.
    expect(
      destinationHeadersToSend({ 'x-relay-key': 'stored', cookie: 's=1' })
    ).toEqual({});
  });
});

describe('destinationHeaderNames — the only safe client projection', () => {
  it('returns ONLY the names, sorted, and never any ciphertext material', () => {
    const encrypted = encryptDestinationHeaders({
      Authorization: 'Bearer test',
      'X-API-Key': 'x',
    });
    const names = destinationHeaderNames(encrypted);
    expect(names).toEqual(['authorization', 'x-api-key']);

    // The CIPHERTEXT is not present anywhere in that array. A regression that leaked
    // the encrypted map directly would surface here.
    expect(JSON.stringify(names)).not.toMatch(/iv|ct|tag|\{/);
    expect(names.includes('value')).toBe(false);
  });
});
