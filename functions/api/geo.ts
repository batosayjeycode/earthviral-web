/**
 * GET /api/geo → `{ "country": "US" }` (ISO alpha-2, or null when unknown).
 *
 * Cloudflare Pages Function: the only dynamic route on the site. Pages generates a
 * `_routes.json` that sends just `/api/*` here, so static pages never invoke it. The
 * header's edition button calls it once per visitor (cached in the browser) to swap
 * Indonesia for the visitor's own country when that country has a page.
 *
 * The country comes from Cloudflare's IP geolocation (`request.cf.country`, also sent as
 * the `CF-IPCountry` header). `XX` (unknown) and `T1` (Tor) are reported as null.
 */
interface GeoRequest extends Request {
  cf?: { country?: string };
}

export const onRequestGet = ({ request }: { request: GeoRequest }): Response => {
  const raw = (request.cf?.country ?? request.headers.get('CF-IPCountry') ?? '').toUpperCase();
  const country = /^[A-Z]{2}$/.test(raw) && raw !== 'XX' && raw !== 'T1' ? raw : null;
  return Response.json(
    { country },
    {
      headers: {
        // Per visitor, so never stored by shared caches (CDN, proxies). Not browser-cached
        // either: the header keeps its own one-day copy in localStorage, and an HTTP cache on
        // top would stretch that past a day.
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
      },
    },
  );
};
