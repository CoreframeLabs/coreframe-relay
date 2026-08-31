import useSWR from 'swr';
import { useTranslation } from 'next-i18next';
import { GetServerSidePropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';

import env from '@/lib/env';
import useTeam from 'hooks/useTeam';
import fetcher from '@/lib/fetcher';
import useCanAccess from 'hooks/useCanAccess';
import { TeamTab } from '@/components/team';
import Help from '@/components/billing/Help';
import { Error, Loading } from '@/components/shared';
import LinkToPortal from '@/components/billing/LinkToPortal';
import UpgradePrompt from '@/components/billing/UpgradePrompt';
import Subscriptions from '@/components/billing/Subscriptions';
import ProductPricing from '@/components/billing/ProductPricing';
import N8nWedgePaymentLink from '@/components/billing/N8nWedgePaymentLink';

const Payments = ({ teamFeatures, n8nWedgePaymentLink }) => {
  const { t } = useTranslation('common');
  const { canAccess } = useCanAccess();
  const { isLoading, isError, team } = useTeam();
  const { data } = useSWR(
    team?.slug ? `/api/teams/${team?.slug}/payments/products` : null,
    fetcher
  );

  if (isLoading) {
    return <Loading />;
  }

  if (isError) {
    return <Error message={isError.message} />;
  }

  if (!team) {
    return <Error message={t('team-not-found')} />;
  }

  const plans = data?.data?.products || [];
  const subscriptions = data?.data?.subscriptions || [];
  // [RELAY-49, AC5] "Paid nav" split: a team with no active Subscription row is
  // Free-tier by definition (matching the same real-vs-cached distinction
  // create-portal-link.ts's own gate now enforces server-side) — it sees an
  // upgrade prompt instead of a "Manage subscription" control that would open a
  // real Stripe portal with nothing in it.
  const hasActiveSubscription = subscriptions.some(
    (s: { active?: boolean }) => s.active
  );

  return (
    <>
      {canAccess('team_payments', ['read']) && (
        <>
          <TeamTab
            activeTab="payments"
            team={team}
            teamFeatures={teamFeatures}
          />

          <div className="flex gap-6 flex-col md:flex-row">
            {hasActiveSubscription ? (
              <LinkToPortal team={team} />
            ) : (
              <UpgradePrompt />
            )}
            <Help />
          </div>

          <div className="py-6">
            <N8nWedgePaymentLink team={team} paymentLinkUrl={n8nWedgePaymentLink} />
          </div>

          <div className="py-6">
            <Subscriptions subscriptions={subscriptions} />
          </div>

          <ProductPricing plans={plans} subscriptions={subscriptions} />
        </>
      )}
    </>
  );
};

export async function getServerSideProps({
  locale,
}: GetServerSidePropsContext) {
  if (!env.teamFeatures.payments) {
    return {
      notFound: true,
    };
  }

  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
      teamFeatures: env.teamFeatures,
      n8nWedgePaymentLink: env.stripe.n8nWedgePaymentLink ?? null,
    },
  };
}

export default Payments;
