/**
 * Build the summariser input for a cluster. This is the single place where article text is
 * selected for AI payloads and EarthViral-written text, so the publisher content policy is
 * applied here: only `derivableArticles` are included. Restricted publishers (headline-only)
 * still count in `metrics.publishers` — non-AI coverage counting is allowed — but their
 * headlines, names and dates never enter the input.
 */
import { derivableArticles } from '../../../src/lib/publisherPolicy.ts';
import { COUNTRY_BY_CODE } from '../countries.ts';
import type { ViralScore } from './computeViralScore.ts';
import type { WorkingCluster } from './deduplicateAndCluster.ts';
import type { SummaryInput } from './generateAiSummaries.ts';

export function summaryInput(cluster: WorkingCluster, score: ViralScore): SummaryInput {
  const country = COUNTRY_BY_CODE.get(cluster.countryCode)!;
  // Newest first so the model sees the latest developments; one article per publisher first.
  const ordered = derivableArticles(cluster.articles).sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
  const seen = new Set<string>();
  const primary = ordered.filter((a) =>
    seen.has(a.publisherDomain) ? false : (seen.add(a.publisherDomain), true),
  );
  const rest = ordered.filter((a) => !primary.includes(a));
  return {
    countryCode: country.code,
    countryName: country.name,
    articles: [...primary, ...rest].map((a) => ({
      publisherName: a.publisherName,
      publisherDomain: a.publisherDomain,
      title: a.title,
      snippet: a.snippet,
      publishedAt: a.publishedAt,
    })),
    metrics: {
      viralScore: score.viralScore,
      publishers: score.publishers,
      velocity: score.velocity,
      search: score.search,
      trendKeyword: score.matchedTrend?.keyword ?? null,
    },
    // A repaired story's stored headline describes the event it drifted onto.
    previousHeadline: cluster.pruned > 0 ? undefined : cluster.existing?.headline,
  };
}
