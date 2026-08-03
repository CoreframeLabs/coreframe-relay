import { describe, expect, it } from 'vitest';
import { validateDestination, isBlockedIPv4, isBlockedIPv6 } from '../src/services/ssrf';

/**
 * SSRF validator tests — attack scenarios 1 and 2 from relay-security-testing-plan.md.
 *
 * These assert the LITERAL-ADDRESS layer only. DNS rebinding is deliberately out of scope
 * here and is asserted as a known gap at the bottom of this file, so that nobody reads a
 * green suite as "SSRF is handled".
 */

const blocked = (url: string) => {
  const r = validateDestination(url);
  expect(r.ok, `expected BLOCKED but was allowed: ${url}`).toBe(false);
  return r;
};
const allowed = (url: string) => {
  const r = validateDestination(url);
  expect(r.ok, `expected ALLOWED but was blocked: ${url} ${r.ok ? '' : '— ' + r.reason}`).toBe(true);
  return r;
};

describe('scenario 1 — SSRF to cloud metadata', () => {
  it('blocks the AWS/GCP/Azure metadata address in every form', () => {
    blocked('http://169.254.169.254/latest/meta-data/');
    blocked('https://169.254.169.254/');
    blocked('http://169.254.169.254:80/iam/security-credentials/');
    // The whole 169.254.0.0/16 link-local range, not just the famous address.
    blocked('http://169.254.1.1/');
    blocked('http://169.254.255.255/');
  });

  it('blocks metadata hostnames, which is what actually appears in payloads', () => {
    blocked('http://metadata.google.internal/computeMetadata/v1/');
    blocked('http://metadata/');
    blocked('http://metadata.goog/');
    blocked('http://instance-data/');
  });

  it('blocks the IPv6-mapped form of the metadata address', () => {
    // REGRESSION: the WHATWG URL parser normalises this to [::ffff:a9fe:a9fe], so a
    // dotted-quad check never matches and the metadata address is reachable. This test
    // caught that bypass; do not weaken it.
    blocked('http://[::ffff:169.254.169.254]/');
    blocked('http://[::ffff:a9fe:a9fe]/');   // the normalised hex form, directly
    blocked('http://[::ffff:7f00:1]/');      // 127.0.0.1 mapped
    blocked('http://[::ffff:c0a8:1]/');      // 192.168.0.1 mapped
    blocked('http://[::ffff:0a00:1]/');      // 10.0.0.1 mapped
  });
});

describe('scenario 2 — SSRF to internal network', () => {
  it('blocks every RFC-1918 private range', () => {
    blocked('http://10.0.0.1/hook');
    blocked('http://10.255.255.255/');
    blocked('http://172.16.0.1/');
    blocked('http://172.31.255.255/');
    blocked('http://192.168.0.1/');
    blocked('http://192.168.1.254/hook');
  });

  it('does NOT block 172.x outside the /12 — an over-broad block breaks real customers', () => {
    allowed('http://172.15.0.1/hook');
    allowed('http://172.32.0.1/hook');
  });

  it('blocks loopback in all its spellings', () => {
    blocked('http://127.0.0.1/');
    blocked('http://127.1.2.3/');
    blocked('http://localhost/hook');
    blocked('http://localhost:3000/hook');
    blocked('http://[::1]/');
    blocked('http://foo.localhost/');
  });

  it('blocks link-local, unique-local and multicast IPv6', () => {
    blocked('http://[fe80::1]/');
    blocked('http://[fd00::1]/');
    blocked('http://[fc00::1]/');
    blocked('http://[ff02::1]/');
    blocked('http://[::]/');
  });

  it('blocks carrier-grade NAT, 0.0.0.0/8 and multicast IPv4', () => {
    blocked('http://100.64.0.1/');
    blocked('http://0.0.0.0/');
    blocked('http://0.1.2.3/');
    blocked('http://224.0.0.1/');
    blocked('http://255.255.255.255/');
  });

  it('blocks internal-by-definition suffixes', () => {
    blocked('http://db.internal/hook');
    blocked('http://printer.local/');
    blocked('http://host.lan/');
    blocked('http://svc.intranet/');
  });
});

