/**
 * Per-country story cap. The site is fully static, so every stored story costs a page, an
 * OG image and search-index entries; without a cap the data set grows every 3 hours.
 *
 * Each batch ranks a country's existing stories and its new candidates together by their
 * current Viral Activity Score and keeps the top `limit`. Scores are recomputed every
 * batch (velocity decays), so cooled stories naturally give way to new ones.
 * Ties go to existing stories, so equal scores never churn published URLs.
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

/** `limit` ≤ 0 means "no cap". Order of `kept` follows score, highest first. */
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
