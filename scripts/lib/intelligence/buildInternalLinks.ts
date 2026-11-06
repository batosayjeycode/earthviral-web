/**
 * Internal link graph (plan §9.5, §10 `buildInternalLinks.ts`). For every cluster:
 *   relatedInCountrySlugs  — 3 clusters in the same country
 *   relatedInCategorySlugs — 3 clusters in the same category in other countries
 * ranked by topical similarity (headline + entity tags) blended with viral score and
 * recency, so links favour live, related stories without ever linking a page to itself.
 */
import type { ViralClusterStaticRecord } from '../../../src/lib/types.ts';
import { buildIdf, cosine, tfidf, tokenize, type SparseVector } from './text.ts';

const ACTIVE_WINDOW_MS = 48 * 3_600_000;

export function buildInternalLinks(clusters: ViralClusterStaticRecord[], now: Date): void {
  const docs = clusters.map((c) =>
    tokenize(`${c.headline} ${c.entityTags.map((t) => t.name).join(' ')}`),
  );
  const idf = buildIdf(docs);
  const vectors: SparseVector[] = docs.map((d) => tfidf(d, idf));
  const index = new Map(clusters.map((c, i) => [c, i]));

  const rank = (self: ViralClusterStaticRecord, candidates: ViralClusterStaticRecord[]) =>
    candidates
      .map((c) => {
        const similarity = cosine(vectors[index.get(self)!]!, vectors[index.get(c)!]!);
        const sharedTag = c.entityTags.some((t) => self.entityTags.some((s) => s.slug === t.slug))
          ? 0.25
          : 0;
        const active =
          now.getTime() - Date.parse(c.lastUpdatedBatchAt) <= ACTIVE_WINDOW_MS ? 0.15 : 0;
        return { c, score: similarity + sharedTag + active + c.viralScore / 400 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.c.slug);

  for (const self of clusters) {
    self.relatedInCountrySlugs = rank(
      self,
      clusters.filter((c) => c !== self && c.countryCode === self.countryCode),
    );
    self.relatedInCategorySlugs = rank(
      self,
      clusters.filter(
        (c) =>
          c !== self && c.categorySlug === self.categorySlug && c.countryCode !== self.countryCode,
      ),
    );
  }
}
