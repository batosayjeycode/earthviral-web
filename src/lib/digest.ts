/**
 * Daily World Viral Digest — /digest/ and /digest/[yyyy-mm-dd]/.
 *
 * One page per WIB calendar day, built from the stories first detected that day and ranked by
 * Viral Activity Score. Days come and go with the story data: a day drops out once retention
 * has removed enough of its stories (see MIN_DIGEST_STORIES), and the 404 page points old
 * digest links back to /digest/.
 *
 * Pure helpers here; the cached loaders (getDigestDays, digestForStory) live in data.ts.
 */
import type { ViralClusterStaticRecord } from './types.ts';

/** A day needs this many stories for a digest page; thinner days would be near-empty pages. */
export const MIN_DIGEST_STORIES = 10;
/** Stories in the ranked "Top viral stories" list. */
export const DIGEST_TOP = 10;

const WIB_OFFSET_MS = 7 * 3_600_000;

/** "2026-11-22": the WIB calendar day of an ISO timestamp. */
export const wibDay = (iso: string) =>
  new Date(Date.parse(iso) + WIB_OFFSET_MS).toISOString().slice(0, 10);

/** "November 22, 2026" for a "2026-11-22" day. */
export const formatDayLong = (day: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${day}T00:00:00Z`));

/** "Nov 22, 2026" for a "2026-11-22" day. */
export const formatDayShort = (day: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${day}T00:00:00Z`));

export const digestPath = (day: string) => `/digest/${day}/`;

export interface DigestDay {
  /** "2026-11-22" (WIB). */
  day: string;
  path: string;
  /** Stories first detected that day, highest score first. */
  stories: ViralClusterStaticRecord[];
  countryCount: number;
  /** Latest batch that updated any of the day's stories (sitemap lastmod). */
  lastmod: string;
}

export function buildDigestDays(clusters: ViralClusterStaticRecord[]): DigestDay[] {
  const byDay = new Map<string, ViralClusterStaticRecord[]>();
  for (const c of clusters) {
    const day = wibDay(c.firstDetectedAt);
    byDay.set(day, [...(byDay.get(day) ?? []), c]);
  }
  return [...byDay.entries()]
    .filter(([, stories]) => stories.length >= MIN_DIGEST_STORIES)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, stories]) => {
      const ranked = [...stories].sort(
        (a, b) =>
          b.viralScore - a.viralScore ||
          b.sources.length - a.sources.length ||
          a.id.localeCompare(b.id),
      );
      return {
        day,
        path: digestPath(day),
        stories: ranked,
        countryCount: new Set(ranked.map((c) => c.countryCode)).size,
        lastmod: ranked
          .map((c) => c.lastUpdatedBatchAt)
          .sort()
          .at(-1)!,
      };
    });
}
