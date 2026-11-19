/**
 * Viral Activity Score — VAS 0–100 (plan §7.2 step 2: Coverage + Velocity + Trend signals).
 *
 *   coverage = 100 · (1 − e^(−publishers / 2.5))        breadth of independent outlets
 *   velocity = 100 · (1 − e^(−Σ e^(−age_h / 6) / 2.5))   recency-weighted article volume
 *   search   = 40 + 12 · log10(traffic + 1)  if the cluster matches a Google Trends
 *              search in the same country, else 0         (capped at 100)
 *
 *   VAS = min(100, 0.55 · coverage + 0.45 · velocity + 0.15 · search)
 *
 * Search is a bonus on top of the coverage/velocity base rather than a fixed share:
 * Trends only lists a few searches per country, so as a fixed 20% weight it capped
 * almost every real story below the "Viral Surge" tier (calibrated on a real batch).
 *
 * Scores are recomputed every batch from the cluster's full article history, so a story
 * that stops receiving coverage cools down naturally as its velocity decays.
 */
import { TIER_META, tierForScore, type IntensityTier } from '../../../src/lib/taxonomy.ts';
import { VAS } from '../../../src/lib/scoring.ts';
import type { TrendSignal } from '../fetchers/fetchGoogleTrends.ts';
import type { WorkingCluster } from './deduplicateAndCluster.ts';
import { eventTokens, publisherCount } from './deduplicateAndCluster.ts';

export const WEIGHTS = VAS.weights;

export interface ViralScore {
  viralScore: number;
  intensityTier: IntensityTier;
  coverage: number;
  velocity: number;
  search: number;
  publishers: number;
  matchedTrend: TrendSignal | null;
}

export function coverageScore(publishers: number): number {
  return 100 * (1 - Math.exp(-publishers / VAS.coverageScale));
}

export function velocityScore(publishedAt: string[], now: Date): number {
  const k = publishedAt.reduce((sum, iso) => {
    const ageHours = Math.max(0, (now.getTime() - Date.parse(iso)) / 3_600_000);
    return sum + Math.exp(-ageHours / VAS.velocityHalfLifeHours);
  }, 0);
  return 100 * (1 - Math.exp(-k / VAS.velocityScale));
}

export function searchScore(traffic: number): number {
  return Math.min(100, VAS.searchBase + VAS.searchPerDecade * Math.log10(traffic + 1));
}

/**
 * A trend matches when ≥ 60% of its keyword tokens appear in the cluster's titles, or
 * when one of the trend's attached news headlines shares ≥ 3 tokens with the cluster.
 * The country's own names don't count: a "south africa" search says nothing about which
 * South Africa story people are looking for.
 */
/**
 * Word form for comparing search queries with coverage: whole words with plural endings
 * dropped ("alerts" = "alert", "elections" = "election"). Prefix stems are too loose for
 * short queries ("palmeiras" would match "Palmer", "clima" "climate").
 */
const singular = (t: string) => (t.length > 4 ? t.replace(/(?:es|s)$/, '') : t);

/**
 * How well a trending search's own words fit a story: `share` of its keywords (country names
 * ignored) found in the coverage, and how many of those are core words of the story (in at
 * least two source headlines, or the story's seed).
 */
function queryFit(cluster: WorkingCluster, keyword: string) {
  const counts = new Map<string, number>();
  for (const [t, n] of cluster.tokenCounts)
    counts.set(singular(t), (counts.get(singular(t)) ?? 0) + n);
  const seed = new Set([...cluster.seedTokens].map(singular));
  const kw = [...new Set(eventTokens(keyword, cluster.countryCode).map(singular))];
  const present = kw.filter((s) => counts.has(s));
  const core = present.filter((s) => seed.has(s) || (counts.get(s) ?? 0) >= 2);
  return { share: kw.length ? present.length / kw.length : 0, core: core.length };
}

/**
 * The matched trending search, when its words fit the story well enough to put in its title
 * (≥ 60% of the keywords in the coverage, at least one a core word). Otherwise null.
 */
export function searchQueryFor(cluster: WorkingCluster, trend: TrendSignal | null): string | null {
  if (!trend) return null;
  const fit = queryFit(cluster, trend.keyword);
  return fit.share >= 0.6 && fit.core >= 1 ? trend.keyword : null;
}

/** Whether `text` (e.g. an seoTitle) contains most of the search query's keywords. */
export function usesSearchTerms(text: string, query: string, countryCode: string): boolean {
  const kw = [...new Set(eventTokens(query, countryCode).map(singular))];
  const words = new Set(eventTokens(text, countryCode).map(singular));
  return kw.length > 0 && kw.filter((w) => words.has(w)).length / kw.length >= 0.6;
}

/**
 * The highest-traffic trending search in the story's country that is about this story: its
 * keywords must be in the coverage (≥ 60%, one of them a core word), or ≥ 50% with one of
 * Google's linked news titles sharing 3+ words with the story. A single generic word
 * ("insurance", "airport") or a nearby news title alone no longer counts — those gave stories
 * a search bonus, and a "strong search interest" line, they hadn't earned.
 */
export function matchTrend(cluster: WorkingCluster, trends: TrendSignal[]): TrendSignal | null {
  let best: TrendSignal | null = null;
  for (const t of trends) {
    if (t.country !== cluster.countryCode) continue;
    const fit = queryFit(cluster, t.keyword);
    const kwHit = fit.share >= 0.6 && fit.core >= 1;
    const newsHit =
      fit.share >= 0.5 &&
      t.newsTitles.some(
        (title) =>
          eventTokens(title, cluster.countryCode).filter((x) => cluster.tokenCounts.has(x))
            .length >= 3,
      );
    if ((kwHit || newsHit) && (!best || t.traffic > best.traffic)) best = t;
  }
  return best;
}

export function computeViralScore(
  cluster: WorkingCluster,
  trends: TrendSignal[],
  now: Date,
): ViralScore {
  const publishers = publisherCount(cluster);
  const coverage = coverageScore(publishers);
  const velocity = velocityScore(
    cluster.articles.map((a) => a.publishedAt),
    now,
  );
  const matchedTrend = matchTrend(cluster, trends);
  const search = matchedTrend ? searchScore(matchedTrend.traffic) : 0;
  const viralScore = Math.round(
    Math.min(
      100,
      WEIGHTS.coverage * coverage + WEIGHTS.velocity * velocity + WEIGHTS.searchBonus * search,
    ),
  );
  return {
    viralScore,
    intensityTier: tierForScore(viralScore),
    coverage: Math.round(coverage),
    velocity: Math.round(velocity),
    search: Math.round(search),
    publishers,
    matchedTrend,
  };
}

export function describeTier(score: number): string {
  return TIER_META[tierForScore(score)].label;
}
