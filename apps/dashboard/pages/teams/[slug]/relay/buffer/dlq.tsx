import type { GetServerSidePropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import { DlqQueue } from '@/components/relay/DlqQueue';

/**
 * /teams/[slug]/relay/buffer/dlq — Relay Buffer: dead letter queue. [RELAY-8]
 *
 * Access control is NOT here, exactly as on `relay/buffer.tsx`. It lives in the API routes
 * this page fetches (`throwIfNoTeamAccess`), which is the boundary that actually matters:
 * a page-level check protects a render, while the API check protects the data — and on
 * this page it also protects the Retry action, which is the one that reaches outside the
 * system.
 *
 * Note `buffer.tsx` and `buffer/dlq.tsx` coexist: Next resolves `/relay/buffer` to the
 * file and `/relay/buffer/dlq` to the directory entry.
 */
const RelayDlqPage = () => <DlqQueue />;

export async function getServerSideProps({
  locale,
}: GetServerSidePropsContext) {
  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
}

export default RelayDlqPage;
