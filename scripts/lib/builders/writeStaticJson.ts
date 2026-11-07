/**
 * Static JSON writer (plan §8.1, §10 `writeStaticJson.ts`) — shared by the AI batch and
 * the seed script so both emit identical shapes.
 *
 * Everything is computed and schema-validated in memory first; only then are the
 * generated directories replaced, so a failed run never leaves half-written data.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, tierForScore } from '../../../src/lib/taxonomy.ts';
import { VAS } from '../../../src/lib/scoring.ts';
import {
  categoryMasterSchema,
  clusterSchema,
  countryMasterSchema,
} from '../../../src/lib/schemas.ts';
import type {
  BatchMeta,
  CategoryMasterRecord,
  ClusterSummary,
  CountryMasterRecord,
  CountryPayload,
  MapPulse,
  RetiredStory,
  ViralClusterStaticRecord,
} from '../../../src/lib/types.ts';
import { COUNTRY_BY_CODE } from '../countries.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const GENERATED_DIR = join(ROOT, 'src', 'data', 'generated');
export const CLUSTERS_DIR = join(GENERATED_DIR, 'clusters');
export const PUBLIC_DATA_DIR = join(ROOT, 'public', 'data');
const RETIRED_FILE = join(GENERATED_DIR, 'retired-stories.json');
/** Generated Cloudflare Pages redirects (sits beside the hand-written public/_headers). */
const REDIRECTS_FILE = join(ROOT, 'public', '_redirects');
/** Cloudflare Pages allows 2,000 static redirect rules; keep headroom. */
const MAX_REDIRECTS = 1_900;

/** Clusters drop off the live map / country scores after this long without new coverage. */
export const ACTIVE_WINDOW_HOURS = VAS.activeWindowHours;
/** Clusters are removed from the data set after this long without new coverage. */
export const RETENTION_DAYS = VAS.retentionDays;

const HOUR = 3_600_000;
export const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Next scheduled batch strictly after `from`: 3-hour WIB slots plus the cron minute
 * (00:17, 03:17, … WIB with VAS.batchCronMinute = 17).
 */
export function nextScheduledBatch(from: Date, minute: number = VAS.batchCronMinute): Date {
  const offset = minute * 60_000;
  return new Date(nextWibBoundary(new Date(from.getTime() - offset)).getTime() + offset);
}

/** Next 3-hour boundary on the WIB clock (00:00, 03:00, … WIB) strictly after `from`. */
export function nextWibBoundary(from: Date): Date {
  const period = 3 * HOUR;
  const offset = 1 * HOUR; // WIB = UTC+7 → boundaries at UTC hours ≡ 2 (mod 3); (7 mod 3) = 1
  return new Date(Math.floor((from.getTime() + offset) / period) * period - offset + period);
}

export function isActive(c: ViralClusterStaticRecord, at: Date): boolean {
  return at.getTime() - Date.parse(c.lastUpdatedBatchAt) <= ACTIVE_WINDOW_HOURS * HOUR;
}

function toSummary(c: ViralClusterStaticRecord): ClusterSummary {
  return {
    slug: c.slug,
    canonicalPath: c.canonicalPath,
    headline: c.headline,
    categorySlug: c.categorySlug,
    categoryName: c.categoryName,
    viralScore: c.viralScore,
    intensityTier: c.intensityTier,
  };
}

export function clusterFileName(c: ViralClusterStaticRecord): string {
  return join(c.countryCode.toLowerCase(), `${c.firstDetectedAt.slice(0, 10)}-${c.slug}.json`);
}

/** Load every cluster record written by previous batches. */
export async function loadExistingClusters(): Promise<ViralClusterStaticRecord[]> {
  const out: ViralClusterStaticRecord[] = [];
  let countryDirs: string[];
  try {
    countryDirs = await readdir(CLUSTERS_DIR);
  } catch {
    return out;
  }
  for (const dir of countryDirs) {
    let files: string[];
    try {
      files = await readdir(join(CLUSTERS_DIR, dir));
    } catch {
      continue;
    }
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const parsed = clusterSchema.safeParse(
        JSON.parse(await readFile(join(CLUSTERS_DIR, dir, f), 'utf8')),
      );
      if (parsed.success) out.push(parsed.data as ViralClusterStaticRecord);
      else console.warn(`  ! skipping invalid cluster file ${dir}/${f}`);
    }
  }
  return out;
}

