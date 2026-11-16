/**
 * Article deduplication + event clustering (plan §10 `deduplicateAndCluster.ts`).
 *
 * Greedy single-pass clustering on TF-IDF title vectors, scoped per country:
 *   1. Existing clusters (previous batches) are seeded from their stored source titles,
 *      so follow-up coverage attaches to the same story and its URL stays stable. Stored
 *      sources are re-validated around the one that best matches the story's slug (its
 *      fixed identity); sources that no longer belong are pruned (see `pruned`).
 *   2. New articles, oldest first, join the most similar cluster when cosine ≥ threshold
 *      AND they share ≥ 2 of the cluster's *core* tokens; otherwise they start a new cluster.
 *
 * Two rules keep a published story from drifting onto a different event:
 *   - The cluster country's own names (aliases, demonyms, capitals) are ignored. Every
 *     South Africa headline says "South Africa"; that is context, not evidence of the
 *     same event.
 *   - Core tokens are the founding article's tokens plus those in at least two member
 *     titles. With a plain union, every article that joined added all its words as new
 *     attach points, so a long-running cluster snowballed into a catch-all for its
 *     country's news.
 */
import type { ViralClusterStaticRecord } from '../../../src/lib/types.ts';
import { COUNTRY_BY_CODE } from '../countries.ts';
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
  /** Token → number of member titles containing it. */
  tokenCounts: Map<string, number>;
  /** Tokens of the founding article (for existing stories: the source matching the slug). */
  seedTokens: Set<string>;
  centroid: SparseVector;
  /** Stored sources dropped because they were about a different event (existing only). */
  pruned: number;
}

export interface ClusterOptions {
  /** Article → cluster-centroid cosine needed to join (tuned on a real 1,083-article batch). */
  threshold?: number;
  minSharedTokens?: number;
  /** Second pass: same-country clusters whose centroids are this similar are merged. */
  mergeThreshold?: number;
}

const contextCache = new Map<string, Set<string>>();

/** Tokens that only say which country a headline is about (names, demonyms, places). */
export function countryContextTokens(countryCode: string): Set<string> {
  let tokens = contextCache.get(countryCode);
  if (!tokens) {
    const country = COUNTRY_BY_CODE.get(countryCode);
    tokens = new Set(
      [country?.name ?? '', ...(country?.aliases ?? [])].flatMap((a) => tokenize(a)),
    );
    contextCache.set(countryCode, tokens);
  }
  return tokens;
}

/** Title tokens that can identify an event within `countryCode`. */
export function eventTokens(title: string, countryCode: string): string[] {
  const context = countryContextTokens(countryCode);
  return tokenize(title).filter((t) => !context.has(t));
}

const nameCache = new Map<string, Set<string>>();

/**
 * Just the country's own name: its name tokens, aliases derived from them (demonyms like
 * "South African") and short codes ("US", "RI"). Unlike `countryContextTokens`, cities stay
 * in: "Delhi" is evidence when checking whether a source is about the story's event.
 */
function countryNameTokens(countryCode: string): Set<string> {
  let tokens = nameCache.get(countryCode);
  if (!tokens) {
    const country = COUNTRY_BY_CODE.get(countryCode);
    const nameTokens = tokenize(country?.name ?? '');
    const prefixes = new Set(nameTokens.map((t) => t.slice(0, 4)));
    tokens = new Set(nameTokens);
    for (const alias of country?.aliases ?? []) {
      const aliasTokens = tokenize(alias);
      if (
        alias.replace(/\W/g, '').length <= 3 ||
        aliasTokens.some((t) => prefixes.has(t.slice(0, 4)))
      )
        for (const t of aliasTokens) tokens.add(t);
    }
    nameCache.set(countryCode, tokens);
  }
  return tokens;
}

/** Light stemming for keyword overlap: "arrested" ~ "arrests", "foreign" ~ "foreigners". */
const stem = (t: string) => t.slice(0, 5);

/** Keyword stems of a text, without the country's own name. */
function keywordStems(text: string, countryCode: string): Set<string> {
  const name = countryNameTokens(countryCode);
  return new Set(
    tokenize(text)
      .filter((t) => !name.has(t))
      .map(stem),
  );
}

const slugText = (slug: string) => slug.replace(/-\d+$/, '').replace(/-/g, ' ');

/**
 * True when a story's headline no longer shares any keyword with its URL slug — the slug is
 * fixed at publication, so this means the story's content has moved to another event.
 */
export function hasDrifted(
  c: Pick<ViralClusterStaticRecord, 'slug' | 'headline' | 'countryCode'>,
): boolean {
  const slug = keywordStems(slugText(c.slug), c.countryCode);
  return ![...keywordStems(c.headline, c.countryCode)].some((t) => slug.has(t));
}

/** The founding article's tokens, plus tokens confirmed by ≥ 2 member titles. */
function isCore(cluster: WorkingCluster, token: string): boolean {
  return cluster.seedTokens.has(token) || (cluster.tokenCounts.get(token) ?? 0) >= 2;
}

function addMember(
  cluster: WorkingCluster,
  article: ClusterArticle,
  vector: SparseVector,
  tokens: string[],
) {
  if (cluster.articles.length === 0) cluster.seedTokens = new Set(tokens);
  cluster.articles.push(article);
  cluster.vectors.push(vector);
  for (const t of new Set(tokens))
    cluster.tokenCounts.set(t, (cluster.tokenCounts.get(t) ?? 0) + 1);
  cluster.centroid = centroid(cluster.vectors);
}

