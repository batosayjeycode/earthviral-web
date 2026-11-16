/**
 * Site-wide configuration. Deployment-specific values come from build-time environment
 * variables (GitHub Actions variables/secrets used by ci.yml, or `.env` locally):
 *
 *   PUBLIC_ADSENSE_CLIENT     "ca-pub-1234567890123456"  — enables ad slots + ads.txt
 *   PUBLIC_ADSENSE_SLOT_STORY  ad unit id for story pages
 *   PUBLIC_ADSENSE_SLOT_HUB    ad unit id for hub pages
 *   PUBLIC_CONTACT_EMAIL      address shown on /contact/ and the legal pages
 *   INDEXNOW_KEY              8–128 hex chars; publishes /{key}.txt for IndexNow
 *   SITE_ENV                  "staging" for the staging site; unset = production
 *
 * Anything unset is simply left out of the build (no empty ad boxes, no fake addresses).
 */
import { ENVIRONMENTS, resolveSiteEnvironment } from './environment.ts';

const env = import.meta.env;

const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * SITE_ENV=staging builds the protected staging site (staging.earthviral.com): every page
 * noindex, a visible STAGING banner, robots.txt disallows everything, and no ads or
 * IndexNow key — whatever the other variables say. See src/lib/environment.ts.
 */
const environment = resolveSiteEnvironment(env.SITE_ENV);
const isStaging = environment === 'staging';

export const SITE = {
  name: 'EarthViral',
  environment,
  isStaging,
  url: ENVIRONMENTS[environment].url,
  tagline: 'Global viral news intelligence, refreshed every 3 hours',
  /** Author entity used in NewsArticle structured data (plan §9.3). */
  desk: 'EarthViral Intelligence Desk',
  locale: 'en',
  contactEmail: clean(env.PUBLIC_CONTACT_EMAIL),
  adsense: {
    client: isStaging ? null : clean(env.PUBLIC_ADSENSE_CLIENT),
    slots: { story: clean(env.PUBLIC_ADSENSE_SLOT_STORY), hub: clean(env.PUBLIC_ADSENSE_SLOT_HUB) },
  },
  indexNowKey: isStaging ? null : clean(env.INDEXNOW_KEY),
} as const;

export const absoluteUrl = (path: string) => new URL(path, SITE.url).href;
