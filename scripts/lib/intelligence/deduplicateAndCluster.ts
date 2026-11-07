/**
 * Article deduplication + event clustering (plan §10 `deduplicateAndCluster.ts`).
 *
 * Greedy single-pass clustering on TF-IDF title vectors, scoped per country:
 *   1. Existing clusters (previous batches) are seeded from their stored source titles,
 *      so follow-up coverage attaches to the same story and its URL stays stable.
 *   2. New articles, oldest first, join the most similar cluster when cosine ≥ threshold
 *      AND they share ≥ 2 meaningful tokens (stops one common name merging unrelated news);
 *      otherwise they start a new cluster.
 */
import type { ViralClusterStaticRecord } from '../../../src/lib/types.ts';
import { buildIdf, centroid, cosine, tfidf, tokenize, type SparseVector } from './text.ts';

export interface ClusterArticle {
  url: string;
  title: string;
  snippet: string;
  publishedAt: string;
  publisherName: string;
  publisherDomain: string;
  isNew: boolean;
}

export interface CountryArticle extends Omit<ClusterArticle, 'isNew'> {
  countryCode: string;
}

export interface WorkingCluster {
  countryCode: string;
  existing: ViralClusterStaticRecord | null;
  articles: ClusterArticle[];
  vectors: SparseVector[];
  tokens: Set<string>;
  centroid: SparseVector;
}

export interface ClusterOptions {
  /** Article → cluster-centroid cosine needed to join (tuned on a real 1,083-article batch). */
  threshold?: number;
  minSharedTokens?: number;
  /** Second pass: same-country clusters whose centroids are this similar are merged. */
  mergeThreshold?: number;
}

/** Drop exact-URL duplicates and same-publisher re-posts of an identical headline. */
export function dedupeArticles<T extends { url: string; title: string; publisherDomain: string }>(
  articles: T[],
): T[] {
  const seenUrl = new Set<string>();
  const seenTitle = new Set<string>();
  return articles.filter((a) => {
    const titleKey = `${a.publisherDomain}|${tokenize(a.title).join(' ')}`;
    if (seenUrl.has(a.url) || seenTitle.has(titleKey)) return false;
    seenUrl.add(a.url);
    seenTitle.add(titleKey);
    return true;
  });
}

export function clusterArticles(
  articles: CountryArticle[],
  existing: ViralClusterStaticRecord[],
  { threshold = 0.2, minSharedTokens = 2, mergeThreshold = 0.35 }: ClusterOptions = {},
): WorkingCluster[] {
  const knownUrls = new Set(existing.flatMap((c) => c.sources.map((s) => s.articleUrl)));
  const fresh = dedupeArticles(articles.filter((a) => !knownUrls.has(a.url))).sort(
    (a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt),
  );

  const freshTokens = fresh.map((a) => tokenize(a.title));
  const existingDocs = existing.map((c) => c.sources.map((s) => tokenize(s.articleTitle)));
  const idf = buildIdf([...freshTokens, ...existingDocs.flat()]);

  const clusters: WorkingCluster[] = existing.map((c, i) => {
    const vectors = existingDocs[i]!.map((t) => tfidf(t, idf));
    return {
      countryCode: c.countryCode,
      existing: c,
      articles: c.sources.map((s) => ({
        url: s.articleUrl,
        title: s.articleTitle,
        snippet: '',
        publishedAt: s.publishedAt,
        publisherName: s.publisherName,
        publisherDomain: s.publisherDomain,
        isNew: false,
      })),
      vectors,
      tokens: new Set(existingDocs[i]!.flat()),
      centroid: centroid(vectors),
    };
  });

  const byCountry = new Map<string, WorkingCluster[]>();
  for (const c of clusters)
    byCountry.set(c.countryCode, [...(byCountry.get(c.countryCode) ?? []), c]);

  fresh.forEach((article, i) => {
    const tokens = freshTokens[i]!;
    if (tokens.length === 0) return;
    const vector = tfidf(tokens, idf);
    const candidates = byCountry.get(article.countryCode) ?? [];

    let best: WorkingCluster | null = null;
    let bestScore = 0;
    for (const c of candidates) {
      const score = cosine(vector, c.centroid);
      if (score <= bestScore || score < threshold) continue;
      const shared = tokens.filter((t) => c.tokens.has(t)).length;
      if (shared < minSharedTokens) continue;
      best = c;
      bestScore = score;
    }

    const { countryCode, ...rest } = article;
    const member: ClusterArticle = { ...rest, isNew: true };
    if (best) {
      best.articles.push(member);
      best.vectors.push(vector);
      for (const t of tokens) best.tokens.add(t);
      best.centroid = centroid(best.vectors);
    } else {
      const created: WorkingCluster = {
        countryCode,
        existing: null,
        articles: [member],
        vectors: [vector],
        tokens: new Set(tokens),
        centroid: vector,
      };
      clusters.push(created);
      byCountry.set(countryCode, [...candidates, created]);
    }
  });

  return mergeSimilarClusters(clusters, mergeThreshold);
}

/**
 * Single-pass greedy clustering fragments one event into sub-stories ("suspect named",
 * "suspect detained", "task force formed"). Merge same-country clusters whose centroids
 * are similar. Each existing (published) cluster keeps its identity: two existing
 * clusters are never merged together, so no published URL disappears.
 */
function mergeSimilarClusters(
  clusters: WorkingCluster[],
  mergeThreshold: number,
): WorkingCluster[] {
  const alive = new Set(clusters);
  // Larger clusters absorb smaller ones; existing clusters always act as the absorber.
  const order = [...clusters].sort(
    (a, b) =>
      Number(Boolean(b.existing)) - Number(Boolean(a.existing)) ||
      b.articles.length - a.articles.length,
  );
  for (const target of order) {
    if (!alive.has(target)) continue;
    for (const other of order) {
      if (other === target || !alive.has(other) || other.countryCode !== target.countryCode)
        continue;
      if (other.existing) continue;
      if (cosine(target.centroid, other.centroid) < mergeThreshold) continue;
      target.articles.push(...other.articles);
      target.vectors.push(...other.vectors);
      for (const t of other.tokens) target.tokens.add(t);
      target.centroid = centroid(target.vectors);
      alive.delete(other);
    }
  }
  return clusters.filter((c) => alive.has(c));
}

export const publisherCount = (c: WorkingCluster) =>
  new Set(c.articles.map((a) => a.publisherDomain)).size;
export const newArticleCount = (c: WorkingCluster) => c.articles.filter((a) => a.isNew).length;
