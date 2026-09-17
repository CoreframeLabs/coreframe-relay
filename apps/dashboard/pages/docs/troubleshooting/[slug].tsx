/**
 * [RELAY-163] Generic Markdown-sourced renderer for `/docs/troubleshooting/<slug>`.
 *
 * Per `growth/product/relay-sprint-plan.md` RELAY-163 and its spec,
 * `growth/content/relay-seo-content-location-decision-2026-09-17.md`
 * ("Implementation spec"): one repo-root Markdown file per page
 * (`docs/troubleshooting/<slug>.md`) is simultaneously the reviewed source, the
 * public `.md` mirror (`scripts/sync-doc-mirrors.mjs`), and — as of this file —
 * the thing this page renders from. Every later troubleshooting page (starting
 * with RELAY-149) is a Markdown file drop into that directory, not a JSX
 * transcription like `pages/docs/integrations/n8n.tsx` or
 * `pages/docs/quickstart.tsx` had to be.
 *
 * `getStaticPaths`/`getStaticProps` + `fallback: false`: single locale
 * (`next-i18next` is configured for `en` only), so one path per file is enough —
 * there is no need to fan out per-locale like a multi-locale site would.
 * Frontmatter validation and the canonical/slug/build-URL consistency check live
 * in `lib/docs/troubleshooting.ts` (`getPage`) so this file only wires that
 * validated data into `DocsPage`; a missing required field or a canonical that
 * doesn't match the built URL throws there, which fails `next build` with a
 * clear message — not a silent skip, per this ticket's acceptance criteria.
 */
import type { GetStaticPaths, GetStaticPropsContext } from 'next';
import { serverSideTranslations } from 'next-i18next/serverSideTranslations';

import DocsPage, { docsGetLayout } from '@/components/docs/DocsPage';
import MarkdownBody from '@/components/docs/MarkdownBody';
import type { DocsSection } from '@/components/docs/DocsPage';
import { getPage, listSlugs, type TroubleshootingFrontmatter } from '@/lib/docs/troubleshooting';
import { splitMarkdownSections } from '@/lib/docs/splitSections';
import type { NextPageWithLayout } from 'types';

type PageProps = {
  data: TroubleshootingFrontmatter;
  intro: string;
  sections: { id: string; title: string; body: string }[];
};

const buildLastUpdated = (data: TroubleshootingFrontmatter): string =>
  data.n8nVersionVerified
    ? `Last updated ${data.dateModified} · last verified against n8n ${data.n8nVersionVerified} on ${data.verifiedOn} by ${data.verifiedBy}`
    : `Last updated ${data.dateModified} · last verified on ${data.verifiedOn} by ${data.verifiedBy}`;

const TroubleshootingPage: NextPageWithLayout<PageProps> = ({
  data,
  intro,
  sections: rawSections,
}) => {
  const sections: DocsSection[] = rawSections.map((s) => ({
    id: s.id,
    title: s.title,
    body: <MarkdownBody markdown={s.body} />,
  }));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: data.title,
    datePublished: data.datePublished,
    dateModified: data.dateModified,
    author: { '@type': 'Person', name: data.verifiedBy },
    publisher: { '@type': 'Organization', name: 'Coreframe Labs Ltd' },
    mainEntityOfPage: data.canonical,
    encoding: `${data.canonical}.md`,
  };

  return (
    <DocsPage
      eyebrow="Docs · Troubleshooting"
      title={data.title}
      metaTitle={data.metaTitle}
      metaDescription={data.description}
      canonical={data.canonical}
      lastUpdated={buildLastUpdated(data)}
      jsonLd={jsonLd}
      intro={intro ? <MarkdownBody markdown={intro} /> : undefined}
      sections={sections}
    />
  );
};

export const getStaticPaths: GetStaticPaths = async () => {
  return {
    paths: listSlugs().map((slug) => ({ params: { slug } })),
    fallback: false,
  };
};

export const getStaticProps = async ({
  params,
  locale,
}: GetStaticPropsContext<{ slug: string }>) => {
  const slug = params?.slug as string;
  const { data, content } = getPage(slug);
  const { intro, sections } = splitMarkdownSections(content);

  return {
    props: {
      data,
      intro,
      sections,
      ...(locale ? await serverSideTranslations(locale, ['common']) : {}),
    },
  };
};

TroubleshootingPage.getLayout = docsGetLayout;

export default TroubleshootingPage;
