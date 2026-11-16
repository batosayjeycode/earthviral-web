/**
 * One-off migration: bring back stories the old per-country cap removed.
 *
 *   npm run restore:retired               # restore + rewrite generated data
 *   npm run restore:retired -- --dry-run  # report only
 *
 * Until Nov 2026 each country kept only its top 10 stories, so most story URLs were
 * 301-redirected to their country page within days of being indexed. This script finds each
 * redirected story's last committed JSON in git history and restores it as a live page,
 * provided it is still inside the retention window and its slug is free. It also replaces
 * stored "why it is viral" sentences that quote score figures (they go stale every batch).
 *
 * The batch pipeline commits new data every 3 hours, so run this on top of the latest
 * data right before merging (re-running is safe: already-live stories are skipped).
 * Scores of restored stories are refreshed by the next scheduled batch.
 */
import { execFileSync } from 'node:child_process';
import { VAS } from '../src/lib/scoring.ts';
import { clusterSchema } from '../src/lib/schemas.ts';
import type { RetiredStory, ViralClusterStaticRecord } from '../src/lib/types.ts';
import { describeAttention, hasScoreClaim } from './lib/intelligence/generateAiSummaries.ts';
import { buildInternalLinks } from './lib/intelligence/buildInternalLinks.ts';
import { retireOldest } from './lib/intelligence/selectStories.ts';
import {
  RETENTION_DAYS,
  ROOT,
  loadBatchMeta,
  loadExistingClusters,
  loadRetiredStories,
  writeStaticJson,
} from './lib/builders/writeStaticJson.ts';

const dryRun = process.argv.includes('--dry-run');
const CLUSTERS_GIT_PATH = 'src/data/generated/clusters';
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Latest committed version of every cluster file that was ever deleted, by canonical path. */
function deletedClusterVersions(): Map<string, ViralClusterStaticRecord> {
  // Newest commits first, so the first version seen for a path is its last one.
  const log = git('log', '--diff-filter=D', '--format=@%H', '--name-only', '--', CLUSTERS_GIT_PATH);
  const byPath = new Map<string, ViralClusterStaticRecord>();
  let commit = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) {
      commit = line.slice(1);
      continue;
    }
    if (!line.endsWith('.json')) continue;
    let raw: string;
    try {
      raw = git('show', `${commit}^:${line}`);
    } catch {
      continue;
    }
    const parsed = clusterSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) continue;
    const record = parsed.data as ViralClusterStaticRecord;
    if (!byPath.has(record.canonicalPath)) byPath.set(record.canonicalPath, record);
  }
  return byPath;
}

/** Replace a "why it is viral" sentence that quotes score figures. Returns true if changed. */
function fixScoreClaim(c: ViralClusterStaticRecord): boolean {
  if (!hasScoreClaim(c.whyItIsViral)) return false;
  c.whyItIsViral = describeAttention({
    countryName: c.countryName,
    // Velocity and trend matches are point-in-time, so leave them out of a stored sentence.
    metrics: {
      publishers: c.signalBreakdown.verifiedPublisherCount,
      velocity: 0,
      search: 0,
      viralScore: c.viralScore,
      trendKeyword: null,
    },
  });
  return true;
}

async function main() {
  const meta = await loadBatchMeta();
  if (!meta || meta.isSeed) throw new Error('No real batch data to migrate.');
  const at = new Date(meta.generatedAt);
  const existing = await loadExistingClusters();
  const retired = await loadRetiredStories();

  const retentionCutoff = at.getTime() - RETENTION_DAYS * 24 * 3_600_000;
  const history = deletedClusterVersions();

  // The same event was often re-created after its first page was removed ("…-2" slugs) or
  // filed under two countries. Restoring both would publish duplicate content, so a
  // duplicate stays retired and redirects to the story that covers the event instead.
  const baseSlug = (slug: string) => slug.replace(/-\d+$/, '');
  const titleKey = (c: ViralClusterStaticRecord) => c.seoTitle.trim().toLowerCase();
  const liveSlugs = new Set(existing.map((c) => c.slug));
  const byBaseSlug = new Map(existing.map((c) => [baseSlug(c.slug), c.canonicalPath]));
  const byTitle = new Map(existing.map((c) => [titleKey(c), c.canonicalPath]));
  const duplicateOf = new Map<string, string>(); // retired path → live duplicate's path

  const restored: ViralClusterStaticRecord[] = [];
  const skipped = { notInHistory: 0, expired: 0, slugTaken: 0, duplicate: 0 };
  const candidates = retired
    .map((r) => history.get(r.path))
    .filter((c): c is ViralClusterStaticRecord => {
      if (!c) skipped.notInHistory++;
      return Boolean(c);
    })
    // Newest coverage first, so the most up-to-date version of a duplicated event wins.
    .sort((a, b) => Date.parse(b.lastUpdatedBatchAt) - Date.parse(a.lastUpdatedBatchAt));
  for (const record of candidates) {
    const dup = byBaseSlug.get(baseSlug(record.slug)) ?? byTitle.get(titleKey(record));
    if (Date.parse(record.lastUpdatedBatchAt) < retentionCutoff) skipped.expired++;
    else if (dup) {
      skipped.duplicate++;
      duplicateOf.set(record.canonicalPath, dup);
    } else if (liveSlugs.has(record.slug)) skipped.slugTaken++;
    else {
      restored.push(record);
      liveSlugs.add(record.slug);
      byBaseSlug.set(baseSlug(record.slug), record.canonicalPath);
      byTitle.set(titleKey(record), record.canonicalPath);
    }
  }

  const { kept: clusters, dropped } = retireOldest(
    [...existing, ...restored].map((c) => ({ c, lastUpdatedAt: c.lastUpdatedBatchAt })),
    VAS.maxStoredStories > 0 ? VAS.maxStoredStories : Infinity,
  );
  const all = clusters.map((x) => x.c);
  const scoreFixes = all.filter(fixScoreClaim).length;

  const livePaths = new Set(all.map((c) => c.canonicalPath));
  const stillRetired: RetiredStory[] = [
    ...retired
      .filter((r) => !livePaths.has(r.path))
      .map((r) => {
        const target = duplicateOf.get(r.path);
        return target && livePaths.has(target) ? { ...r, redirectTo: target } : r;
      }),
    ...dropped
      .filter((x) => existing.includes(x.c))
      .map((x) => ({
        path: x.c.canonicalPath,
        redirectTo: `/country/${x.c.countrySlug}/`,
        retiredAt: meta.generatedAt,
      })),
  ];

  console.log(
    `Batch ${meta.batchId}: ${existing.length} live stories, ${retired.length} redirects`,
  );
  console.log(
    `  restored ${restored.length - dropped.filter((x) => !existing.includes(x.c)).length} stories` +
      ` (skipped: ${skipped.notInHistory} not in git history, ${skipped.expired} past ${RETENTION_DAYS}-day retention, ${skipped.slugTaken} slug taken, ${skipped.duplicate} duplicates of a live story → redirected to it)`,
  );
  console.log(`  replaced ${scoreFixes} "why it is viral" sentences that quoted scores`);
  console.log(`  → ${all.length} live stories, ${stillRetired.length} redirects`);
  if (dryRun) return console.log('  (dry run — nothing written)');

  buildInternalLinks(all, at);
  await writeStaticJson({
    clusters: all,
    retired: stillRetired,
    batchId: meta.batchId,
    generatedAt: at,
    nextUpdateAt: new Date(meta.nextUpdateAt),
    isSeed: false,
    ...(meta.pipeline ? { pipeline: meta.pipeline } : {}),
  });
  console.log('  written.');
}

await main();
