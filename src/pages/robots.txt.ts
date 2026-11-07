import type { APIRoute } from 'astro';
import { batchMeta } from '../lib/data.ts';
import { absoluteUrl } from '../lib/site.ts';

/** Seed (sample) builds are blocked entirely; real builds allow everything and list the sitemap. */
export const GET: APIRoute = () => {
  const body = batchMeta.isSeed
    ? '# Sample data build — not for indexing\nUser-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl('/sitemap-index.xml')}\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
