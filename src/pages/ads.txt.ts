import type { APIRoute } from 'astro';
import { SITE } from '../lib/site.ts';

/**
 * IAB ads.txt. With PUBLIC_ADSENSE_CLIENT set ("ca-pub-…"), authorises Google as a direct
 * seller; otherwise publishes an explicit "no authorised sellers" placeholder.
 */
export const GET: APIRoute = () => {
  const pub = SITE.adsense.client?.replace(/^ca-/, '');
  const body = pub
    ? `google.com, ${pub}, DIRECT, f08c47fec0942fa0\n`
    : '# No advertising sellers are authorised for this site yet.\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
