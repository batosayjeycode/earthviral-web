/** Decide which tracked country an article is about, from its headline (and snippet). */
import { CASE_SENSITIVE_ALIASES, COUNTRIES } from '../countries.ts';

interface AliasMatcher {
  code: string;
  re: RegExp;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MATCHERS: AliasMatcher[] = COUNTRIES.flatMap((c) =>
  c.aliases.map((alias) => ({
    code: c.code,
    re: new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRe(alias)}(?![\\p{L}\\p{N}])`,
      CASE_SENSITIVE_ALIASES.has(alias) ? 'u' : 'iu',
    ),
  })),
);

/** All tracked countries mentioned, in order of first appearance. */
export function mentionedCountries(text: string): string[] {
  const hits: Array<{ code: string; index: number }> = [];
  for (const m of MATCHERS) {
    const found = m.re.exec(text);
    if (found) hits.push({ code: m.code, index: found.index });
  }
  hits.sort((a, b) => a.index - b.index);
  return [...new Set(hits.map((h) => h.code))];
}

/**
 * Rules:
 *  - National outlet: stays with its home country unless the headline names exactly
 *    one *other* tracked country and not the home country (e.g. Antara on Japan).
 *  - Global wire (no home country): the first country named in the headline, else the
 *    snippet; articles naming no tracked country are dropped (returns null).
 */
export function detectCountry(
  title: string,
  snippet: string,
  homeCountry: string | null,
): string | null {
  const inTitle = mentionedCountries(title);
  if (homeCountry) {
    if (inTitle.includes(homeCountry)) return homeCountry;
    const others = inTitle.filter((c) => c !== homeCountry);
    return others.length === 1 ? others[0]! : homeCountry;
  }
  return inTitle[0] ?? mentionedCountries(snippet)[0] ?? null;
}
