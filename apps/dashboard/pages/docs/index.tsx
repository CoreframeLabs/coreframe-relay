/**
 * [RELAY-108] `/docs` index.
 *
 * Before this ticket there was no public docs surface at all — `/docs` 307'd to
 * `/auth/login` (verified in `relay-gtm-readiness-audit-2026-08-21.md` §7 B2). The
 * ticket's acceptance criterion is satisfied at minimum by `/docs/integrations/n8n`
 * alone, but a bare `/docs` that itself redirects to login would still be a dead end
 * for anyone who trims the URL back or follows a bare `/docs` link, so this is a real,
 * if currently one-entry, index rather than a redirect.
 */
import type { GetStaticPropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import Link from 'next/link';

import DocsPage, { docsGetLayout } from '@/components/docs/DocsPage';
import { focusRing } from '@/components/defaultLanding/LandingPrimitives';
import type { DocsSection } from '@/components/docs/DocsPage';
import type { NextPageWithLayout } from 'types';

const sections: DocsSection[] = [
  {
    id: 'integrations',
    title: 'Integrations',
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <Link
            href="/docs/integrations/n8n"
            className={`rounded text-landing-accent-text underline underline-offset-2 hover:text-landing-accent-text-hover ${focusRing}`}
          >
            n8n — webhook reliability setup guide
          </Link>{' '}
          <span className="text-landing-secondary">
            — the documented n8n bugs Relay sits in front of, what actually
            changes and what doesn&rsquo;t, and step-by-step setup.
          </span>
        </li>
      </ul>
    ),
  },
];

const DocsIndexPage: NextPageWithLayout = () => (
  <DocsPage
    eyebrow="Docs"
    title="Coreframe Relay documentation"
    metaTitle="Documentation | Coreframe Relay"
    metaDescription="Setup guides for using Coreframe Relay in front of your webhook sources, starting with n8n."
    intro={
      <p>
        Guides for wiring Relay in front of the thing that actually sends or
        receives your webhooks. Start with the integration you use.
      </p>
    }
    sections={sections}
  />
);

export const getStaticProps = async ({ locale }: GetStaticPropsContext) => {
  return {
    props: {
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
};

DocsIndexPage.getLayout = docsGetLayout;

export default DocsIndexPage;
