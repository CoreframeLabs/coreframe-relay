import type { GetServerSidePropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';

import { DeliveryLogFeed } from '@/components/relay/DeliveryLogFeed';

/**
 * /teams/[slug]/relay/buffer/log — Relay Buffer: Live Delivery Log. [RELAY-7]
 *
 * Access control is NOT here, matching `buffer.tsx`. It lives in the SSE endpoint this
 * page connects to (`throwIfNoTeamAccess` → `getCurrentUserWithTeam`), which is the
 * boundary that matters: a page-level check protects a render, an API check protects the
 * data. The stream is the only thing that ever sees a delivery row.
 *
 * Rendered entirely client-side on purpose. `EventSource` has no server equivalent, so
 * server-rendering an initial list would mean two code paths producing the same rows and
 * two chances for them to disagree — the stream's own snapshot event is the first paint.
 */
const RelayDeliveryLogPage = () => <DeliveryLogFeed />;

export async function getServerSideProps({
  locale,
}: GetServerSidePropsContext) {
  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
}

export default RelayDeliveryLogPage;
