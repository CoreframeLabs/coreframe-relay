import nodemailer from 'nodemailer';

import env from '../env';

// [RELAY-48] `secure` must match the port, not be hardcoded: port 465 is implicit
// TLS (the client opens a TLS connection immediately), while 587/25 use STARTTLS
// (plaintext first, upgraded in-band). Hardcoding `secure: false` against Resend's
// documented port 465 made nodemailer speak plaintext SMTP at a socket that only
// ever answers with a TLS ServerHello — the client waits forever for a plaintext
// "220 ready" greeting that will never arrive. Confirmed by direct reproduction
// against production: every real send failed with nodemailer's own "Greeting never
// received" after a ~40s timeout, silently turning every signup/reset email into a
// guaranteed failure since the day SMTP_* was first configured.
const transporter = nodemailer.createTransport({
  host: env.smtp.host,
  port: env.smtp.port,
  secure: env.smtp.port === 465,
  auth: {
    user: env.smtp.user,
    pass: env.smtp.password,
  },
});

interface EmailData {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export const sendEmail = async (data: EmailData) => {
  if (!env.smtp.host) {
    return;
  }

  const emailDefaults = {
    from: env.smtp.from,
  };

  await transporter.sendMail({ ...emailDefaults, ...data });
};
