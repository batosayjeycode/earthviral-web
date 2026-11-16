import type { APIRoute } from 'astro';
import { batchMeta } from '../lib/data.ts';
import { SITE, absoluteUrl } from '../lib/site.ts';

/**
 * Seed (sample) and staging builds are blocked entirely and list no sitemap; production
 * builds allow everything and list the sitemap. Staging privacy relies on Cloudflare Access,
 * not on this file.
 */
export const GET: APIRoute = () => {
  const body = SITE.isStaging
    ? '# Staging environment — not for indexing\nUser-agent: *\nDisallow: /\n'
    : batchMeta.isSeed
      ? '# Sample data build — not for indexing\nUser-agent: *\nDisallow: /\n'
      : `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl('/sitemap-index.xml')}\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
