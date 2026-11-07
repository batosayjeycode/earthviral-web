import type { APIRoute } from 'astro';
import { batchMeta, getClusters } from '../lib/data.ts';
import { SITE, absoluteUrl } from '../lib/site.ts';
import { escapeXml, xmlResponse } from '../lib/xml.ts';

/** Latest 50 stories by last update (plan §10 `rss.xml.ts`). */
export const GET: APIRoute = async () => {
  const latest = [...(await getClusters())]
    .sort(
      (a, b) =>
        Date.parse(b.lastUpdatedBatchAt) - Date.parse(a.lastUpdatedBatchAt) ||
        b.viralScore - a.viralScore,
    )
    .slice(0, 50);
  const items = latest
    .map(
      (c) => `    <item>
      <title>${escapeXml(c.headline)}</title>
      <link>${escapeXml(absoluteUrl(c.canonicalPath))}</link>
      <guid isPermaLink="true">${escapeXml(absoluteUrl(c.canonicalPath))}</guid>
      <description>${escapeXml(c.metaDescription)}</description>
      <category>${escapeXml(c.categoryName)}</category>
      <pubDate>${new Date(c.firstDetectedAt).toUTCString()}</pubDate>
    </item>`,
    )
    .join('\n');
  return xmlResponse(
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(SITE.name)} — latest viral stories</title>
    <link>${SITE.url}/</link>
    <atom:link href="${absoluteUrl('/rss.xml')}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(SITE.tagline)}</description>
    <language>${SITE.locale}</language>
    <lastBuildDate>${new Date(batchMeta.generatedAt).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`,
    'application/rss+xml; charset=utf-8',
  );
};
