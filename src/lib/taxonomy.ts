/**
 * Canonical taxonomy shared by the Astro site and the batch generator scripts.
 * Keep this file dependency-free so it runs under plain `node` (type stripping).
 */

export const CATEGORIES = [
  { slug: 'politics-government', name: 'Politics & Government', shortName: 'Politics' },
  { slug: 'crime-law', name: 'Crime & Law', shortName: 'Crime & Law' },
  { slug: 'economy-business', name: 'Economy & Business', shortName: 'Economy' },
  { slug: 'technology-ai', name: 'Technology & AI', shortName: 'Tech & AI' },
  { slug: 'sports', name: 'Sports', shortName: 'Sports' },
  {
    slug: 'entertainment-celebrity',
    name: 'Entertainment & Celebrity',
    shortName: 'Entertainment',
  },
  { slug: 'social-issues', name: 'Social Issues', shortName: 'Social' },
  { slug: 'disasters-world-events', name: 'Disasters & World Events', shortName: 'World Events' },
  { slug: 'lifestyle-culture', name: 'Lifestyle & Culture', shortName: 'Lifestyle' },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]['slug'];
export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug) as [CategorySlug, ...CategorySlug[]];

export const REGIONS = [
  { slug: 'asia', name: 'Asia' },
  { slug: 'europe', name: 'Europe' },
  { slug: 'north-america', name: 'North America' },
  { slug: 'south-america', name: 'South America' },
  { slug: 'africa', name: 'Africa' },
  { slug: 'oceania', name: 'Oceania' },
] as const;

export type RegionName = (typeof REGIONS)[number]['name'];
export const REGION_NAMES = REGIONS.map((r) => r.name) as [RegionName, ...RegionName[]];

export const INTENSITY_TIERS = ['quiet', 'active', 'high', 'surge'] as const;
export type IntensityTier = (typeof INTENSITY_TIERS)[number];

export const TIER_META: Record<IntensityTier, { label: string; range: string; min: number }> = {
  quiet: { label: 'Quiet', range: '0–24', min: 0 },
  active: { label: 'Active', range: '25–59', min: 25 },
  high: { label: 'High', range: '60–84', min: 60 },
  surge: { label: 'Viral Surge', range: '85–100', min: 85 },
};

/** Plan §5.2 tier thresholds. */
export function tierForScore(score: number): IntensityTier {
  if (score >= 85) return 'surge';
  if (score >= 60) return 'high';
  if (score >= 25) return 'active';
  return 'quiet';
}

export function categoryBySlug(slug: string) {
  return CATEGORIES.find((c) => c.slug === slug);
}

export function regionSlug(name: RegionName): string {
  return REGIONS.find((r) => r.name === name)!.slug;
}

/** ISO 3166-1 alpha-2 → flag emoji (regional indicator symbols). */
export function flagEmoji(alpha2: string): string {
  return String.fromCodePoint(...[...alpha2.toUpperCase()].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));
}
