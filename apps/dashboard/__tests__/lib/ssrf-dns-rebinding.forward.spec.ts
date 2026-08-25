/**
 * @jest-environment node
 */

/**
 * [RELAY-33] THE DNS-REBINDING GAP, closed at the FORWARD-TIME call site.
 *
 * ─── WHY THIS IS A SEPARATE FILE ─────────────────────────────────────────────────────
 *
 * `ssrf.forward.spec.ts` proves the LITERAL-address layer runs at forward time and its
 * own header explicitly hands off the DNS-resolution half: "Cloudflare Workers cannot
 * resolve DNS directly... it needs a DNS-over-HTTPS lookup plus re-validation of every
 * resolved A/AAAA record" — named as future work, not built there. This file is that
 * future work, done: it drives the REAL `forwardToDestination` (the same function
 * `apps/dashboard/lib/relay/forward.ts` exports, called by the QStash consumer on every
 * live delivery and every DLQ retry) with a mocked DoH resolver, and asserts on both the
 * validation OUTCOME and — for the attack case — that the actual destination is never
 * touched at the network layer, the same "assert on the wire, not just the outcome"
 * standard the sibling file sets.
 *
 * ─── THE ATTACK ───────────────────────────────────────────────────────────────────────
 *
 * A customer (or an attacker who controls the destination's DNS record) configures a
 * route destination as an ordinary-looking public hostname. It resolves to a legitimate
 * address at the moment the route is validated — passing every literal-address check —
 * then the DNS record changes to point at 169.254.169.254 (cloud metadata) or an internal
 * address by the time Relay actually forwards to it. Before this file's subject existed,
 * `forward.ts` called `validateDestination` (literal-only) and this hostname sailed
 * straight through every single time, at ingest AND at every retry.
 *
 * `forward.ts` now calls `resolveAndValidateDestination`, which performs a FRESH DoH
 * lookup immediately before the outbound `fetch` — not once, early, and cached — so a
 * record that has changed by forward time is caught right then, which is the whole point:
 * re-resolving right before use is what actually closes the window, not just moves it.
 *
 * `fetch` is mocked here for the DoH leg only; the actual destination fetch is redirected
 * to a REAL local listener via URL rewriting rather than mocked outright, so the
 * "happy path still forwards" assertion is proven against a genuine HTTP round trip, not
 * an assumption about what `fetch` would have done.
 */

import http from 'node:http';
import { forwardToDestination } from '@/lib/relay/forward';