function joins(
  cluster: WorkingCluster,
  vector: SparseVector,
  tokens: string[],
  threshold: number,
  minSharedTokens: number,
): number {
  const score = cosine(vector, cluster.centroid);
  if (score < threshold) return 0;
  const shared = new Set(tokens.filter((t) => isCore(cluster, t))).size;
  return shared >= minSharedTokens ? score : 0;
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

/**
 * Rebuild an existing cluster from its stored sources.
 *
 * Normally every stored source is kept; the seed (whose tokens count as core) is the source
 * sharing the most keywords with the slug. A story is repaired around that seed only when it
 * has clearly drifted: its headline shares no keyword with the slug (`hasDrifted`) AND fewer
 * than half its sources share a keyword with the slug or seed. (A headline alone is not
 * enough: "100,000 march in fifth weekend" is still the "600,000 protest" story.) In a
 * repair, a source is pruned when it fails the normal join rules AND shares fewer than
 * `minSharedTokens` keywords with the slug or seed (one shared word is often incidental:
 * "leave", "national"). If no stored source matches the slug at all (its original coverage
 * already rotated out of the 30 stored sources), there is nothing reliable to repair around
 * and the story is left as it is.
 */
function seedExisting(
  c: ViralClusterStaticRecord,
  idf: Map<string, number>,
  threshold: number,
  minSharedTokens: number,
): WorkingCluster {
  const sources = [...c.sources]
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
    .map((s) => {
      const tokens = eventTokens(s.articleTitle, c.countryCode);
      return {
        s,
        tokens,
        keywords: keywordStems(s.articleTitle, c.countryCode),
        vector: tfidf(tokens, idf),
      };
    });
  const anchor = keywordStems(slugText(c.slug), c.countryCode);
  const overlap = (keywords: Set<string>) => [...keywords].filter((t) => anchor.has(t)).length;
  let seedIndex = 0;
  sources.forEach((x, i) => {
    if (overlap(x.keywords) > overlap(sources[seedIndex]!.keywords)) seedIndex = i;
  });
  const seed = sources[seedIndex]!;
  const seedMatchesSlug = overlap(seed.keywords) > 0;
  for (const t of seed.keywords) anchor.add(t);
  const related = sources.filter((x) => overlap(x.keywords) > 0).length;
  const repair = seedMatchesSlug && hasDrifted(c) && related < sources.length / 2;

  const cluster: WorkingCluster = {
    countryCode: c.countryCode,
    existing: c,
    articles: [],
    vectors: [],
    tokenCounts: new Map(),
    seedTokens: new Set(),
    centroid: new Map(),
    pruned: 0,
  };
  const ordered = [seed, ...sources.filter((_, i) => i !== seedIndex)];
  for (const [i, { s, tokens, keywords, vector }] of ordered.entries()) {
    if (
      repair &&
      i > 0 &&
      !joins(cluster, vector, tokens, threshold, minSharedTokens) &&
      overlap(keywords) < minSharedTokens
    ) {
      cluster.pruned++;
      continue;
    }
    addMember(
      cluster,
      {
        url: s.articleUrl,
        title: s.articleTitle,
        snippet: '',
        publishedAt: s.publishedAt,
        publisherName: s.publisherName,
        publisherDomain: s.publisherDomain,
        isNew: false,
      },
      vector,
      tokens,
    );
  }
  return cluster;
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

  const freshTokens = fresh.map((a) => eventTokens(a.title, a.countryCode));
  const existingDocs = existing.flatMap((c) =>
    c.sources.map((s) => eventTokens(s.articleTitle, c.countryCode)),
  );
  const idf = buildIdf([...freshTokens, ...existingDocs]);

  const clusters = existing.map((c) => seedExisting(c, idf, threshold, minSharedTokens));

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
      const score = joins(c, vector, tokens, threshold, minSharedTokens);
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }

    const { countryCode, ...rest } = article;
    const member: ClusterArticle = { ...rest, isNew: true };
    if (best) {
      addMember(best, member, vector, tokens);
    } else {
      const created: WorkingCluster = {
        countryCode,
        existing: null,
        articles: [],
        vectors: [],
        tokenCounts: new Map(),
        seedTokens: new Set(),
        centroid: new Map(),
        pruned: 0,
      };
      addMember(created, member, vector, tokens);
      clusters.push(created);
      byCountry.set(countryCode, [...candidates, created]);
    }
  });

  return mergeSimilarClusters(clusters, mergeThreshold, minSharedTokens);
}

/**
 * Single-pass greedy clustering fragments one event into sub-stories ("suspect named",
 * "suspect detained", "task force formed"). Merge same-country clusters whose centroids
 * are similar and that share core tokens. Each existing (published) cluster keeps its
 * identity: two existing clusters are never merged together, so no published URL disappears.
 */
function mergeSimilarClusters(
  clusters: WorkingCluster[],
  mergeThreshold: number,
  minSharedTokens: number,
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
      const sharedCore = [...other.tokenCounts.keys()].filter(
        (t) => isCore(other, t) && isCore(target, t),
      ).length;
      if (sharedCore < minSharedTokens) continue;
      for (const [i, a] of other.articles.entries()) {
        const tokens = [...other.tokenCounts.keys()].filter((t) => other.vectors[i]!.has(t));
        addMember(target, a, other.vectors[i]!, tokens);
      }
      alive.delete(other);
    }
  }
  return clusters.filter((c) => alive.has(c));
}

export const publisherCount = (c: WorkingCluster) =>
  new Set(c.articles.map((a) => a.publisherDomain)).size;
export const newArticleCount = (c: WorkingCluster) => c.articles.filter((a) => a.isNew).length;
