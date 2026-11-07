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
import { publisherCount } from './deduplicateAndCluster.ts';
import { tokenize } from './text.ts';

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
 */
export function matchTrend(cluster: WorkingCluster, trends: TrendSignal[]): TrendSignal | null {
  let best: TrendSignal | null = null;
  for (const t of trends) {
    if (t.country !== cluster.countryCode) continue;
    const kw = tokenize(t.keyword);
    const kwHit =
      kw.length > 0 && kw.filter((x) => cluster.tokens.has(x)).length / kw.length >= 0.6;
    const newsHit = t.newsTitles.some(
      (title) => tokenize(title).filter((x) => cluster.tokens.has(x)).length >= 3,
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
