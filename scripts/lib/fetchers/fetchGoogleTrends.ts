/**
 * Public Google Trends geo RSS fetcher (plan §7.2 step 1). Each trending search becomes a
 * `TrendSignal`; clusters whose headlines overlap a trend's keyword or its attached news
 * titles receive a public-search signal score.
 */
import { XMLParser } from 'fast-xml-parser';
import { fetchText, mapLimit } from '../http.ts';
import { stripHtml } from './fetchRss.ts';

export interface TrendSignal {
  country: string;
  keyword: string;
  /** Parsed lower bound of `ht:approx_traffic` ("200,000+" → 200000). */
  traffic: number;
  newsTitles: string[];
}

const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true });
const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export function parseTraffic(raw: unknown): number {
  const n = Number(String(raw ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** The subset of the Trends RSS shape we read (fast-xml-parser output). */
interface TrendsNewsItem {
  'ht:news_item_title'?: unknown;
}
interface TrendsItem {
  title?: unknown;
  'ht:approx_traffic'?: unknown;
  'ht:news_item'?: TrendsNewsItem | TrendsNewsItem[];
}
interface TrendsDoc {
  rss?: { channel?: { item?: TrendsItem | TrendsItem[] } };
}

export function parseTrendsFeed(xml: string, country: string): TrendSignal[] {
  const doc = parser.parse(xml) as TrendsDoc;
  return asArray(doc.rss?.channel?.item)
    .map((item) => ({
      country,
      keyword: stripHtml(String(item.title ?? '')),
      traffic: parseTraffic(item['ht:approx_traffic']),
      newsTitles: asArray(item['ht:news_item'])
        .map((n) => stripHtml(String(n?.['ht:news_item_title'] ?? '')))
        .filter(Boolean),
    }))
    .filter((t) => t.keyword.length > 1);
}

export async function fetchGoogleTrends(geos: Array<{ code: string; geo: string }>) {
  const failed: string[] = [];
  const results = await mapLimit(geos, 4, async ({ code, geo }) => {
    try {
      const xml = await fetchText(
        `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`,
      );
      return parseTrendsFeed(xml, code);
    } catch (err) {
      failed.push(`trends-${geo}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  });
  return { signals: results.flat(), failed };
}
