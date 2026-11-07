/**
 * Inventory of indexable pages, mirroring each page template's generation and `noindex`
 * rules, so sitemaps list exactly the URLs that exist and are meant to be indexed.
 */
import { CATEGORIES, REGIONS } from './taxonomy.ts';
import { batchMeta, getClusters, getCountries, getTopics } from './data.ts';
import type { ViralClusterStaticRecord } from './types.ts';

export interface SitemapEntry {
  path: string;
  lastmod: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly';
  priority?: number;
}

/** Homepage + hubs (plan §9.4 `sitemap-core.xml`). */
export async function coreEntries(): Promise<SitemapEntry[]> {
  const [clusters, countries, topics] = await Promise.all([
    getClusters(),
    getCountries(),
    getTopics(),
  ]);
  const lastmod = batchMeta.generatedAt;
  const hub = (path: string, priority = 0.9): SitemapEntry => ({
    path,
    lastmod,
    changefreq: 'hourly',
    priority,
  });

  const entries: SitemapEntry[] = [hub('/', 1)];
  for (const r of REGIONS)
    if (clusters.some((c) => c.region === r.name)) entries.push(hub(`/region/${r.slug}/`));
  for (const cat of CATEGORIES)
    if (clusters.some((c) => c.categorySlug === cat.slug))
      entries.push(hub(`/category/${cat.slug}/`));
  for (const country of countries) {
    const own = clusters.filter((c) => c.countryCode === country.code);
    if (own.length === 0) continue;
    entries.push(hub(`/country/${country.slug}/`));
    for (const cat of CATEGORIES) {
      if (own.some((c) => c.categorySlug === cat.slug))
        entries.push(hub(`/country/${country.slug}/${cat.slug}/`, 0.7));
    }
  }
  for (const t of topics) entries.push(hub(`/topic/${t.slug}/`, 0.6));
  for (const path of ['/about/', '/contact/', '/privacy/', '/terms/'])
    entries.push({ path, lastmod, changefreq: 'weekly', priority: 0.4 });
  return entries;
}

export const storyMonth = (c: ViralClusterStaticRecord) => c.firstDetectedAt.slice(0, 7); // "2026-11"

/** Story pages grouped by month of first detection (plan §9.4 `sitemap-stories-[yyyy-mm].xml`). */
export async function storiesByMonth(): Promise<Map<string, ViralClusterStaticRecord[]>> {
  const byMonth = new Map<string, ViralClusterStaticRecord[]>();
  for (const c of await getClusters())
    byMonth.set(storyMonth(c), [...(byMonth.get(storyMonth(c)) ?? []), c]);
  return new Map([...byMonth.entries()].sort(([a], [b]) => b.localeCompare(a)));
}

/** Stories first detected within the last 48 h of the batch (Google News sitemap window). */
export async function newsWindowStories(): Promise<ViralClusterStaticRecord[]> {
  const cutoff = Date.parse(batchMeta.generatedAt) - 48 * 3_600_000;
  return (await getClusters())
    .filter((c) => Date.parse(c.firstDetectedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.firstDetectedAt) - Date.parse(a.firstDetectedAt));
}
