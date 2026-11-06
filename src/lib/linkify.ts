/**
 * Contextual in-summary links (plan §9.5 item 5): when an AI summary mentions another
 * country or a tracked entity tag, wrap its FIRST occurrence in an internal link.
 * Runs at build time; returns escaped HTML safe for `set:html`.
 */

export interface LinkTarget {
  /** Text to look for, matched case-insensitively on word boundaries. */
  term: string;
  href: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function linkifyFirstMentions(text: string, targets: LinkTarget[], maxLinks = 4): string {
  // Longest terms first so "South Korea" wins over "Korea". Terms of ≤2 chars (e.g. "AI")
  // are skipped: too likely to match inside unrelated text.
  const sorted = [...targets]
    .filter((t) => t.term.length > 2)
    .sort((a, b) => b.term.length - a.term.length);

  type Match = { start: number; end: number; href: string };
  const matches: Match[] = [];
  const usedHrefs = new Set<string>();

  for (const target of sorted) {
    if (matches.length >= maxLinks) break;
    if (usedHrefs.has(target.href)) continue;
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(target.term)}(?![\\p{L}\\p{N}])`,
      'iu',
    );
    const found = re.exec(text);
    if (!found) continue;
    const start = found.index;
    const end = start + found[0].length;
    if (matches.some((m) => start < m.end && end > m.start)) continue; // never nest links
    matches.push({ start, end, href: target.href });
    usedHrefs.add(target.href);
  }

  matches.sort((a, b) => a.start - b.start);
  let html = '';
  let cursor = 0;
  for (const m of matches) {
    html += escapeHtml(text.slice(cursor, m.start));
    html += `<a href="${escapeHtml(m.href)}">${escapeHtml(text.slice(m.start, m.end))}</a>`;
    cursor = m.end;
  }
  return html + escapeHtml(text.slice(cursor));
}
