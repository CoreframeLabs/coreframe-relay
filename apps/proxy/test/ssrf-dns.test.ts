import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAndValidateDestination } from '@coreframe-relay/types';

/**
 * [RELAY-33] DNS-rebinding closure tests.
 *
 * `apps/proxy/test/ssrf.test.ts` proves the LITERAL-address layer and explicitly
 * documents, in its own "KNOWN GAP" describe block, that a hostname resolving inward was
 * — before this file's subject existed — allowed straight through. This file is that gap
 * closed: it drives `resolveAndValidateDestination` (`packages/types/src/ssrf-dns.ts`)
 * directly, with a mocked DoH resolver, so the DNS layer is tested in full isolation from
 * both call sites that wire it in (`apps/proxy/src/routes/ingest.ts` and
 * `apps/dashboard/lib/relay/forward.ts` — covered separately by
 * `ssrf-dns-rebinding.forward.spec.ts` and the ingest suite's own rebinding cases).
 *
 * `fetch` is mocked at the module boundary here, not against a real DoH server: a unit
 * suite that depends on live internet access to Cloudflare's resolver is a suite that
 * fails in CI for reasons that have nothing to do with a regression. The real endpoint
 * (`https://cloudflare-dns.com/dns-query?name=…&type=A`, `accept: application/dns-json`)
 * was verified by hand against the live resolver while building `ssrf-dns.ts` — this file
 * asserts the CODE that calls it, not the resolver's own availability.
 */

type DohAnswer = { name: string; type: number; TTL: number; data: string };

/** Cloudflare's DoH JSON response shape, straight from the live resolver we curled. */
function dohBody(answers: DohAnswer[], status = 0): string {
  return JSON.stringify({ Status: status, Answer: answers });
}

const A = (data: string): DohAnswer => ({ name: 'x', type: 1, TTL: 60, data });
const AAAA = (data: string): DohAnswer => ({ name: 'x', type: 28, TTL: 60, data });

/**
 * Stub `fetch` to answer ONLY DoH queries (`…/dns-query?…`), keyed by the `type` query
 * param, from a caller-supplied table. Anything not `/dns-query` throws — nothing in
 * these tests should ever reach an actual destination fetch, because `resolveAndValidate
 * Destination` never calls one itself.
 */
