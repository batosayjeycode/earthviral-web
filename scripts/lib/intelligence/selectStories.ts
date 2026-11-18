/**
 * Story admission and retention.
 *
 * Published story URLs are kept for as long as possible: a URL that disappears a few days
 * after Google indexed it wastes the crawl and every ranking signal it collected. So:
 *
 *  - `selectTopPerCountry` limits how many stories per country are *live at once* (active
 *    in the last `VAS.activeWindowHours`). Active existing stories and new candidates compete
 *    on their current Viral Activity Score; only new candidates are ever dropped by it.
 *    Existing stories that rank below the cap simply stay published as archive pages.
 *  - `retireOldest` bounds the total size of the static site (every story costs an HTML page,
 *    an OG image and search-index files, and Cloudflare Pages caps files per deployment).
 *    When over budget, the stories with the oldest coverage go first.
 */
export interface Rankable {
  countryCode: string;
  viralScore: number;
  isExisting: boolean;
}

export interface Selection<T> {
  kept: T[];
  dropped: T[];
}

/**
 * Keep the top `limit` per country, ranking existing and new items together.
 * `limit` ≤ 0 means "no cap". Order of `kept` follows score, highest first.
 * Ties go to existing stories, so equal scores never churn published URLs.
 */
export function selectTopPerCountry<T extends Rankable>(items: T[], limit: number): Selection<T> {
  if (limit <= 0) return { kept: [...items], dropped: [] };
  const ranked = [...items].sort(
    (a, b) => b.viralScore - a.viralScore || Number(b.isExisting) - Number(a.isExisting),
  );
  const perCountry = new Map<string, number>();
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const item of ranked) {
    const n = perCountry.get(item.countryCode) ?? 0;
    if (n < limit) {
      kept.push(item);
      perCountry.set(item.countryCode, n + 1);
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped };
}

/**
 * Keep at most `max` items, retiring the ones whose coverage is oldest (`lastUpdatedAt`,
 * an ISO timestamp). Pass `Infinity` for no limit. Input order is preserved in `kept`.
 */
export function retireOldest<T extends { lastUpdatedAt: string }>(
  items: T[],
  max: number,
): Selection<T> {
  if (items.length <= max) return { kept: [...items], dropped: [] };
  const byAge = [...items].sort(
    (a, b) => Date.parse(a.lastUpdatedAt) - Date.parse(b.lastUpdatedAt),
  );
  const dropped = new Set(byAge.slice(0, items.length - Math.max(0, max)));
  return { kept: items.filter((x) => !dropped.has(x)), dropped: [...dropped] };
}

/**
 * Order of AI summary work for a batch. `required` (new, repaired and updated stories) and,
 * with `all`, every story still on fallback text are ranked together by score. Otherwise up
 * to `auto` fallback stories (highest score first) are appended after the required work, so
 * they only use AI calls left over once everything else is summarised.
 */
export function summaryQueue<T extends { score: { viralScore: number } }>(
  required: T[],
  fallback: T[],
  { all, auto }: { all: boolean; auto: number },
): { queue: T[]; retried: T[] } {
  const byScore = (a: T, b: T) => b.score.viralScore - a.score.viralScore;
  if (all) {
    const queue = [...required, ...fallback].sort(byScore);
    return { queue, retried: [...fallback] };
  }
  const retried = [...fallback].sort(byScore).slice(0, Math.max(0, auto));
  return { queue: [...[...required].sort(byScore), ...retried], retried };
}
