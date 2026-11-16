/**
 * Deployment environments (EarthViral_Staging_Environment_PLAN.md §4–§5).
 *
 * `SITE_ENV` selects the environment at build and batch time:
 *   unset / "production" → https://earthviral.com          (Pages project earthviral-web)
 *   "staging"            → https://staging.earthviral.com  (Pages project earthviral-staging)
 *
 * The URL and Pages project are derived from the environment, never configured freely, so a
 * staging build cannot be pointed at production by a mistyped variable. Plain TypeScript with
 * no Astro/Vite imports: astro.config.mjs, the batch scripts and the tests all use it.
 */
export type SiteEnvironment = 'production' | 'staging';

export const ENVIRONMENTS = {
  production: {
    url: 'https://earthviral.com',
    pagesProject: 'earthviral-web',
    branch: 'main',
  },
  staging: {
    url: 'https://staging.earthviral.com',
    pagesProject: 'earthviral-staging',
    branch: 'staging',
  },
} as const satisfies Record<SiteEnvironment, { url: string; pagesProject: string; branch: string }>;

/** Parse `SITE_ENV`. Unknown values throw instead of silently building production. */
export function resolveSiteEnvironment(raw: string | undefined): SiteEnvironment {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '' || value === 'production') return 'production';
  if (value === 'staging') return 'staging';
  throw new Error(`Unknown SITE_ENV "${raw}" (expected production | staging)`);
}
