/**
 * [RELAY-48] `secure` must be derived from the port, never hardcoded.
 *
 * Reproduced directly against production before this fix: nodemailer's own
 * `createTransport({ secure: false, port: 465 })` speaks plaintext SMTP against a
 * socket that only ever answers with a TLS ServerHello (port 465 is implicit TLS,
 * not STARTTLS) — every real send hung for ~40s then failed with nodemailer's own
 * "Greeting never received". This silently broke every signup-verification and
 * password-reset email since the day SMTP_* was first configured, because the
 * "sending works" evidence on record was always a direct Resend API call, never
 * this SMTP client path (see RELAY-48's own tracker entry).
 *
 * Mocks nodemailer entirely and asserts `createTransport`'s `secure` argument
 * matches the port under test — proves the derivation, not a live send. Each case
 * runs in its own isolated module registry (`jest.isolateModules`) so `sendEmail.ts`'s
 * module-level `createTransport(...)` call — and the mock it hits — are both fresh
 * per port, not shared/stale state from a previous case.
 */

function loadSendEmailWithPort(port: number): jest.Mock {
  let createTransport!: jest.Mock;

  jest.isolateModules(() => {
    createTransport = jest.fn(() => ({ sendMail: jest.fn() }));

    jest.doMock('nodemailer', () => ({
      __esModule: true,
      default: { createTransport },
    }));

    jest.doMock('lib/env', () => ({
      __esModule: true,
      default: {
        smtp: { host: 'smtp.example.com', port, user: 'u', password: 'x', from: 'a@b.com' },
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('lib/email/sendEmail');
  });

  return createTransport;
}

describe('[RELAY-48] SMTP transport secure flag matches the port', () => {
  it('port 465 (Resend, implicit TLS) uses secure: true', () => {
    const createTransport = loadSendEmailWithPort(465);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true })
    );
  });

  it('port 587 (STARTTLS) uses secure: false', () => {
    const createTransport = loadSendEmailWithPort(587);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false })
    );
  });
});
