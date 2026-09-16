import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';

import env from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { handleEvents } from '@/lib/jackson/dsyncEvents';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    if (req.method != 'POST') {
      throw new ApiError(400, `Method ${req.method} Not Allowed`);
    }

    if (!verifyWebhookSignature(req)) {
      console.error('Signature verification failed.');
      res.end();
      return;
    }

    await handleEvents(req.body);

    res.end();
  } catch (error: any) {
    console.error(error);
    res.end();
  }
}

const verifyWebhookSignature = (req: NextApiRequest) => {
  const signatureHeader = req.headers['boxyhq-signature'] as string;

  if (!signatureHeader) {
    return false;
  }

  // [security-audit 2026-09-16] Fail closed on an unset secret. `createHmac` with
  // `undefined` throws inside the handler's try/catch, which already ends the
  // response with no side effects — but a webhook receiver's signature check
  // should refuse explicitly, not by accident of an exception path.
  const secret = env.jackson.dsync.webhook_secret;
  if (!secret) {
    return false;
  }

  // Malformed header (one segment, missing `=`) used to throw a TypeError from
  // `s.split` on `undefined` — caught upstream, but the same "refuse explicitly"
  // rule applies.
  const [t, s] = signatureHeader.split(',');
  if (!t || !s) {
    return false;
  }
  const timestamp = parseInt(t.split('=')[1]);
  const signature = s.split('=')[1];
  if (!signature || Number.isNaN(timestamp)) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${JSON.stringify(req.body)}`)
    .digest('hex');

  // Constant-time compare. `===` short-circuits on the first differing byte; the
  // Stripe webhook next to this file and the proxy's `timingSafeEqualStrings` both
  // already do this — this receiver was the odd one out. Lengths must match before
  // `timingSafeEqual` is called or it throws.
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expectedSignature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
