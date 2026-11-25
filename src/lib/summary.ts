/** Sentence every non-AI summary contains; also how stored fallback summaries are recognised. */
export const FALLBACK_MARKER = 'This summary was generated without an AI model';

/** True when a stored story still has the non-AI fallback text (see `--resummarize-fallback`). */
export function isFallbackSummary(story: { aiContextParagraph: string }): boolean {
  return story.aiContextParagraph.includes(FALLBACK_MARKER);
}
