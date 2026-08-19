import { Button } from 'react-daisyui';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'next-i18next';

import { Card } from '@/components/shared';
import { Team } from '@prisma/client';

interface N8nWedgePaymentLinkProps {
  team: Team;
  paymentLinkUrl?: string;
}

// Surfaces the single flat n8n-wedge Payment Link (test mode
// today) on the existing billing page. `client_reference_id` is how the
// resulting checkout.session.completed webhook (pages/api/webhooks/stripe.ts)
// knows which team just paid — Stripe echoes the query param back on the
// session untouched, no server-side session creation needed for this flow.
const N8nWedgePaymentLink = ({ team, paymentLinkUrl }: N8nWedgePaymentLinkProps) => {
  const { t } = useTranslation('common');

  if (!paymentLinkUrl) {
    return null;
  }

  const url = `${paymentLinkUrl}?client_reference_id=${encodeURIComponent(team.id)}`;

  return (
    <Card>
      <Card.Body>
        <Card.Header>
          <Card.Title>{t('n8n-wedge-title')}</Card.Title>
          <Card.Description>{t('n8n-wedge-description')}</Card.Description>
        </Card.Header>
        <div>
          <a href={url} target="_blank" rel="noopener noreferrer">
            <Button type="button" color="primary" size="sm" variant="outline">
              {t('n8n-wedge-cta')}
              <ArrowTopRightOnSquareIcon className="w-5 h-5 ml-2" />
            </Button>
          </a>
        </div>
      </Card.Body>
    </Card>
  );
};

export default N8nWedgePaymentLink;
