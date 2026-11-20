import { getCollection } from 'astro:content';
import batchMetaJson from '../data/generated/batch-meta.json';
import { displayableSources, hasDerivableCoverage } from './publisherPolicy.ts';
import type { BatchMeta, CountryMasterRecord, ViralClusterStaticRecord } from './types.ts';
import { formatDateWib } from './format.ts';

export const batchMeta = batchMetaJson as BatchMeta;

let clusterCache: ViralClusterStaticRecord[] | undefined;
let countryCache: CountryMasterRecord[] | undefined;

/**
 * All publishable clusters, highest viral score first. Publisher content policies apply here,
 * so every page, feed and sitemap sees the same data: sources a policy hides are dropped
 * (removed publishers; headline-only publishers without other coverage), and a story with no
 * publishable coverage left is not built at all.
 */
export async function getClusters(): Promise<ViralClusterStaticRecord[]> {
  clusterCache ??= (await getCollection('clusters'))
    .map((entry) => entry.data as ViralClusterStaticRecord)
    .filter((c) => hasDerivableCoverage(displayableSources(c.sources)))
    .map((c) => ({ ...c, sources: displayableSources(c.sources) }))
    .sort((a, b) => b.viralScore - a.viralScore);
  return clusterCache;
}

/** All countries with data this batch, highest viral score first. */
export async function getCountries(): Promise<CountryMasterRecord[]> {
  countryCache ??= (await getCollection('countries'))
    .map((entry) => ({ ...entry.data, id: entry.id }) as CountryMasterRecord)
    .sort((a, b) => b.viralScore - a.viralScore);
  return countryCache;
}

export async function getCategories() {
  return (await getCollection('categories')).map((entry) => ({ ...entry.data, id: entry.id }));
}

/**
 * Resolve related-story slugs from the link graph. Slugs are looked up within the
 * preferred country first, so a slug reused in another country never hijacks the link.
 */
export async function resolveClusters(
  slugs: string[],
  preferCountry?: string,
): Promise<ViralClusterStaticRecord[]> {
  const all = await getClusters();
  return slugs
    .map(
      (slug) =>
        (preferCountry && all.find((c) => c.slug === slug && c.countryCode === preferCountry)) ||
        all.find((c) => c.slug === slug),
    )
    .filter((c): c is ViralClusterStaticRecord => Boolean(c));
}

export interface TopicRecord {
  slug: string;
  name: string;
  clusters: ViralClusterStaticRecord[];
  /** Highest viral score among the topic's clusters. */
  peakScore: number;
}

/**
 * A topic page is built only once this many stories share the tag. Single-story topics
 * would be near-duplicates of the story itself — hundreds of thin pages that dilute how
 * search engines rate the site and waste crawl budget. Tags below the threshold render as
 * plain text instead of links.
 */
export const MIN_TOPIC_STORIES = 3;

let topicCache: TopicRecord[] | undefined;

/**
 * Entity-tag topics aggregated across every cluster, limited to tags with at least
 * MIN_TOPIC_STORIES stories (feeds /topic/[tagSlug]/).
 */
export async function getTopics(): Promise<TopicRecord[]> {
  topicCache ??= await buildTopics();
  return topicCache;
}

async function buildTopics(): Promise<TopicRecord[]> {
  const bySlug = new Map<string, TopicRecord>();
  for (const cluster of await getClusters()) {
    for (const tag of cluster.entityTags) {
      const topic = bySlug.get(tag.slug) ?? {
        slug: tag.slug,
        name: tag.name,
        clusters: [],
        peakScore: 0,
      };
      topic.clusters.push(cluster);
      topic.peakScore = Math.max(topic.peakScore, cluster.viralScore);
      bySlug.set(tag.slug, topic);
    }
  }
  return [...bySlug.values()]
    .filter((t) => t.clusters.length >= MIN_TOPIC_STORIES)
    .sort((a, b) => b.peakScore - a.peakScore || a.name.localeCompare(b.name));
}

let titleCache: Map<string, string> | undefined;

/**
 * A unique page title (without the " | EarthViral" suffix) for every story, by cluster id.
 * Normally the generated seoTitle. Stories can share one (the same event reported twice,
 * or in two countries): the earliest keeps it, the others use their headline, then
 * "seoTitle — Country, date", then a number, whichever is still free. Duplicate titles
 * would make search engines treat the pages as duplicates (and fail the dist tests).
 */
export async function getStoryTitles(): Promise<Map<string, string>> {
  if (titleCache) return titleCache;
  const key = (t: string) => t.trim().toLowerCase();
  // A seoTitle clipped with "…" (fallback text, or an over-long AI title) reads as broken in
  // results; the full headline is the better title.
  const seoTitle = (c: ViralClusterStaticRecord) =>
    c.seoTitle.trim().endsWith('…') ? c.headline.trim() : c.seoTitle.trim();
  const clusters = [...(await getClusters())].sort(
    (a, b) => a.firstDetectedAt.localeCompare(b.firstDetectedAt) || a.id.localeCompare(b.id),
  );
  const firstWithSeoTitle = new Map<string, ViralClusterStaticRecord>();
  for (const c of clusters)
    if (!firstWithSeoTitle.has(key(seoTitle(c)))) firstWithSeoTitle.set(key(seoTitle(c)), c);

  const titles = new Map<string, string>();
  const used = new Set<string>();
  for (const c of firstWithSeoTitle.values()) {
    titles.set(c.id, seoTitle(c));
    used.add(key(seoTitle(c)));
  }
  for (const c of clusters) {
    if (titles.has(c.id)) continue;
    const base = `${seoTitle(c)} — ${c.countryName}, ${formatDateWib(c.firstDetectedAt)}`;
    let title = [c.headline.trim(), base].find((t) => !used.has(key(t)));
    for (let n = 2; !title; n++) if (!used.has(key(`${base} (${n})`))) title = `${base} (${n})`;
    titles.set(c.id, title);
    used.add(key(title));
  }
  titleCache = titles;
  return titles;
}
