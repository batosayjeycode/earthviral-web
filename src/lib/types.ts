/**
 * Static data contracts (plan §8). The batch generator writes these files and
 * the Astro build / client islands read them. Zod schemas that validate the
 * build-time files live in `src/content.config.ts`.
 */
import type { CategorySlug, IntensityTier, RegionName } from './taxonomy.ts';

/** `src/data/generated/clusters/[cc]/[date]-[slug].json` — plan §8.2 */
export interface ViralClusterStaticRecord {
  id: string;
  slug: string;
  canonicalPath: string;
  countryCode: string;
  countryName: string;
  countrySlug: string;
  region: RegionName;
  categorySlug: CategorySlug;
  categoryName: string;

  headline: string;
  seoTitle: string;
  metaDescription: string;
  aiSummaryBullets: string[];
  aiContextParagraph: string;
  whyItIsViral: string;

  viralScore: number;
  intensityTier: IntensityTier;
  signalBreakdown: {
    verifiedPublisherCount: number;
    coverageVelocityScore: number;
    publicSearchSignalScore: number;
    confidenceLabel: 'Verified Multi-Source' | 'Emerging Coverage';
  };

  firstDetectedAt: string;
  lastUpdatedBatchAt: string;

  sources: Array<{
    publisherName: string;
    publisherDomain: string;
    articleTitle: string;
    articleUrl: string;
    publishedAt: string;
  }>;

  entityTags: Array<{ name: string; slug: string }>;
  relatedInCountrySlugs: string[];
  relatedInCategorySlugs: string[];
}

/** `src/data/generated/batch-meta.json` */
export interface BatchMeta {
  batchId: string;
  generatedAt: string;
  nextUpdateAt: string;
  /** True when the data came from the local seed script rather than a real AI batch. */
  isSeed: boolean;
  totals: {
    activeCountries: number;
    viralTopics: number;
    globalIndex: number;
  };
  /** Diagnostics from the batch pipeline run (absent for seed data). */
  pipeline?: {
    provider: string;
    feedsOk: number;
    feedsFailed: string[];
    articlesFetched: number;
    newClusters: number;
    updatedClusters: number;
    /** Stories dropped this batch by the per-country cap (now redirected). */
    retiredClusters?: number;
    aiCalls: number;
    /** Failed AI calls by category (rate-limit, schema, timeout…); they fell back to non-AI text. */
    aiFailures?: Record<string, number>;
    /** Up to 5 example failures for diagnosis (no keys or prompts). */
    aiFailureSamples?: Array<{ category: string; detail: string }>;
    durationMs: number;
  };
}

/** One entry of `src/data/generated/countries-master.json` */
export interface CountryMasterRecord {
  id: string; // lowercase alpha-2, e.g. "id"
  code: string; // "ID"
  isoNumeric: string; // "360" — matches Natural Earth / world-atlas feature ids
  name: string;
  slug: string;
  region: RegionName;
  centroid: [lng: number, lat: number];
  viralScore: number;
  intensityTier: IntensityTier;
  topicCount: number;
  topClusterIds: string[];
}

/** One entry of `src/data/generated/categories-master.json` */
export interface CategoryMasterRecord {
  id: CategorySlug;
  name: string;
  shortName: string;
  topicCount: number;
  topClusterIds: string[];
}

/** Compact story reference used by client payloads. */
export interface ClusterSummary {
  slug: string;
  canonicalPath: string;
  headline: string;
  categorySlug: CategorySlug;
  categoryName: string;
  viralScore: number;
  intensityTier: IntensityTier;
}

/** `public/data/map-pulse.json` — loaded by the homepage map island. */
export interface MapPulse {
  batchId: string;
  generatedAt: string;
  nextUpdateAt: string;
  countries: Array<{
    code: string;
    isoNumeric: string;
    name: string;
    slug: string;
    centroid: [number, number];
    viralScore: number;
    intensityTier: IntensityTier;
    topicCount: number;
    topTopic: ClusterSummary | null;
  }>;
}

/** `public/data/countries/[code].json` — loaded on demand by the country drawer (Phase 2). */
export interface CountryPayload {
  code: string;
  name: string;
  slug: string;
  region: RegionName;
  viralScore: number;
  intensityTier: IntensityTier;
  generatedAt: string;
  clusters: Array<
    ClusterSummary & {
      aiSummaryBullets: string[];
      primarySource: { publisherName: string; articleUrl: string } | null;
    }
  >;
}

/**
 * A story removed by the per-country cap. Its URL 301-redirects to the country hub (via the
 * generated Cloudflare `_redirects` file) so search results and shared links never 404.
 */
export interface RetiredStory {
  /** Old canonical path, e.g. "/news/id/some-story/". */
  path: string;
  /** Redirect target, the country hub, e.g. "/country/indonesia/". */
  redirectTo: string;
  retiredAt: string; // ISO-8601
}
