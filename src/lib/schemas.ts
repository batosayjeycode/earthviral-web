/**
 * Zod schemas for generated data — the single source of truth used by both
 * `src/content.config.ts` (build-time validation) and the batch pipeline
 * (`scripts/`, validates before writing). Plain-node safe: no `astro:*` imports.
 */
import { z } from 'astro/zod';
import { CATEGORY_SLUGS, INTENSITY_TIERS, REGION_NAMES } from './taxonomy.ts';

const isoDate = z.iso.datetime();
export const tierSchema = z.enum(INTENSITY_TIERS);
export const regionSchema = z.enum(REGION_NAMES);
export const categorySlugSchema = z.enum(CATEGORY_SLUGS);

/** Plan §8.2 — one JSON file per viral cluster. */
export const clusterSchema = z.object({
  id: z.string(),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  canonicalPath: z.string().startsWith('/news/').endsWith('/'),
  countryCode: z.string().length(2),
  countryName: z.string(),
  countrySlug: z.string(),
  region: regionSchema,
  categorySlug: categorySlugSchema,
  categoryName: z.string(),
  headline: z.string().min(1),
  seoTitle: z.string().max(70),
  metaDescription: z.string().max(170),
  aiSummaryBullets: z.array(z.string().min(1)).min(1),
  aiContextParagraph: z.string(),
  whyItIsViral: z.string(),
  viralScore: z.number().int().min(0).max(100),
  intensityTier: tierSchema,
  signalBreakdown: z.object({
    verifiedPublisherCount: z.number().int().min(0),
    coverageVelocityScore: z.number().min(0).max(100),
    publicSearchSignalScore: z.number().min(0).max(100),
    confidenceLabel: z.enum(['Verified Multi-Source', 'Emerging Coverage']),
  }),
  firstDetectedAt: isoDate,
  lastUpdatedBatchAt: isoDate,
  sources: z
    .array(
      z.object({
        publisherName: z.string(),
        publisherDomain: z.string(),
        articleTitle: z.string(),
        articleUrl: z.url(),
        publishedAt: isoDate,
      }),
    )
    .min(1),
  entityTags: z.array(z.object({ name: z.string(), slug: z.string() })),
  relatedInCountrySlugs: z.array(z.string()),
  relatedInCategorySlugs: z.array(z.string()),
});

export const countryMasterSchema = z.object({
  code: z.string().length(2),
  isoNumeric: z.string(),
  name: z.string(),
  slug: z.string(),
  region: regionSchema,
  centroid: z.tuple([z.number(), z.number()]),
  viralScore: z.number().int().min(0).max(100),
  intensityTier: tierSchema,
  topicCount: z.number().int().min(0),
  topClusterIds: z.array(z.string()),
});

export const categoryMasterSchema = z.object({
  name: z.string(),
  shortName: z.string(),
  topicCount: z.number().int().min(0),
  topClusterIds: z.array(z.string()),
});
