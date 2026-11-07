import type { APIRoute } from 'astro';
import { newsWindowStories } from '../lib/routes.ts';
import { SITE, absoluteUrl } from '../lib/site.ts';
import { escapeXml, xmlResponse } from '../lib/xml.ts';

/** Plan §9.4 (3): Google News sitemap — stories first detected in the last 48 hours (max 1,000). */
export const GET: APIRoute = async () => {
  const items = (await newsWindowStories()).slice(0, 1000).map(
    (c) => `  <url>
    <loc>${escapeXml(absoluteUrl(c.canonicalPath))}</loc>
    <news:news>
      <news:publication><news:name>${escapeXml(SITE.name)}</news:name><news:language>${SITE.locale}</news:language></news:publication>
      <news:publication_date>${c.firstDetectedAt}</news:publication_date>
      <news:title>${escapeXml(c.headline)}</news:title>
    </news:news>
  </url>`,
  );
  return xmlResponse(
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${items.join('\n')}\n</urlset>\n`,
  );
};
