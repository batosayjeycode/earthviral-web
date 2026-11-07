import { absoluteUrl } from './site.ts';
import type { SitemapEntry } from './routes.ts';

export const escapeXml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );

export function xmlResponse(
  body: string,
  contentType = 'application/xml; charset=utf-8',
): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    headers: { 'Content-Type': contentType },
  });
}

export function urlset(entries: SitemapEntry[]): string {
  const urls = entries
    .map(
      (e) =>
        `  <url><loc>${escapeXml(absoluteUrl(e.path))}</loc><lastmod>${e.lastmod}</lastmod>` +
        `${e.changefreq ? `<changefreq>${e.changefreq}</changefreq>` : ''}` +
        `${e.priority !== undefined ? `<priority>${e.priority.toFixed(1)}</priority>` : ''}</url>`,
    )
    .join('\n');
  return `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
