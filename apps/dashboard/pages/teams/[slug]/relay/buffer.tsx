import type { GetServerSidePropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import { BufferRoutes } from '@/components/relay/BufferRoutes';

/**
 * /teams/[slug]/relay/buffer — Relay Buffer: Routes. [RELAY-6]
 *
 * Access control is NOT here. It lives in the API route this page fetches
 * (`throwIfNoTeamAccess`), which is the boundary that actually matters: a page-level
 * check protects a render, while the API check protects the data. BoxyHQ's other team
 * pages follow the same split.
 */
const RelayBufferPage = () => <BufferRoutes />;

export async function getServerSideProps({ locale }: GetServerSidePropsContext) {
  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
}

export default RelayBufferPage;