/** A listener that answers 200 to anything, recording what it saw. */
function alwaysOk(): Promise<{
  port: number;
  seen: number;
  close: () => Promise<void>;
}> {
  const state = { seen: 0 };
  const server = http.createServer((_req, res) => {
    state.seen += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('server.listen produced a non-TCP address'));
        return;
      }
      resolve({
        port: address.port,
        get seen() {
          return state.seen;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const REAL_FETCH = global.fetch;

type DohAnswer = { name: string; type: number; TTL: number; data: string };

function dohResponse(answers: DohAnswer[]): Response {
  return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
    status: 200,
    headers: { 'content-type': 'application/dns-json' },
  });
}

/**
 * Stub `global.fetch` to answer DoH queries from `dnsAnswers`, and — when
 * `redirect` is given — rewrite a request whose hostname matches `redirect.host` onto
 * `127.0.0.1:redirect.port` and pass it through to the REAL `fetch`, so the "happy path"
 * test proves an actual HTTP round trip rather than a second layer of mocking.
 * Everything else is left completely unmocked.
 */
function stubFetch(opts: {
  dnsAnswers: Record<string, string[]>;
  redirect?: { host: string; port: number };
}) {
  const calls: string[] = [];
  const spy = jest.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url.includes('cloudflare-dns.com/dns-query')) {
      const parsed = new URL(url);
      const name = parsed.searchParams.get('name') ?? '';
      const type = parsed.searchParams.get('type');
      const ips = opts.dnsAnswers[name] ?? [];
      const wantsV6 = type === 'AAAA';
      const answers = ips
        .filter((ip) => ip.includes(':') === wantsV6)
        .map((data) => ({ name, type: wantsV6 ? 28 : 1, TTL: 60, data }));
      return dohResponse(answers);
    }

    if (opts.redirect && url.includes(opts.redirect.host)) {
      const rewritten = url.replace(
        new RegExp(`${opts.redirect.host}(:\\d+)?`),
        `127.0.0.1:${opts.redirect.port}`
      );
      return REAL_FETCH(rewritten, init);
    }

    // Anything else reaching real fetch in these tests is itself a finding: it means
    // either the DNS check was skipped, or the destination was not redirected as
    // expected, and either is worth seeing fail loudly rather than silently hitting the
    // real network.
    throw new Error(`unexpected un-redirected fetch in a mocked test: ${url}`);
  });
  return { spy, calls };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('[RELAY-33] forward-time DNS-rebinding closure', () => {
  it('THE ATTACK: a hostname that resolves to cloud metadata is refused — nothing is sent', async () => {
    const host = 'evil-attacker-domain.example';
    const { calls } = stubFetch({ dnsAnswers: { [host]: ['169.254.169.254'] } });

    const outcome = await forwardToDestination({
      destination: `https://${host}/hook`,
      headers: {},
      body: '{}',
      requestId: 'c2c4d4a0-1000-4000-8000-000000000001',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.responseCode).toBeNull();
    expect(outcome.failReason).toBe('destination rejected: blocked_resolved_ip');
    // Only the DoH lookups happened — never a request that could reach the metadata host.
    expect(calls.every((u) => u.includes('cloudflare-dns.com/dns-query'))).toBe(true);
    // (The DoH query URL itself legitimately contains the hostname as a `?name=`
    // param — what must be false is a call to the host OUTSIDE a DoH lookup.)
    expect(calls.some((u) => u.includes(host) && !u.includes('cloudflare-dns.com'))).toBe(false);
  });

  it('THE ATTACK, RFC-1918 form: a hostname resolving to an internal address is refused — nothing is sent', async () => {
    const host = 'internal-behind-dns.example';
    const { calls } = stubFetch({ dnsAnswers: { [host]: ['10.9.9.9'] } });

    const outcome = await forwardToDestination({
      destination: `https://${host}/hook`,
      headers: {},
      body: '{}',
      requestId: 'c2c4d4a0-1000-4000-8000-000000000002',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failReason).toBe('destination rejected: blocked_resolved_ip');
    // (The DoH query URL itself legitimately contains the hostname as a `?name=`
    // param — what must be false is a call to the host OUTSIDE a DoH lookup.)
    expect(calls.some((u) => u.includes(host) && !u.includes('cloudflare-dns.com'))).toBe(false);
  });

  it('fails CLOSED, not open, when the DoH resolver itself errors', async () => {
    const host = 'resolver-times-out.example';
    jest.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('cloudflare-dns.com/dns-query')) {
        throw new TypeError('simulated DoH network failure');
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const outcome = await forwardToDestination({
      destination: `https://${host}/hook`,
      headers: {},
      body: '{}',
      requestId: 'c2c4d4a0-1000-4000-8000-000000000003',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failReason).toBe('destination rejected: dns_resolution_failed');
  });

  it('REGRESSION: a hostname that resolves to an ordinary public address still forwards — a real round trip, not a mocked outcome', async () => {
    const dst = await alwaysOk();
    const host = 'legit-looking-webhook.example';

    const { calls } = stubFetch({
      dnsAnswers: { [host]: ['93.184.216.34'] }, // a real, clean, public address
      redirect: { host, port: dst.port },
    });

    const outcome = await forwardToDestination({
      destination: `http://${host}:${dst.port}/hook`,
      headers: {},
      body: '{"real":true}',
      requestId: 'c2c4d4a0-1000-4000-8000-000000000004',
    });

    const seen = dst.seen;
    await dst.close();

    expect(outcome.ok).toBe(true);
    expect(outcome.responseCode).toBe(200);
    // The DoH lookups happened AND the real destination was actually reached — DNS
    // resolution ran and did not block a destination it should not block.
    expect(calls.some((u) => u.includes('cloudflare-dns.com/dns-query'))).toBe(true);
    expect(seen).toBe(1);
  });
});
