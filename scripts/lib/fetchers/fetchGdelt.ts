/**
 * GDELT 2.0 DOC API (plan §7.2 step 1) — supplementary coverage from outlets that are
 * not in the curated RSS list. GDELT rate-limits aggressively (HTTP 429), so requests are
 * strictly sequential with a pause between them, and any failure simply skips the signal.
 */
import { fetchWithRetry, sleep } from '../http.ts';
import type { RawArticle } from './fetchRss.ts';

const GDELT_DOC = 'https://api.gdeltproject.org/api/v2/doc/doc';
const PAUSE_MS = 6_000;

interface GdeltArticle {
  url: string;
  title: string;
  seendate: string; // "20261106T031500Z"
  domain: string;
  language: string;
  sourcecountry: string;
}

function gdeltDate(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

/** `countries`: tracked country code + the GDELT `sourcecountry` name (e.g. "indonesia"). */
export async function fetchGdelt(
  countries: Array<{ code: string; gdeltName: string }>,
  maxPerCountry = 40,
) {
  const articles: RawArticle[] = [];
  const failed: string[] = [];

  for (const [i, c] of countries.entries()) {
    if (i > 0) await sleep(PAUSE_MS);
    const params = new URLSearchParams({
      query: `sourcecountry:${c.gdeltName}`,
      mode: 'artlist',
      format: 'json',
      timespan: '6h',
      maxrecords: String(maxPerCountry),
      sort: 'hybridrel',
    });
    try {
      const res = await fetchWithRetry(`${GDELT_DOC}?${params}`, {
        retries: 1,
        backoffMs: PAUSE_MS,
      });
      const body = (await res.json()) as { articles?: GdeltArticle[] };
      for (const a of body.articles ?? []) {
        const publishedAt = gdeltDate(a.seendate);
        if (!publishedAt || !a.title || !a.url) continue;
        articles.push({
          url: a.url,
          title: a.title.trim(),
          snippet: '',
          publishedAt,
          publisherName: a.domain,
          publisherDomain: a.domain,
          homeCountry: c.code,
          language: a.language?.toLowerCase().slice(0, 2) ?? 'en',
          via: 'gdelt',
        });
      }
    } catch (err) {
      failed.push(`gdelt-${c.gdeltName}: ${err instanceof Error ? err.message : String(err)}`);
      // A 429 usually means the whole API is throttling us — stop instead of hammering it.
      if (err instanceof Error && /HTTP 429/.test(err.message)) break;
    }
  }
  return { articles, failed };
}
