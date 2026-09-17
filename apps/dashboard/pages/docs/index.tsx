/**
 * [RELAY-108] `/docs` index.
 *
 * Before this ticket there was no public docs surface at all — `/docs` 307'd to
 * `/auth/login` (verified in `relay-gtm-readiness-audit-2026-08-21.md` §7 B2). The
 * ticket's acceptance criterion is satisfied at minimum by `/docs/integrations/n8n`
 * alone, but a bare `/docs` that itself redirects to login would still be a dead end
 * for anyone who trims the URL back or follows a bare `/docs` link, so this is a real,
 * if currently one-entry, index rather than a redirect.
 *
 * [ux-walkthrough 2026-09-15, finding 5b] No longer one entry. `growth/product/
 * relay-ux-walkthrough-2026-09-15.md` (Dana, fold 10) found that a technical evaluator
 * who clicked Docs landed on "a single page about someone else's product" and read
 * that as a maturity signal. There is now a general quickstart (`/docs/quickstart`)
 * listed first, under its own "Getting started" heading, with the n8n guide kept
 * under Integrations. The landing nav/footer and the pricing header's "Docs" links
 * now point here rather than straight at the n8n page, so this index is the page a
 * "Docs" click actually reaches.
 *
 * [RELAY-163] "Troubleshooting" section added below, driven by `listAllPages()`
 * (`lib/docs/troubleshooting.ts`) rather than hand-listed like the two sections
 * above — the whole point of RELAY-163's route is that a new
 * `docs/troubleshooting/<slug>.md` shows up here with no edit to this file. At
 * the time this ticket lands there are zero real pages (RELAY-149 is being
 * drafted in parallel), so the section renders nothing and its heading is
 * suppressed entirely — an empty "Troubleshooting" heading with nothing under
 * it would be a worse index than the one this ticket found, and there is no
 * "remove this later" step needed: it starts showing the moment a real file
 * lands.
 */
import type { GetStaticPropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import Link from 'next/link';

import DocsPage, { docsGetLayout } from '@/components/docs/DocsPage';
import { focusRing } from '@/components/defaultLanding/LandingPrimitives';
import type { DocsSection } from '@/components/docs/DocsPage';
import { listAllPages } from '@/lib/docs/troubleshooting';
import type { NextPageWithLayout } from 'types';

const staticSections: DocsSection[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    body: (
      <ul className="list-disc space-y-2 pl-5">
        <li>
          <Link
            href="/docs/quickstart"
            className={`rounded text-landing-accent-text underline underline-offset-2 hover:text-landing-accent-text-hover ${focusRing}`}
          >
            Quickstart — any webhook sender
          </Link>{' '}
          <span className="text-landing-secondary">
            — sign up, create a route, get the ingest URL, point your sender at
            it; then what the delivery log shows and the limits to know before
            relying on it.
          </span>
        </li>
      </ul>
    ),
  },
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

type TroubleshootingListItem = { slug: string; title: string; description: string };

const troubleshootingSection = (pages: TroubleshootingListItem[]): DocsSection[] =>
  pages.length === 0
    ? []
    : [
        {
          id: 'troubleshooting',
          title: 'Troubleshooting',
          body: (
            <ul className="list-disc space-y-2 pl-5">
              {pages.map((page) => (
                <li key={page.slug}>
                  <Link
                    href={`/docs/troubleshooting/${page.slug}`}
                    className={`rounded text-landing-accent-text underline underline-offset-2 hover:text-landing-accent-text-hover ${focusRing}`}
                  >
                    {page.title}
                  </Link>{' '}
                  <span className="text-landing-secondary">— {page.description}</span>
                </li>
              ))}
            </ul>
          ),
        },
      ];

type DocsIndexProps = {
  troubleshootingPages: TroubleshootingListItem[];
};

const DocsIndexPage: NextPageWithLayout<DocsIndexProps> = ({
  troubleshootingPages,
}) => (
  <DocsPage
    eyebrow="Docs"
    title="Coreframe Relay documentation"
    metaTitle="Documentation | Coreframe Relay"
    metaDescription="Setup guides for using Coreframe Relay in front of your webhook sources: a general quickstart for any sender, and an n8n-specific guide."
    canonical="https://relay.coreframe-labs.dev/docs"
    intro={
      <p>
        Guides for wiring Relay in front of the thing that actually sends or
        receives your webhooks. The quickstart covers any sender; the
        integration guides cover what is specific to one.
      </p>
    }
    sections={[...staticSections, ...troubleshootingSection(troubleshootingPages)]}
  />
);

export const getStaticProps = async ({ locale }: GetStaticPropsContext) => {
  const troubleshootingPages: TroubleshootingListItem[] = listAllPages().map((page) => ({
    slug: page.slug,
    title: page.data.title,
    description: page.data.description,
  }));

  return {
    props: {
      troubleshootingPages,
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
};

DocsIndexPage.getLayout = docsGetLayout;

export default DocsIndexPage;