/** Stories retired by earlier batches (their redirects are carried forward). */
export async function loadRetiredStories(): Promise<RetiredStory[]> {
  try {
    return JSON.parse(await readFile(RETIRED_FILE, 'utf8')) as RetiredStory[];
  } catch {
    return [];
  }
}

/**
 * Merge retirements, drop expired ones and any path that is a live story again, newest
 * first, capped to Cloudflare's rule limit.
 */
export function mergeRetired(
  previous: RetiredStory[],
  added: RetiredStory[],
  livePaths: Set<string>,
  at: Date,
): RetiredStory[] {
  const cutoff = at.getTime() - VAS.redirectRetentionDays * 24 * HOUR;
  const byPath = new Map<string, RetiredStory>();
  for (const r of [...previous, ...added]) byPath.set(r.path, r); // later entry wins
  return [...byPath.values()]
    .filter((r) => !livePaths.has(r.path) && Date.parse(r.retiredAt) >= cutoff)
    .sort((a, b) => Date.parse(b.retiredAt) - Date.parse(a.retiredAt))
    .slice(0, MAX_REDIRECTS);
}

export function redirectsFile(retired: RetiredStory[]): string {
  const lines = retired.map((r) => `${r.path} ${r.redirectTo} 301`);
  return [
    '# Generated by the batch pipeline (scripts/lib/builders/writeStaticJson.ts) — do not edit.',
    '# Stories removed by the per-country cap redirect to their country page.',
    ...lines,
    '',
  ].join('\n');
}

export async function loadBatchMeta(): Promise<BatchMeta | null> {
  try {
    return JSON.parse(await readFile(join(GENERATED_DIR, 'batch-meta.json'), 'utf8')) as BatchMeta;
  } catch {
    return null;
  }
}

export interface WriteInput {
  clusters: ViralClusterStaticRecord[];
  batchId: string;
  generatedAt: Date;
  nextUpdateAt: Date;
  isSeed: boolean;
  pipeline?: BatchMeta['pipeline'];
  /** Full, already-merged list of retired stories to publish as redirects. */
  retired?: RetiredStory[];
}

export interface WriteResult {
  batchMeta: BatchMeta;
  countries: CountryMasterRecord[];
  clusterCount: number;
}

