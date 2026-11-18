/**
 * Site-wide configuration. Deployment-specific values come from build-time environment
 * variables (GitHub Actions variables/secrets used by ci.yml, or `.env` locally):
 *
 *   PUBLIC_ADSENSE_CLIENT     "ca-pub-1234567890123456"  — enables ad slots + ads.txt
 *   PUBLIC_ADSENSE_SLOT_STORY  ad unit id for story pages
 *   PUBLIC_ADSENSE_SLOT_HUB    ad unit id for hub pages
 *   PUBLIC_CONTACT_EMAIL      address shown on /contact/ and the legal pages
 *   INDEXNOW_KEY              8–128 hex chars; publishes /{key}.txt for IndexNow
 *
 * Anything unset is simply left out of the build (no empty ad boxes, no fake addresses).
 */
const env = import.meta.env;

const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export const SITE = {
  name: 'EarthViral',
  url: 'https://earthviral.com',
  tagline: 'Global viral news intelligence, refreshed every 3 hours',
  /** Author entity used in NewsArticle structured data (plan §9.3). */
  desk: 'EarthViral Intelligence Desk',
  locale: 'en',
  contactEmail: clean(env.PUBLIC_CONTACT_EMAIL),
  adsense: {
    client: clean(env.PUBLIC_ADSENSE_CLIENT),
    slots: { story: clean(env.PUBLIC_ADSENSE_SLOT_STORY), hub: clean(env.PUBLIC_ADSENSE_SLOT_HUB) },
  },
  indexNowKey: clean(env.INDEXNOW_KEY),
} as const;

export const absoluteUrl = (path: string) => new URL(path, SITE.url).href;

/** Longest `<title>` kept whole in search results (Google cuts at ~600 px, roughly 60–70 chars). */
export const MAX_TITLE = 70;

/**
 * `<title>` from candidate wordings, longest first: the first that fits within MAX_TITLE with
 * " | EarthViral" appended, else the shortest without the brand (Google shows the site name
 * next to results anyway). Keeps titles from being cut off mid-phrase.
 */
export function pageTitle(...variants: string[]): string {
  const brand = ` | ${SITE.name}`;
  const fit = variants.find((v) => v.length + brand.length <= MAX_TITLE);
  if (fit) return fit + brand;
  return variants.reduce((a, b) => (b.length < a.length ? b : a));
}