function stubDoh(byType: { A?: DohAnswer[]; AAAA?: DohAnswer[] }) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (!url.includes('/dns-query')) {
      throw new Error(`unexpected non-DoH fetch in a unit test: ${url}`);
    }
    const type = new URL(url).searchParams.get('type');
    const answers = type === 'AAAA' ? (byType.AAAA ?? []) : (byType.A ?? []);
    return new Response(dohBody(answers), {
      status: 200,
      headers: { 'content-type': 'application/dns-json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[RELAY-33] resolveAndValidateDestination — the DNS-rebinding gap, closed', () => {
  it('THE ATTACK: a hostname that resolves to cloud metadata is refused, even though the literal check alone would allow it', async () => {
    stubDoh({ A: [A('169.254.169.254')] });

    const r = await resolveAndValidateDestination('http://evil-attacker-domain.example/hook');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('blocked_resolved_ip');
  });

  it('a hostname that resolves to an RFC-1918 address is refused', async () => {
    stubDoh({ A: [A('10.20.30.40')] });
    const r = await resolveAndValidateDestination('https://internal-looking.example/hook');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('blocked_resolved_ip');
  });

  it('refuses when ANY resolved address is blocked, even if another is public — DNS can answer with more than one record', async () => {
    stubDoh({ A: [A('93.184.216.34'), A('169.254.169.254')] });
    const r = await resolveAndValidateDestination('https://mixed-answers.example/hook');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('blocked_resolved_ip');
  });

  it('checks the AAAA answer too, not only A', async () => {
    stubDoh({ AAAA: [AAAA('fd00::1')] }); // unique-local — blocked
    const r = await resolveAndValidateDestination('https://ipv6-only.example/hook');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('blocked_resolved_ip');
  });

  it('REGRESSION: a normal, correctly-resolving public hostname still passes', async () => {
    stubDoh({ A: [A('93.184.216.34')] }); // example.com's real A record at time of writing
    const r = await resolveAndValidateDestination('https://n8n.example.com/webhook/abc123');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url.hostname).toBe('n8n.example.com');
  });

  it('REGRESSION: a public hostname with both A and AAAA records passes when both are clean', async () => {
    stubDoh({ A: [A('93.184.216.34')], AAAA: [AAAA('2606:2800:220:1:248:1893:25c8:1946')] });
    const r = await resolveAndValidateDestination('https://dual-stack.example/hook');
    expect(r.ok).toBe(true);
  });

  describe('fail-closed on every DoH failure mode', () => {
    it('a DoH network error refuses the destination, not allows it', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('network error');
        })
      );
      const r = await resolveAndValidateDestination('https://flaky-resolver.example/hook');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('dns_resolution_failed');
    });

    it('a non-2xx from the DoH resolver refuses the destination', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('server error', { status: 500 }))
      );
      const r = await resolveAndValidateDestination('https://resolver-down.example/hook');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('dns_resolution_failed');
    });

    it('malformed JSON from the resolver refuses the destination', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('not json{{{', { status: 200 }))
      );
      const r = await resolveAndValidateDestination('https://bad-json.example/hook');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('dns_resolution_failed');
    });

    it('a DoH lookup that never answers times out and fails closed, not open', async () => {
      // Mimics real fetch's abort contract: the promise settles only when the signal
      // fires, and never on its own. If the timeout wiring were missing, this test would
      // hang instead of failing, which is itself the point of asserting it explicitly.
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                const err = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
              });
            })
        )
      );

      const r = await resolveAndValidateDestination('https://never-answers.example/hook', {
        timeoutMs: 20,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('dns_resolution_failed');
    });

    it('a hostname with zero A/AAAA records refuses rather than assuming safety', async () => {
      stubDoh({}); // both queries succeed, both come back empty
      const r = await resolveAndValidateDestination('https://no-such-record.example/hook');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('dns_resolution_failed');
    });

    it('an NXDOMAIN-shaped answer (Status != 0) is treated as no records, not an error to ignore', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 }))
      );
      const r = await resolveAndValidateDestination('https://nxdomain.example/hook');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('dns_resolution_failed');
    });
  });

  describe('literal IPs never touch DNS at all', () => {
    it('an IPv4 literal destination is checked without ever calling fetch', async () => {
      const { fn } = stubDoh({});
      const r = await resolveAndValidateDestination('http://93.184.216.34/hook');
      expect(r.ok).toBe(true);
      expect(fn).not.toHaveBeenCalled();
    });

    it('a BLOCKED IPv4 literal is refused without ever calling fetch', async () => {
      const { fn } = stubDoh({});
      const r = await resolveAndValidateDestination('http://169.254.169.254/latest/meta-data/');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('blocked_ip'); // the LITERAL code, not the DNS one
      expect(fn).not.toHaveBeenCalled();
    });

    it('an IPv6 literal destination is checked without ever calling fetch', async () => {
      const { fn } = stubDoh({});
      const r = await resolveAndValidateDestination('http://[2606:2800:220:1:248:1893:25c8:1946]/hook');
      expect(r.ok).toBe(true);
      expect(fn).not.toHaveBeenCalled();
    });

    it('a blocked hostname (literal check) is refused before DNS is ever consulted', async () => {
      const { fn } = stubDoh({});
      const r = await resolveAndValidateDestination('http://localhost/hook');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('blocked_host'); // literal code — never reached DNS
      expect(fn).not.toHaveBeenCalled();
    });

    it('a non-http scheme is refused before DNS is ever consulted', async () => {
      const { fn } = stubDoh({});
      const r = await resolveAndValidateDestination('file:///etc/passwd');
      expect(r.ok).toBe(false);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  it('queries both A and AAAA for every hostname, in parallel', async () => {
    const { fn, calls } = stubDoh({ A: [A('93.184.216.34')] });
    await resolveAndValidateDestination('https://both-types.example/hook');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls.some((u) => u.includes('type=A'))).toBe(true);
    expect(calls.some((u) => u.includes('type=AAAA'))).toBe(true);
  });
});
