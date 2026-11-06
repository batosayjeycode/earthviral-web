/** Parallel RSS 2.0 / Atom fetcher + parser (plan §10 `fetchRss.ts`). */
import { XMLParser } from 'fast-xml-parser';
import { fetchText, mapLimit } from '../http.ts';
import type { RssSource } from './rssSources.ts';

export interface RawArticle {
  url: string;
  title: string;
  /** Plain-text description, trimmed. Used only as LLM context — never published verbatim. */
  snippet: string;
  publishedAt: string; // ISO-8601
  publisherName: string;
  publisherDomain: string;
  /** Outlet's home country (RSS) or GDELT source country; null for global wires. */
  homeCountry: string | null;
  language: string;
  via: 'rss' | 'gdelt';
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
});

const asArray = <T>(v: T | T[] | undefined): T[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

function text(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>))
    return String((node as Record<string, unknown>)['#text']);
  return '';
}

export function stripHtml(html: string): string {
  return html
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function toIso(value: string): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function cleanUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    for (const p of [...u.searchParams.keys()])
      if (/^(utm_|fbclid|gclid|at_medium|at_campaign)/i.test(p)) u.searchParams.delete(p);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** The subset of RSS 2.0 / RDF / Atom shapes we read (fast-xml-parser output). */
interface RssItem {
  title?: unknown;
  link?: unknown;
  guid?: unknown;
  description?: unknown;
  pubDate?: unknown;
  'dc:date'?: unknown;
}
interface AtomLink {
  '@_href'?: string;
  '@_rel'?: string;
}
interface AtomEntry {
  title?: unknown;
  link?: AtomLink | AtomLink[];
  summary?: unknown;
  content?: unknown;
  published?: unknown;
  updated?: unknown;
}
interface FeedDoc {
  rss?: { channel?: { item?: RssItem | RssItem[] } };
  'rdf:RDF'?: { item?: RssItem | RssItem[] };
  feed?: { entry?: AtomEntry | AtomEntry[] };
}

export function parseFeed(xml: string, source: RssSource, now: Date): RawArticle[] {
  const doc = parser.parse(xml) as FeedDoc;
  const rssItems = asArray(doc.rss?.channel?.item ?? doc['rdf:RDF']?.item);
  const atomEntries = asArray(doc.feed?.entry);
  const out: RawArticle[] = [];

  const push = (title: string, link: string, description: string, date: string) => {
    const url = cleanUrl(link);
    const cleanTitle = stripHtml(title);
    if (!url || cleanTitle.length < 12) return;
    // Missing/future dates are clamped to "now" so velocity can't be gamed by bad feeds.
    let publishedAt = toIso(date) ?? now.toISOString();
    if (Date.parse(publishedAt) > now.getTime()) publishedAt = now.toISOString();
    out.push({
      url,
      title: cleanTitle,
      snippet: stripHtml(description).slice(0, 400),
      publishedAt: publishedAt.replace(/\.\d{3}Z$/, 'Z'),
      publisherName: source.publisherName,
      publisherDomain: source.publisherDomain,
      homeCountry: source.homeCountry,
      language: source.language,
      via: 'rss',
    });
  };

  for (const item of rssItems) {
    push(
      text(item.title),
      text(item.link) || text(item.guid),
      text(item.description),
      text(item.pubDate) || text(item['dc:date']),
    );
  }
  for (const entry of atomEntries) {
    const links = asArray(entry.link);
    const href =
      links.find((l) => l?.['@_rel'] === 'alternate' || !l?.['@_rel'])?.['@_href'] ??
      text(links[0]);
    push(
      text(entry.title),
      href ?? '',
      text(entry.summary) || text(entry.content),
      text(entry.published) || text(entry.updated),
    );
  }
  return out;
}

export interface RssResult {
  articles: RawArticle[];
  ok: string[];
  failed: string[];
}

export async function fetchAllRss(
  sources: RssSource[],
  now: Date,
  maxAgeHours = 48,
): Promise<RssResult> {
  const ok: string[] = [];
  const failed: string[] = [];
  const minTime = now.getTime() - maxAgeHours * 3_600_000;

  const batches = await mapLimit(sources, 8, async (source) => {
    try {
      const xml = await fetchText(source.url, {
        headers: {
          accept:
            'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
        },
      });
      const articles = parseFeed(xml, source, now).filter(
        (a) => Date.parse(a.publishedAt) >= minTime,
      );
      ok.push(source.id);
      return articles;
    } catch (err) {
      failed.push(`${source.id}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  });

  return { articles: batches.flat(), ok, failed };
}
