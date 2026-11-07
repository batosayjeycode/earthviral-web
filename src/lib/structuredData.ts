/**
 * Schema.org JSON-LD builders (plan §9.3). Each page emits one `@graph`:
 *   Homepage      → WebSite (+ SearchAction) · Organization · ItemList (top 10 stories)
 *   Hub pages     → CollectionPage · BreadcrumbList · ItemList
 *   Story pages   → NewsArticle · BreadcrumbList
 */
import type { ViralClusterStaticRecord } from './types.ts';
import { SITE, absoluteUrl } from './site.ts';

const CONTEXT = 'https://schema.org';
const ORG_ID = `${SITE.url}/#organization`;
const WEBSITE_ID = `${SITE.url}/#website`;

export interface BreadcrumbItem {
  name: string;
  /** Omit for the current page (last crumb). */
  path?: string;
}

const organization = () => ({
  '@type': 'Organization',
  '@id': ORG_ID,
  name: SITE.name,
  url: `${SITE.url}/`,
  logo: { '@type': 'ImageObject', url: absoluteUrl('/logo.png'), width: 512, height: 512 },
});

export function breadcrumbList(items: BreadcrumbItem[]) {
  const all: BreadcrumbItem[] = [{ name: 'Home', path: '/' }, ...items];
  return {
    '@type': 'BreadcrumbList',
    itemListElement: all.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      ...(item.path ? { item: absoluteUrl(item.path) } : {}),
    })),
  };
}

function itemList(clusters: ViralClusterStaticRecord[], limit = 10) {
  return {
    '@type': 'ItemList',
    itemListElement: clusters.slice(0, limit).map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: absoluteUrl(c.canonicalPath),
      name: c.headline,
    })),
  };
}

export function homeGraph(topClusters: ViralClusterStaticRecord[]) {
  return {
    '@context': CONTEXT,
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': WEBSITE_ID,
        name: SITE.name,
        url: `${SITE.url}/`,
        description: SITE.tagline,
        inLanguage: SITE.locale,
        publisher: { '@id': ORG_ID },
        potentialAction: {
          '@type': 'SearchAction',
          target: {
            '@type': 'EntryPoint',
            urlTemplate: `${SITE.url}/search/?q={search_term_string}`,
          },
          'query-input': 'required name=search_term_string',
        },
      },
      organization(),
      { ...itemList(topClusters), name: 'Top global viral topics' },
    ],
  };
}

export function collectionGraph(opts: {
  path: string;
  name: string;
  description: string;
  breadcrumbs: BreadcrumbItem[];
  clusters: ViralClusterStaticRecord[];
}) {
  return {
    '@context': CONTEXT,
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${absoluteUrl(opts.path)}#page`,
        url: absoluteUrl(opts.path),
        name: opts.name,
        description: opts.description,
        inLanguage: SITE.locale,
        isPartOf: { '@id': WEBSITE_ID },
        publisher: { '@id': ORG_ID },
      },
      breadcrumbList(opts.breadcrumbs),
      itemList(opts.clusters),
    ],
  };
}

export function newsArticleGraph(c: ViralClusterStaticRecord, breadcrumbs: BreadcrumbItem[]) {
  const url = absoluteUrl(c.canonicalPath);
  return {
    '@context': CONTEXT,
    '@graph': [
      {
        '@type': 'NewsArticle',
        '@id': `${url}#article`,
        // Google truncates headline beyond 110 characters.
        headline: c.headline.slice(0, 110),
        description: c.metaDescription,
        image: [absoluteUrl(`/og/${c.id}.png`)],
        datePublished: c.firstDetectedAt,
        dateModified: c.lastUpdatedBatchAt,
        inLanguage: SITE.locale,
        articleSection: c.categoryName,
        keywords: c.entityTags.map((t) => t.name).join(', ') || undefined,
        author: { '@type': 'Organization', name: SITE.desk, url: absoluteUrl('/about/') },
        publisher: organization(),
        contentLocation: { '@type': 'Country', name: c.countryName },
        isBasedOn: c.sources.map((s) => s.articleUrl),
        mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      },
      breadcrumbList(breadcrumbs),
    ],
  };
}

/** Serialise for a <script type="application/ld+json"> — escapes `<` so content can't close the tag. */
export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
