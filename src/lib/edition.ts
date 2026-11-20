/**
 * Header "edition" (the country button) — which country a visitor sees.
 *
 * Priority: a manual pick (kept until changed) → the visitor's detected country (cached for
 * a day) → Indonesia. Only countries with a hub page are editions; anything else falls
 * through to the next source. Storage is the visitor's own localStorage, so nothing is
 * shared between visitors. Pure helpers here; the DOM wiring lives in Header.astro.
 */

/** Country code → [hub slug, name]. */
export type Editions = Record<string, readonly [slug: string, name: string]>;

export const DEFAULT_EDITION = 'ID';
/** Detected country: `{ country, at }`, valid for GEO_TTL_MS. */
export const GEO_KEY = 'ev-geo';
/** Manual pick: a country code, kept until the visitor changes it or picks "my location". */
export const PICK_KEY = 'ev-edition';
export const GEO_TTL_MS = 86_400_000;

/**
 * The cached detected country, or `undefined` when there is no usable entry (missing,
 * expired, from the future, or corrupt) and /api/geo should be asked again.
 * `{ country: null }` is a valid answer: "location unknown".
 */
export function readGeoCache(
  raw: string | null,
  now: number,
): { country: string | null } | undefined {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return undefined;
    const { country, at } = v as { country?: unknown; at?: unknown };
    if (typeof at !== 'number' || at > now || now - at >= GEO_TTL_MS) return undefined;
    if (country !== null && (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)))
      return undefined;
    return { country };
  } catch {
    return undefined;
  }
}

export function writeGeoCache(country: string | null, now: number): string {
  return JSON.stringify({ country, at: now });
}

/** The edition to show: manual pick, else detected country, else Indonesia. */
export function resolveEdition(
  editions: Editions,
  manual: string | null | undefined,
  detected: string | null | undefined,
): string {
  if (manual && editions[manual]) return manual;
  if (detected && editions[detected]) return detected;
  return DEFAULT_EDITION;
}
