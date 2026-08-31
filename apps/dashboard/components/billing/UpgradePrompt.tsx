import { useTranslation } from 'next-i18next';

import { Card } from '@/components/shared';

// [RELAY-49, AC5] The paid-nav counterpart to LinkToPortal: a Free-tier team (no
// active subscription) sees this instead of a "Manage subscription" control that
// would otherwise open a real Stripe portal session with nothing to manage.
// Rendered in place of <LinkToPortal /> on the billing page — never both at once,
// see pages/teams/[slug]/billing.tsx.
const UpgradePrompt = () => {
  const { t } = useTranslation('common');

  return (
    <Card>
      <Card.Body>
        <Card.Header>
          <Card.Title>{t('no-active-subscription-title')}</Card.Title>
          <Card.Description>
            {t('no-active-subscription-description')}
          </Card.Description>
        </Card.Header>
      </Card.Body>
    </Card>
  );
};

export default UpgradePrompt;
