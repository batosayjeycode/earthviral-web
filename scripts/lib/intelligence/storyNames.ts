/**
 * Keep the searchable names of a story in its search title.
 *
 * A story's URL slug is fixed when it is first published and names the original event
 * (".../flash-floods-damage-gayo-lues-aceh/"). As coverage grows, an update can rewrite the
 * title more broadly ("Flash Floods Impact Multiple Regions Across Indonesia") and drop the
 * names people actually search for. Search Console showed exactly that: "gayo lues regency
 * floods" and "giring ganesha" ranked on page 1 with titles lacking those names, and got no
 * clicks.
 *
 * The anchors are the story's stored entity tags whose words all appear in the slug: the names
 * that identified the event when it was published. New tags are not used: the model also tags
 * generic topics ("Flash floods"), which would let a generalised title pass.
 */
import type { SummaryOutput } from './generateAiSummaries.ts';
import { normalize } from './text.ts';

/** Longest headline usable as a search title (Google shows about 60–70 characters). */
const MAX_TITLE = 70;

const words = (text: string): string[] =>
  normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Plural-insensitive: "floods" = "flood"; whole words only. */
const fold = (w: string): string => (w.length > 4 ? w.replace(/(es|s)$/, '') : w);

/** Entity names whose every word is in the slug (e.g. "Giring Ganesha", "Aceh"). */
export function storyAnchors(slug: string, entityNames: readonly string[]): string[] {
  const slugWords = new Set(slug.split('-').map(fold));
  const seen = new Set<string>();
  return entityNames.filter((name) => {
    const w = words(name).map(fold);
    const key = w.join(' ');
    if (!w.length || key.length < 3 || seen.has(key)) return false;
    seen.add(key);
    return w.every((x) => slugWords.has(x));
  });
}

/** Whether the text contains at least one anchor, every word of it, as whole words. */
export function namesAnchor(text: string, anchors: readonly string[]): boolean {
  const have = new Set(words(text).map(fold));
  return anchors.some((a) => words(a).every((w) => have.has(fold(w))));
}

export type TitleNameCheck = 'kept' | 'headline' | 'previous' | 'missing' | 'no-anchor';

/**
 * For an update of a published story: if the new seoTitle lost every anchor name, use the
 * new headline when it has one and fits, else the previous seoTitle when it has one. Otherwise the
 * output is unchanged ('missing', counted so it shows in the batch log).
 */
export function keepStoryNames(
  out: SummaryOutput,
  previous: { slug: string; seoTitle: string; entityTags: readonly string[] },
): { output: SummaryOutput; check: TitleNameCheck; anchors: string[] } {
  const anchors = storyAnchors(previous.slug, previous.entityTags);
  if (!anchors.length) return { output: out, check: 'no-anchor', anchors };
  if (namesAnchor(out.seoTitle, anchors)) return { output: out, check: 'kept', anchors };
  if (out.headline.length <= MAX_TITLE && namesAnchor(out.headline, anchors))
    return { output: { ...out, seoTitle: out.headline }, check: 'headline', anchors };
  if (namesAnchor(previous.seoTitle, anchors))
    return { output: { ...out, seoTitle: previous.seoTitle }, check: 'previous', anchors };
  return { output: out, check: 'missing', anchors };
}
