import type { APIRoute } from 'astro';
import { batchMeta } from '../lib/data.ts';
import { storiesByMonth } from '../lib/routes.ts';
import { absoluteUrl } from '../lib/site.ts';
import { escapeXml, xmlResponse } from '../lib/xml.ts';

/** Plan §9.4 (1): pointers to every child sitemap, stamped with the current batch time. */
export const GET: APIRoute = async () => {
  const lastmod = batchMeta.generatedAt;
  const children = [
    '/sitemap-core.xml',
    '/sitemap-news.xml',
    ...[...(await storiesByMonth()).keys()].map((m) => `/sitemap-stories-${m}.xml`),
  ];
  const body = children
    .map(
      (path) =>
        `  <sitemap><loc>${escapeXml(absoluteUrl(path))}</loc><lastmod>${lastmod}</lastmod></sitemap>`,
    )
    .join('\n');
  return xmlResponse(
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`,
  );
};