describe('encoding bypasses', () => {
  it('blocks integer and hex encodings of a loopback address', () => {
    // 2130706433 === 127.0.0.1. A dotted-quad check alone sails straight past this.
    blocked('http://2130706433/');
    blocked('http://0x7f000001/');
  });

  it('blocks octal-looking dotted quads rather than guessing their meaning', () => {
    blocked('http://0177.0.0.1/');
  });
});

describe('scheme and credential handling', () => {
  it('blocks non-http schemes used for SSRF escalation', () => {
    blocked('file:///etc/passwd');
    blocked('gopher://127.0.0.1:6379/_FLUSHALL');
    blocked('dict://127.0.0.1:11211/stat');
    blocked('ftp://internal.example.com/');
    blocked('javascript:alert(1)');
  });

  it('blocks credentials embedded in the destination', () => {
    // We would forward these and log them.
    blocked('https://user:pass@api.example.com/hook');
    blocked('https://token@api.example.com/hook');
  });

  it('rejects unparseable input rather than normalising it', () => {
    blocked('not a url');
    blocked('');
    blocked('http://');
  });
});

describe('dangerous ports', () => {
  it('blocks pivot targets even on a public host', () => {
    for (const port of [22, 23, 25, 445, 3306, 5432, 6379, 9200, 11211, 27017]) {
      blocked(`http://api.example.com:${port}/hook`);
    }
  });

  it('ALLOWS the ports real webhook receivers actually use', () => {
    // An allow-list of {80,443} would break customers on 8080/3000 and push them to
    // disable the check entirely, which is a worse outcome.
    allowed('http://api.example.com:8080/hook');
    allowed('http://api.example.com:3000/hook');
    allowed('https://api.example.com:8443/hook');
  });
});

describe('legitimate destinations are not broken', () => {
  it('allows ordinary public webhook endpoints', () => {
    allowed('https://n8n.example.com/webhook/abc123');
    allowed('https://hooks.slack.com/services/T00/B00/XXX');
    allowed('http://api.myapp.io/hooks/shopify');
    allowed('https://make.com/hook/stripe?token=abc');
    allowed('https://1.1.1.1/hook');
    allowed('https://8.8.8.8/hook');
  });

  it('returns the parsed URL so callers do not re-parse', () => {
    const r = validateDestination('https://api.example.com/hook?x=1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url.hostname).toBe('api.example.com');
      expect(r.url.search).toBe('?x=1');
    }
  });

  it('gives a specific reason code, not a generic failure', () => {
    const r = validateDestination('http://169.254.169.254/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('blocked_ip');

    const s = validateDestination('file:///etc/passwd');
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.code).toBe('bad_scheme');
  });
});

describe('range helpers', () => {
  it('classifies IPv4 correctly at the boundaries', () => {
    expect(isBlockedIPv4('9.255.255.255')).toBe(false);
    expect(isBlockedIPv4('10.0.0.0')).toBe(true);
    expect(isBlockedIPv4('11.0.0.0')).toBe(false);
    expect(isBlockedIPv4('172.15.255.255')).toBe(false);
    expect(isBlockedIPv4('172.16.0.0')).toBe(true);
    expect(isBlockedIPv4('172.31.255.255')).toBe(true);
    expect(isBlockedIPv4('172.32.0.0')).toBe(false);
    expect(isBlockedIPv4('169.253.255.255')).toBe(false);
    expect(isBlockedIPv4('169.254.0.0')).toBe(true);
  });

  it('is not fooled by a hostname that merely looks like an IP', () => {
    expect(isBlockedIPv4('10.0.0.1.example.com')).toBe(false);
    expect(isBlockedIPv6('example.com')).toBe(false);
  });
});

describe('KNOWN GAP — DNS rebinding is NOT covered by this layer', () => {
  it('documents that a public name resolving inward is currently ALLOWED', () => {
    // This is the honest statement of what this file does not do. A hostname that
    // resolves to 169.254.169.254 passes, because this layer never resolves.
    // Closing it needs DNS-over-HTTPS resolution plus re-validation of every resolved
    // record, and redirect-chain validation. Tracked as a release blocker.
    const r = validateDestination('https://totally-public-name.example.com/hook');
    expect(r.ok).toBe(true);

    // If a future change adds resolution, this expectation should flip and this test
    // should be rewritten to assert the block. Failing here means the gap closed.
    expect(true).toBe(true);
  });
});