export async function writeStaticJson(
  input: WriteInput,
  { dryRun = false } = {},
): Promise<WriteResult> {
  const at = input.generatedAt;
  const clusters = [...input.clusters].sort((a, b) => b.viralScore - a.viralScore);
  const active = clusters.filter((c) => isActive(c, at));

  // ── Countries: every country with a cluster in the window; scores from active ones ──
  const codes = [...new Set(clusters.map((c) => c.countryCode))];
  const countries: CountryMasterRecord[] = codes
    .map((code) => {
      const meta = COUNTRY_BY_CODE.get(code);
      if (!meta) throw new Error(`Cluster references untracked country ${code}`);
      const own = active.filter((c) => c.countryCode === code);
      const top = own[0]?.viralScore ?? 0;
      const breadthBonus = Math.min(3, Math.round(Math.max(0, own.length - 1) * 0.5));
      const score = Math.min(100, top + breadthBonus);
      return {
        id: code.toLowerCase(),
        code,
        isoNumeric: meta.isoNumeric,
        name: meta.name,
        slug: meta.slug,
        region: meta.region,
        centroid: meta.centroid,
        viralScore: score,
        intensityTier: tierForScore(score),
        topicCount: own.length,
        topClusterIds: clusters
          .filter((c) => c.countryCode === code)
          .slice(0, 5)
          .map((c) => c.id),
      };
    })
    .sort((a, b) => b.viralScore - a.viralScore);

  const categories: CategoryMasterRecord[] = CATEGORIES.map((cat) => {
    const own = clusters.filter((c) => c.categorySlug === cat.slug);
    return {
      id: cat.slug,
      name: cat.name,
      shortName: cat.shortName,
      topicCount: own.filter((c) => isActive(c, at)).length,
      topClusterIds: own.slice(0, 6).map((c) => c.id),
    };
  });

  const liveCountries = countries.filter((c) => c.intensityTier !== 'quiet');
  const top10 = countries.slice(0, 10);
  const batchMeta: BatchMeta = {
    batchId: input.batchId,
    generatedAt: iso(at),
    nextUpdateAt: iso(input.nextUpdateAt),
    isSeed: input.isSeed,
    totals: {
      activeCountries: liveCountries.length,
      viralTopics: active.length,
      globalIndex: Math.round(
        top10.reduce((s, c) => s + c.viralScore, 0) / Math.max(1, top10.length),
      ),
    },
    ...(input.pipeline ? { pipeline: input.pipeline } : {}),
  };

  const mapPulse: MapPulse = {
    batchId: batchMeta.batchId,
    generatedAt: batchMeta.generatedAt,
    nextUpdateAt: batchMeta.nextUpdateAt,
    countries: countries.map((c) => {
      const top = active.find((cl) => cl.countryCode === c.code);
      return {
        code: c.code,
        isoNumeric: c.isoNumeric,
        name: c.name,
        slug: c.slug,
        centroid: c.centroid,
        viralScore: c.viralScore,
        intensityTier: c.intensityTier,
        topicCount: c.topicCount,
        topTopic: top ? toSummary(top) : null,
      };
    }),
  };

  const countryPayloads: CountryPayload[] = countries.map((c) => ({
    code: c.code,
    name: c.name,
    slug: c.slug,
    region: c.region,
    viralScore: c.viralScore,
    intensityTier: c.intensityTier,
    generatedAt: batchMeta.generatedAt,
    // Active stories first, then recently cooled ones, capped to keep the payload small.
    clusters: [...active, ...clusters.filter((cl) => !isActive(cl, at))]
      .filter((cl) => cl.countryCode === c.code)
      .slice(0, 20)
      .map((cl) => ({
        ...toSummary(cl),
        aiSummaryBullets: cl.aiSummaryBullets.slice(0, 2),
        primarySource: cl.sources[0]
          ? { publisherName: cl.sources[0].publisherName, articleUrl: cl.sources[0].articleUrl }
          : null,
      })),
  }));

  const globalTrending = {
    batchId: batchMeta.batchId,
    generatedAt: batchMeta.generatedAt,
    clusters: active
      .slice(0, 30)
      .map((c) => ({ ...toSummary(c), countryCode: c.countryCode, countryName: c.countryName })),
  };

  // ── Validate everything before touching disk ──────────────────────────────
  const slugs = new Set<string>();
  for (const c of clusters) {
    clusterSchema.parse(c);
    if (slugs.has(c.slug)) throw new Error(`Duplicate cluster slug "${c.slug}"`);
    slugs.add(c.slug);
  }
  countries.forEach(({ id: _id, ...c }) => countryMasterSchema.parse(c));
  categories.forEach(({ id: _id, ...c }) => categoryMasterSchema.parse(c));

  if (!dryRun) {
    await rm(GENERATED_DIR, { recursive: true, force: true });
    await rm(PUBLIC_DATA_DIR, { recursive: true, force: true });
    const writeJson = async (path: string, data: unknown) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
    };
    await writeJson(join(GENERATED_DIR, 'batch-meta.json'), batchMeta);
    const retired = input.retired ?? [];
    await writeJson(RETIRED_FILE, retired);
    await writeFile(REDIRECTS_FILE, redirectsFile(retired));
    await writeJson(join(GENERATED_DIR, 'countries-master.json'), countries);
    await writeJson(join(GENERATED_DIR, 'categories-master.json'), categories);
    for (const c of clusters) await writeJson(join(CLUSTERS_DIR, clusterFileName(c)), c);
    await writeJson(join(PUBLIC_DATA_DIR, 'map-pulse.json'), mapPulse);
    await writeJson(join(PUBLIC_DATA_DIR, 'global-trending.json'), globalTrending);
    for (const p of countryPayloads)
      await writeJson(join(PUBLIC_DATA_DIR, 'countries', `${p.code.toLowerCase()}.json`), p);
  }

  return { batchMeta, countries, clusterCount: clusters.length };
}
