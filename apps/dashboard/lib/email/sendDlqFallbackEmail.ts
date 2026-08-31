import { sendEmail } from './sendEmail';
import { render } from '@react-email/components';
import { DlqFallbackEmail } from '@/components/emailTemplates';
import app from '../app';
import env from '../env';

interface SendDlqFallbackEmailParams {
  to: string;
  teamSlug: string;
  teamName: string;
  routeName: string;
  destinationHost: string;
  failReason: string;
}

/**
 * [RELAY-48] The DLQ email fallback — see `lib/relay/dlqNotify.ts` for the decision of
 * WHEN this fires (a route with no Slack webhook configured). This module only builds
 * and sends the message, the same split every other `send*Email.ts` in this directory
 * follows.
 */
export const sendDlqFallbackEmail = async ({
  to,
  teamSlug,
  teamName,
  routeName,
  destinationHost,
  failReason,
}: SendDlqFallbackEmailParams) => {
  const subject = `${app.name}: a webhook on "${routeName}" was dead-lettered`;
  const dlqLink = `${env.appUrl}/teams/${teamSlug}/relay/buffer/dlq`;

  const html = await render(
    DlqFallbackEmail({
      subject,
      teamName,
      routeName,
      destinationHost,
      failReason,
      dlqLink,
    })
  );

  await sendEmail({
    to,
    subject,
    html,
  });
};
