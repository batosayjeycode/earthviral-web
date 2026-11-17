/**
 * Duplicate story merging.
 *
 * Clustering compares source headlines, which publishers word very differently, so one
 * event sometimes becomes two stories (e.g. "Watch: PM Modi visits Gurudwara Khalsa Diwan
 * in Manila" and "PM Modi leads foundation stone-laying ceremony for Philippines' oldest
 * gurudwara"). The AI-written headlines of those stories, however, come out near-identical.
 * This pass runs on finished records and merges stories that:
 *   - are in the same country,
 *   - were first detected within `windowDays` of each other, and
 *   - share a seoTitle, or have headlines whose keyword overlap (Jaccard) is ≥ `minSimilarity`
 *     with at least `minShared` keywords in common.
 * On a real data set every pair at ≥ 0.7 was the same event, while 0.5–0.6 already included
 * different ones ("Andreeva secures WTA semifinal spot" vs "… secures WTA title").
 *
 * The survivor keeps its URL and text and absorbs the other's sources:
 *   - an existing (published) story always survives over a new one, which is simply dropped;
 *   - between two existing stories, the one whose URL slug best matches its headline
 *     survives (a story that evolved from "protests at the palace" to "VP resigns" should
 *     not absorb the page actually named for the resignation), then the earliest (its URL
 *     is the likeliest to be indexed); the other is retired with a 301 to it;
 *   - between two new stories the higher-scoring one survives.
 */
import type { ViralClusterStaticRecord } from '../../../src/lib/types.ts';
import { eventTokens } from './deduplicateAndCluster.ts';

export interface MergeOptions {
  minSimilarity?: number;
  minShared?: number;
  windowDays?: number;
  maxSources?: number;
}

export interface Merge {
  /** The story that was merged away. */
  from: ViralClusterStaticRecord;
  into: ViralClusterStaticRecord;
  /** True when `from` was already published, so its URL must redirect to `into`. */
  retired: boolean;
}

const stem = (t: string) => t.slice(0, 5);
const keywords = (c: ViralClusterStaticRecord) =>
  new Set(eventTokens(c.headline, c.countryCode).map(stem));

/** Keywords shared by a story's URL slug and its current headline. */
function slugFit(c: ViralClusterStaticRecord): number {
  const slug = new Set(eventTokens(c.slug.replace(/-/g, ' '), c.countryCode).map(stem));
  return [...keywords(c)].filter((t) => slug.has(t)).length;
}

export function isDuplicate(
  a: ViralClusterStaticRecord,
  b: ViralClusterStaticRecord,
  { minSimilarity = 0.7, minShared = 3, windowDays = 3 }: MergeOptions = {},
): boolean {
  if (a.countryCode !== b.countryCode) return false;
  const gap = Math.abs(Date.parse(a.firstDetectedAt) - Date.parse(b.firstDetectedAt));
  if (gap > windowDays * 86_400_000) return false;
  if (a.seoTitle.trim().toLowerCase() === b.seoTitle.trim().toLowerCase()) return true;
  const ka = keywords(a);
  const kb = keywords(b);
  const shared = [...ka].filter((t) => kb.has(t)).length;
  return shared >= minShared && shared / (ka.size + kb.size - shared) >= minSimilarity;
}

/**
 * Merge duplicates in place. `isNew` marks records created in this batch (not yet published).
 * Returns the surviving records and what was merged.
 */
export function mergeDuplicateStories(
  records: ViralClusterStaticRecord[],
  isNew: (c: ViralClusterStaticRecord) => boolean,
  opts: MergeOptions = {},
): { records: ViralClusterStaticRecord[]; merges: Merge[] } {
  const { maxSources = 30 } = opts;
  // Survivor preference: existing first; among existing, best slug fit then earliest;
  // among new, highest score.
  const fit = new Map(records.map((r) => [r, slugFit(r)]));
  const ranked = [...records].sort(
    (a, b) =>
      Number(isNew(a)) - Number(isNew(b)) ||
      (isNew(a) ? b.viralScore - a.viralScore : fit.get(b)! - fit.get(a)!) ||
      a.firstDetectedAt.localeCompare(b.firstDetectedAt) ||
      a.id.localeCompare(b.id),
  );
  const survivors: ViralClusterStaticRecord[] = [];
  const merges: Merge[] = [];
  for (const c of ranked) {
    const into = survivors.find((s) => isDuplicate(s, c, opts));
    if (!into) {
      survivors.push(c);
      continue;
    }
    const byUrl = new Map([...into.sources, ...c.sources].map((s) => [s.articleUrl, s]));
    into.sources = [...byUrl.values()]
      .sort((x, y) => x.publishedAt.localeCompare(y.publishedAt))
      .slice(-maxSources);
    into.signalBreakdown.verifiedPublisherCount = new Set(
      into.sources.map((s) => s.publisherDomain),
    ).size;
    if (c.lastUpdatedBatchAt > into.lastUpdatedBatchAt)
      into.lastUpdatedBatchAt = c.lastUpdatedBatchAt;
    merges.push({ from: c, into, retired: !isNew(c) });
  }
  const kept = new Set(survivors);
  return { records: records.filter((r) => kept.has(r)), merges };
}
