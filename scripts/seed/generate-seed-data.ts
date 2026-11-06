/**
 * Writes SAMPLE static data through the same writer as the real batch
 * (`scripts/lib/builders/writeStaticJson.ts`), so the UI can be developed offline.
 *
 *   npm run seed            # batch timestamp = latest 3-hour WIB boundary
 *   npm run seed -- --at 2026-11-06T00:00:00+07:00
 *
 * The batch is marked `isSeed: true`: every page shows a "Sample data" badge and is
 * `noindex`, and the next real `npm run update:viral` discards these clusters.
 */
import { categoryBySlug, tierForScore } from '../../src/lib/taxonomy.ts';
import type { ViralClusterStaticRecord } from '../../src/lib/types.ts';
import { COUNTRY_BY_CODE } from '../lib/countries.ts';
import { buildInternalLinks } from '../lib/intelligence/buildInternalLinks.ts';
import { slugify, truncate } from '../lib/intelligence/text.ts';
import { iso, writeStaticJson } from '../lib/builders/writeStaticJson.ts';
import { PUBLISHERS, SEED_STORIES } from './seed-stories.ts';

const HOUR = 3_600_000;

/** Latest 3-hour boundary on the WIB clock (00:00, 03:00, … WIB). */
function latestBatchBoundary(now: Date): Date {
  const period = 3 * HOUR;
  const offset = 1 * HOUR; // WIB = UTC+7; (7 mod 3) = 1
  return new Date(Math.floor((now.getTime() + offset) / period) * period - offset);
}

function parseAtArg(): Date {
  const i = process.argv.indexOf('--at');
  if (i === -1) return latestBatchBoundary(new Date());
  const value = process.argv[i + 1];
  const at = value ? new Date(value) : new Date(NaN);
  if (Number.isNaN(at.getTime())) throw new Error(`Invalid --at value: ${value}`);
  return at;
}

async function main() {
  const batchAt = parseAtArg();

  const clusters: ViralClusterStaticRecord[] = SEED_STORIES.map((s) => {
    const country = COUNTRY_BY_CODE.get(s.country);
    if (!country) throw new Error(`Unknown seed country ${s.country}`);
    const category = categoryBySlug(s.category)!;
    const detectedAt = new Date(batchAt.getTime() - s.hoursAgo * HOUR);
    const cc = country.code.toLowerCase();

    return {
      id: `${cc}-${iso(detectedAt).slice(0, 10).replaceAll('-', '')}-${s.slug}`,
      slug: s.slug,
      canonicalPath: `/news/${cc}/${s.slug}/`,
      countryCode: country.code,
      countryName: country.name,
      countrySlug: country.slug,
      region: country.region,
      categorySlug: category.slug,
      categoryName: category.name,
      headline: s.headline,
      seoTitle: truncate(s.headline, 60),
      metaDescription: truncate(`${s.whyItIsViral} ${s.bullets[0]}`, 158),
      aiSummaryBullets: [...s.bullets],
      aiContextParagraph: s.context,
      whyItIsViral: s.whyItIsViral,
      viralScore: s.score,
      intensityTier: tierForScore(s.score),
      signalBreakdown: {
        verifiedPublisherCount: s.publishers.length,
        coverageVelocityScore: s.velocity,
        publicSearchSignalScore: s.search,
        confidenceLabel: s.publishers.length >= 3 ? 'Verified Multi-Source' : 'Emerging Coverage',
      },
      firstDetectedAt: iso(detectedAt),
      lastUpdatedBatchAt: iso(batchAt),
      sources: s.publishers.map((name, i) => {
        const domain = PUBLISHERS[name];
        if (!domain) throw new Error(`Unknown publisher ${name}`);
        return {
          publisherName: name,
          publisherDomain: domain,
          articleTitle: `[Sample] ${name} coverage: ${s.headline}`,
          articleUrl: `https://${domain}/`,
          publishedAt: iso(new Date(detectedAt.getTime() + i * 0.5 * HOUR)),
        };
      }),
      entityTags: s.tags.map((name) => ({ name, slug: slugify(name, 6) })),
      relatedInCountrySlugs: [],
      relatedInCategorySlugs: [],
    };
  });

  buildInternalLinks(clusters, batchAt);
  const { batchMeta, countries } = await writeStaticJson({
    clusters,
    batchId: `seed-${iso(batchAt).slice(0, 13).replace(/[-T]/g, '')}`,
    generatedAt: batchAt,
    nextUpdateAt: new Date(batchAt.getTime() + 3 * HOUR),
    isSeed: true,
  });

  console.log(
    `Seeded SAMPLE batch ${batchMeta.batchId}: ${clusters.length} clusters, ${countries.length} countries ` +
      `(${batchMeta.totals.activeCountries} active), global index ${batchMeta.totals.globalIndex}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
