import {
  Button,
  Container,
  Head,
  Html,
  Preview,
  Text,
} from '@react-email/components';
import EmailLayout from './EmailLayout';
import app from '@/lib/app';

interface DlqFallbackEmailProps {
  subject: string;
  teamName: string;
  routeName: string;
  destinationHost: string;
  failReason: string;
  dlqLink: string;
}

/**
 * [RELAY-48] Sent when a webhook lands in the DLQ for a team with no Slack webhook
 * configured — see `lib/relay/dlqNotify.ts` for when this fires.
 *
 * Deliberately does NOT include the request body, the full destination URL (query
 * strings can carry tokens), or any destination auth header — only `destinationHost`,
 * the same "enough to act, nothing secret" line the rest of this codebase draws around
 * destination configuration (see `Route.destinationHeadersEncrypted`'s comment in
 * schema.prisma).
 */
const DlqFallbackEmail = ({
  subject,
  teamName,
  routeName,
  destinationHost,
  failReason,
  dlqLink,
}: DlqFallbackEmailProps) => {
  return (
    <Html>
      <Head />
      <Preview>{subject}</Preview>
      <EmailLayout>
        <Text>
          A webhook on route <strong>{routeName}</strong> (team{' '}
          <strong>{teamName}</strong>) could not be delivered to{' '}
          <strong>{destinationHost}</strong> after every retry, and has been moved to
          the dead-letter queue.
        </Text>
        <Text>
          Reason: {failReason}
        </Text>
        <Text>
          This route has no Slack webhook configured, so this email is the only
          notification for this event.
        </Text>
        <Container className="text-center">
          <Button
            href={dlqLink}
            className="bg-brand text-white font-medium py-2 px-4 rounded"
          >
            View the dead-letter queue
          </Button>
        </Container>
        <Text>
          You can retry the delivery from the {app.name} dashboard once the
          destination is reachable again.
        </Text>
      </EmailLayout>
    </Html>
  );
};

export default DlqFallbackEmail;
