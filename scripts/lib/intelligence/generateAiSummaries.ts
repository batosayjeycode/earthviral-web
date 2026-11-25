/**
 * Batch LLM summariser (plan §7.2 step 2, §10 `generateAiSummaries.ts`).
 *
 * Providers (chosen by `--provider` or by which API key is present):
 *   gemini  — Gemini API `generateContent` with `responseSchema` (default model gemini-3.1-flash-lite)
 *   openai  — Chat Completions with strict `json_schema` (default model gpt-5-mini)
 *   none    — deterministic, non-AI fallback built from headlines + metrics
 *
 * Every model response is validated with Zod; invalid or failed responses fall back to
 * the `none` summary for that cluster so one bad call never aborts the batch.
 */
import { z } from 'astro/zod';
import { CATEGORIES, CATEGORY_SLUGS, type CategorySlug } from '../../../src/lib/taxonomy.ts';
import { COUNTRIES } from '../countries.ts';
import { HttpError, fetchWithRetry } from '../http.ts';
import { FALLBACK_MARKER, isFallbackSummary } from '../../../src/lib/summary.ts';
import { looksEnglish, looksForeign, tokenize, truncate } from './text.ts';

export type ProviderName = 'gemini' | 'openai' | 'none';

export interface SummaryInput {
  countryCode: string;
  countryName: string;
  articles: Array<{ publisherName: string; title: string; snippet: string; publishedAt: string }>;
  metrics: {
    viralScore: number;
    publishers: number;
    velocity: number;
    search: number;
    trendKeyword: string | null;
    /** The trending search to target in the title: set only when its words are in the coverage. */
    searchQuery?: string | null;
  };
  previousHeadline?: string;
  /** URL slug of a published story; it is fixed and names the original event. */
  storySlug?: string;
}

export interface SummaryOutput {
  headline: string;
  seoTitle: string;
  metaDescription: string;
  slug: string;
  aiSummaryBullets: string[];
  aiContextParagraph: string;
  whyItIsViral: string;
  categorySlug: CategorySlug;
  entityTags: string[];
}

/** Upper bounds shared by the schema and by `normalizeModelOutput` (which enforces them). */
const LIMITS = {
  headline: 110,
  seoTitle: 90,
  metaDescription: 220,
  slug: 100,
  bullet: 260,
  bullets: 4,
  aiContextParagraph: 1600,
  whyItIsViral: 400,
  tag: 40,
  tags: 4,
} as const;

const outputSchema = z.object({
  headline: z.string().min(20).max(LIMITS.headline),
  seoTitle: z.string().min(10).max(LIMITS.seoTitle),
  metaDescription: z.string().min(60).max(LIMITS.metaDescription),
  slug: z.string().min(3).max(LIMITS.slug),
  aiSummaryBullets: z.array(z.string().min(10).max(LIMITS.bullet)).min(2).max(LIMITS.bullets),
  aiContextParagraph: z.string().min(200).max(LIMITS.aiContextParagraph),
  whyItIsViral: z.string().min(20).max(LIMITS.whyItIsViral),
  categorySlug: z.enum(CATEGORY_SLUGS),
  entityTags: z.array(z.string().min(2).max(LIMITS.tag)).min(1).max(LIMITS.tags),
});

/**
 * Fix over-long fields in a model reply before validation, so one long tag or a slightly
 * wordy headline doesn't throw away an otherwise good summary. Only upper bounds are
 * repaired (word-boundary truncation, extra items dropped); text that is too short, a
 * missing field or an unknown category still fails validation and falls back.
 * Over-long tags are dropped rather than cut (a cut-off name can be wrong), unless that
 * would leave none, in which case the first is shortened.
 */
export function normalizeModelOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  const clip = (key: string, max: number) => {
    if (typeof o[key] === 'string') o[key] = truncate(o[key] as string, max);
  };
  clip('headline', LIMITS.headline);
  clip('seoTitle', LIMITS.seoTitle);
  clip('metaDescription', LIMITS.metaDescription);
  clip('slug', LIMITS.slug);
  clip('aiContextParagraph', LIMITS.aiContextParagraph);
  clip('whyItIsViral', LIMITS.whyItIsViral);
  if (Array.isArray(o.aiSummaryBullets)) {
    o.aiSummaryBullets = o.aiSummaryBullets
      .slice(0, LIMITS.bullets)
      .map((b) => (typeof b === 'string' ? truncate(b, LIMITS.bullet) : b));
  }
  if (Array.isArray(o.entityTags)) {
    const tags = o.entityTags
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim());
    const fitting = tags.filter((t) => t.length <= LIMITS.tag);
    const kept =
      fitting.length > 0 ? fitting : tags.slice(0, 1).map((t) => truncate(t, LIMITS.tag));
    o.entityTags = kept.slice(0, LIMITS.tags);
  }
  return o;
}

const SYSTEM_PROMPT = `You are the EarthViral Intelligence Desk, writing neutral, factual summaries of trending news clusters for a global audience.

Rules:
- Use ONLY facts stated in the supplied headlines and snippets. Never add facts, numbers, quotes, motives or outcomes that are not in the input. If sources disagree, say so.
- Paraphrase. Do not copy any sentence or headline from a source verbatim.
- Neutral, non-sensational tone. No clickbait, no emotive adjectives, no speculation, no opinions.
- Attribute contested claims ("according to …", "officials said …").
- Do not name private individuals; public figures and institutions are fine.
- Write in clear English, even when sources are in Indonesian or another language.
- If a "Trending search" is given, people are searching Google for exactly that right now. When it names something central to this story, use the searcher's wording for it in seoTitle and metaDescription (e.g. "emergency alerts" rather than "alert system"; names in their original spelling, untranslated). The title must still say what happened and who did it: never drop key names or shorten it to fit the search. If the search is only loosely related to the story, ignore it. Never stuff keywords or add anything the coverage does not support.
- seoTitle is the title searchers see in Google, so name what they would search for: the central person, place, organisation or event (e.g. "[Politician's name] and Two Others Quit [Party]", "Flash Floods Hit [District], [Province]"), not a generic description ("Three Senior Party Officials Resign", "Floods Impact Multiple Regions"). When several are involved, name the best known. The headline should name them too.
- "whyItIsViral" explains the attention using the supplied coverage metrics (number of outlets, coverage pace, search interest) — not the story's moral importance. Describe the metrics in words ("covered by four outlets", "strong search interest"); never quote a score or "/100" figure — scores are recalculated every batch, so a quoted number goes stale.

Field requirements:
- headline: 55–70 characters, factual, title case.
- seoTitle: under 60 characters.
- metaDescription: 140–158 characters.
- slug: 4–8 lowercase English words joined by hyphens, describing the event.
- aiSummaryBullets: exactly 3 concise bullets.
- aiContextParagraph: 120–180 words of background and context, strictly from the input.
- whyItIsViral: 1–2 sentences.
- categorySlug: exactly one of: ${CATEGORIES.map((c) => `${c.slug} (${c.name})`).join(', ')}.
- entityTags: 2–4 recurring named entities (organisations, places, events, public figures, topics). No country names alone.`;

function userPrompt(input: SummaryInput): string {
  const lines = input.articles
    .slice(0, 12)
    .map(
      (a, i) =>
        `${i + 1}. [${a.publisherName}, ${a.publishedAt}] ${a.title}${a.snippet ? `\n   ${a.snippet}` : ''}`,
    )
    .join('\n');
  return `Country: ${input.countryName} (${input.countryCode})
Coverage metrics: ${input.metrics.publishers} independent outlets; coverage velocity ${input.metrics.velocity}/100; public search signal ${input.metrics.search}/100${input.metrics.trendKeyword ? ` (matched Google Trends search: "${input.metrics.trendKeyword}")` : ''}; Viral Activity Score ${input.metrics.viralScore}/100.
${input.metrics.searchQuery ? `Trending search: "${input.metrics.searchQuery}" (see rules: use its wording only if it is central to this story).\n` : ''}${input.previousHeadline ? `Previous headline for this story: ${input.previousHeadline}\nThis page's URL is fixed to that event: keep the headline about the same event, updating only details the new coverage changes. Ignore any article that is about a different event.\n` : ''}${input.storySlug ? `This page's URL words: "${input.storySlug.replaceAll('-', ' ')}". Keep the specific names that identify this event (people, places, organisations) in headline and seoTitle; do not generalise them away.\n` : ''}
Coverage in this cluster:
${lines}

Return the JSON object.`;
}

// ── JSON schemas for the two providers ──────────────────────────────────────

const OPENAI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'headline',
    'seoTitle',
    'metaDescription',
    'slug',
    'aiSummaryBullets',
    'aiContextParagraph',
    'whyItIsViral',
    'categorySlug',
    'entityTags',
  ],
  properties: {
    headline: { type: 'string' },
    seoTitle: { type: 'string' },
    metaDescription: { type: 'string' },
    slug: { type: 'string' },
    aiSummaryBullets: { type: 'array', items: { type: 'string' } },
    aiContextParagraph: { type: 'string' },
    whyItIsViral: { type: 'string' },
    categorySlug: { type: 'string', enum: [...CATEGORY_SLUGS] },
    entityTags: { type: 'array', items: { type: 'string' } },
  },
} as const;

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  required: OPENAI_SCHEMA.required,
  propertyOrdering: OPENAI_SCHEMA.required,
  properties: {
    headline: { type: 'STRING' },
    seoTitle: { type: 'STRING' },
    metaDescription: { type: 'STRING' },
    slug: { type: 'STRING' },
    aiSummaryBullets: { type: 'ARRAY', items: { type: 'STRING' } },
    aiContextParagraph: { type: 'STRING' },
    whyItIsViral: { type: 'STRING' },
    categorySlug: { type: 'STRING', format: 'enum', enum: [...CATEGORY_SLUGS] },
    entityTags: { type: 'ARRAY', items: { type: 'STRING' } },
  },
};

// ── Providers ───────────────────────────────────────────────────────────────

/** A structured-output request: prompts plus the reply's JSON schema in each provider's dialect. */
export interface JsonPrompt {
  /** Schema name (OpenAI `json_schema.name`). */
  name: string;
  system: string;
  user: string;
  openAiSchema: object;
  geminiSchema: object;
}

const summaryPrompt = (input: SummaryInput): JsonPrompt => ({
  name: 'cluster_summary',
  system: SYSTEM_PROMPT,
  user: userPrompt(input),
  openAiSchema: OPENAI_SCHEMA,
  geminiSchema: GEMINI_SCHEMA,
});

/**
 * Gemini 3+ models are tuned for the default temperature (1.0); Google warns that lowering
 * it can cause looping or degraded output, so it is only set for Gemini 2.x and older.
 */
export function usesDefaultTemperature(model: string): boolean {
  const major = /^gemini-(\d+)/i.exec(model)?.[1];
  return major !== undefined && Number(major) >= 3;
}

interface GeminiRequestBody {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
  generationConfig: {
    temperature?: number;
    responseMimeType: 'application/json';
    responseSchema: object;
  };
}

export function geminiRequestBody(input: SummaryInput, model: string): GeminiRequestBody {
  return geminiJsonBody(summaryPrompt(input), model);
}

function geminiJsonBody(prompt: JsonPrompt, model: string): GeminiRequestBody {
  return {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
    generationConfig: {
      ...(usesDefaultTemperature(model) ? {} : { temperature: 0.2 }),
      responseMimeType: 'application/json',
      responseSchema: prompt.geminiSchema,
    },
  };
}

/**
 * The Gemini quota a 429 reply says was exceeded (`QuotaFailure.violations[].quotaId`, e.g.
 * `GenerateRequestsPerDayPerProjectPerModel-FreeTier`). Its message is the same for the
 * per-minute and the per-day limit, so this is the only way to tell them apart.
 */
export function quotaIds(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as {
      error?: { details?: Array<{ violations?: Array<{ quotaId?: string }> }> };
    };
    const ids = (parsed.error?.details ?? [])
      .flatMap((d) => d.violations ?? [])
      .map((v) => v.quotaId)
      .filter((id): id is string => Boolean(id));
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * Set once a Gemini call hits a per-day quota. It only resets at midnight Pacific, so the
 * rest of the run skips Gemini (falling back to non-AI text) instead of retrying every story.
 */
let geminiDailyQuotaHit: string | null = null;

/** For tests: forget a daily-quota stop from an earlier call. */
export function resetGeminiQuotaStop(): void {
  geminiDailyQuotaHit = null;
}

async function callGemini(prompt: JsonPrompt, apiKey: string, model: string): Promise<unknown> {
  if (geminiDailyQuotaHit) {
    throw new AiResponseError(
      'rate-limit',
      `skipped: daily quota ${geminiDailyQuotaHit} already exhausted this run`,
    );
  }
  let res: Response;
  try {
    res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(geminiJsonBody(prompt, model)),
        timeoutMs: 60_000,
        retries: 2,
        backoffMs: 4_000,
      },
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) {
      const daily = quotaIds(err.body).find((id) => /PerDay/i.test(id));
      if (daily) geminiDailyQuotaHit = daily;
    }
    throw err;
  }
  const body = (await res.json()) as {
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
    promptFeedback?: { blockReason?: string };
  };
  const candidate = body.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text.trim()) {
    const why = body.promptFeedback?.blockReason
      ? `blocked: ${body.promptFeedback.blockReason}`
      : `finishReason: ${candidate?.finishReason ?? 'none'}`;
    throw new AiResponseError('empty', `no text in response (${why})`);
  }
  return parseModelJson(text);
}

/**
 * Reasoning models (gpt-5 family, o-series) reject a custom `temperature`; they take
 * `reasoning_effort` instead. "low" keeps hidden reasoning tokens — which count toward
 * usage and the free data-sharing quota — small for this extraction-style task.
 */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

interface OpenAiRequestBody {
  model: string;
  temperature?: number;
  reasoning_effort?: 'low';
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  response_format: {
    type: 'json_schema';
    json_schema: { name: string; strict: boolean; schema: object };
  };
}

export function openAiRequestBody(input: SummaryInput, model: string): OpenAiRequestBody {
  return openAiJsonBody(summaryPrompt(input), model);
}

function openAiJsonBody(prompt: JsonPrompt, model: string): OpenAiRequestBody {
  return {
    model,
    ...(isReasoningModel(model) ? { reasoning_effort: 'low' } : { temperature: 0.2 }),
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: prompt.name, strict: true, schema: prompt.openAiSchema },
    },
  };
}

async function callOpenAI(prompt: JsonPrompt, apiKey: string, model: string): Promise<unknown> {
  const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(openAiJsonBody(prompt, model)),
    timeoutMs: 90_000, // reasoning models can take longer
    retries: 2,
    backoffMs: 4_000,
  });
  const body = (await res.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string; refusal?: string } }>;
  };
  const choice = body.choices?.[0];
  if (choice?.message?.refusal) throw new AiResponseError('refusal', choice.message.refusal);
  const text = choice?.message?.content ?? '';
  if (!text.trim()) {
    throw new AiResponseError(
      'empty',
      `no content (finish_reason: ${choice?.finish_reason ?? 'none'})`,
    );
  }
  return parseModelJson(text);
}

// ── Non-AI fallback ─────────────────────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<CategorySlug, string[]> = {
  'politics-government': [
    'election',
    'minister',
    'president',
    'parliament',
    'government',
    'policy',
    'vote',
    'senate',
    'pemilu',
    'menteri',
    'presiden',
    'dpr',
    'pemerintah',
    'kebijakan',
    'partai',
    'party',
    'cabinet',
    'kabinet',
    'diplomat',
    'summit',
  ],
  'crime-law': [
    'police',
    'court',
    'arrest',
    'arrested',
    'murder',
    'trial',
    'judge',
    'prison',
    'fraud',
    'corruption',
    'polisi',
    'pengadilan',
    'ditangkap',
    'korupsi',
    'kpk',
    'hakim',
    'penjara',
    'tersangka',
    'kejaksaan',
    'crime',
    'sentenced',
  ],
  'economy-business': [
    'economy',
    'inflation',
    'rate',
    'bank',
    'stocks',
    'market',
    'trade',
    'tariff',
    'investment',
    'rupiah',
    'ekonomi',
    'inflasi',
    'saham',
    'investasi',
    'harga',
    'prices',
    'gdp',
    'company',
    'profit',
    'ihsg',
    'bisnis',
  ],
  'technology-ai': [
    'ai',
    'artificial',
    'tech',
    'technology',
    'chip',
    'software',
    'startup',
    'cyber',
    'data',
    'app',
    'teknologi',
    'digital',
    'internet',
    'robot',
    'semiconductor',
    'smartphone',
    'openai',
  ],
  sports: [
    'football',
    'soccer',
    'match',
    'league',
    'cup',
    'olympic',
    'olympics',
    'cricket',
    'tennis',
    'coach',
    'timnas',
    'sepak',
    'bola',
    'liga',
    'pemain',
    'pertandingan',
    'badminton',
    'motogp',
    'f1',
    'goal',
    'win',
    'wins',
  ],
  'entertainment-celebrity': [
    'film',
    'movie',
    'music',
    'singer',
    'actor',
    'actress',
    'celebrity',
    'concert',
    'album',
    'netflix',
    'series',
    'artis',
    'penyanyi',
    'konser',
    'kpop',
    'drama',
    'box',
    'office',
  ],
  'social-issues': [
    'protest',
    'rights',
    'education',
    'health',
    'poverty',
    'migrants',
    'refugees',
    'workers',
    'strike',
    'demo',
    'unjuk',
    'rasa',
    'pendidikan',
    'kesehatan',
    'buruh',
    'hospital',
    'school',
    'students',
  ],
  'disasters-world-events': [
    'earthquake',
    'flood',
    'floods',
    'storm',
    'typhoon',
    'cyclone',
    'wildfire',
    'fire',
    'volcano',
    'war',
    'attack',
    'strike',
    'killed',
    'dead',
    'gempa',
    'banjir',
    'longsor',
    'erupsi',
    'kebakaran',
    'tsunami',
    'disaster',
    'bencana',
    'ceasefire',
    'military',
  ],
  'lifestyle-culture': [
    'food',
    'travel',
    'fashion',
    'culture',
    'festival',
    'tourism',
    'wisata',
    'kuliner',
    'budaya',
    'religion',
    'ramadan',
    'lebaran',
    'holiday',
    'art',
    'museum',
  ],
};

function guessCategory(text: string): CategorySlug {
  const tokens = tokenize(text);
  let best: CategorySlug = 'social-issues';
  let bestHits = 0;
  for (const [slug, words] of Object.entries(CATEGORY_KEYWORDS) as Array<
    [CategorySlug, string[]]
  >) {
    const hits = tokens.filter((t) => words.includes(t)).length;
    if (hits > bestHits) {
      best = slug;
      bestHits = hits;
    }
  }
  return best;
}

const COUNTRY_WORDS = new Set(COUNTRIES.flatMap((c) => c.aliases.map((a) => a.toLowerCase())));

/**
 * Capitalised 1–3 word phrases that recur across ≥ 2 headlines. Every sub-phrase of each
 * capitalised run is counted, because Title Case headlines ("Bank Indonesia Tahan Suku
 * Bunga") would otherwise never repeat exactly. Country names alone and phrases contained
 * in a longer selected phrase are dropped.
 */
function guessEntityTags(titles: string[]): string[] {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const phrases = new Set<string>();
    for (const run of title.match(/[A-Z][\p{L}\p{N}'’-]*(?:\s+[A-Z][\p{L}\p{N}'’-]*)*/gu) ?? []) {
      const words = run.split(/\s+/);
      for (let n = 1; n <= 3; n++) {
        for (let i = 0; i + n <= words.length; i++) phrases.add(words.slice(i, i + n).join(' '));
      }
    }
    for (const p of phrases) {
      if (p.length < 3 || COUNTRY_WORDS.has(p.toLowerCase()) || tokenize(p).length === 0) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  const recurring = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].split(' ').length - a[0].split(' ').length);
  const picked: string[] = [];
  for (const [p] of recurring) {
    if (picked.some((q) => q.includes(p))) continue;
    picked.push(p);
    if (picked.length === 3) break;
  }
  return picked;
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// Shared with the site, which keeps fallback stories off the homepage.
export { FALLBACK_MARKER, isFallbackSummary };

/**
 * True when a failed AI call must not replace a story's stored text: the story keeps its URL
 * and its AI-written text (still about the same event) instead of dropping to the non-AI
 * fallback. New and repaired (drifted) stories have no usable text, so they take the fallback.
 */
export function keepsStoredAiText(
  item: { isNew: boolean; existing?: { aiContextParagraph: string } | null },
  output: Pick<SummaryOutput, 'aiContextParagraph'>,
): boolean {
  return (
    !item.isNew && !!item.existing && !isFallbackSummary(item.existing) && isFallbackSummary(output)
  );
}

/** Matches a quoted score ("71/100", "a viral activity score of 52", "search signal score 84"). */
const SCORE_CLAIM = /\b\d{1,3}\s*\/\s*100\b|\b(?:score|signal)\b[^.]{0,25}?\b\d{1,3}\b/i;

export function hasScoreClaim(text: string): boolean {
  return SCORE_CLAIM.test(text);
}

/** Metric-based "why it is viral" sentence with no score figures (they change every batch). */
export function describeAttention(input: Pick<SummaryInput, 'countryName' | 'metrics'>): string {
  return (
    `${input.metrics.publishers} independent ${input.metrics.publishers === 1 ? 'outlet is' : 'outlets are'} covering this story` +
    (input.metrics.velocity >= 50 ? ', with coverage accelerating in the latest batch' : '') +
    (input.metrics.trendKeyword
      ? `, and "${input.metrics.trendKeyword}" is trending in Google searches in ${input.countryName}.`
      : '.')
  );
}

export function heuristicSummary(input: SummaryInput): SummaryOutput {
  const publishers = [...new Set(input.articles.map((a) => a.publisherName))];
  // Representative headline: the article sharing the most tokens with the rest of the cluster.
  const tokenSets = input.articles.map((a) => new Set(tokenize(a.title)));
  const centrality = input.articles.map((_, i) =>
    tokenSets.reduce(
      (sum, other, j) =>
        j === i ? sum : sum + [...tokenSets[i]!].filter((t) => other.has(t)).length,
      0,
    ),
  );
  const ranked = input.articles.map((a, i) => ({ a, c: centrality[i]! })).sort((x, y) => y.c - x.c);
  // The site is in English and the fallback cannot translate: when the most central headline
  // is in another language, use the most central English one, if the cluster has one.
  const central = ranked[0]?.a ?? input.articles[0]!;
  const lead = looksForeign(central.title)
    ? (ranked.find((r) => looksEnglish(r.a.title))?.a ?? central)
    : central;

  // One bullet per outlet, using that outlet's most central (most on-topic) headline,
  // with the lead's outlet first, then the outlets carrying the most on-topic coverage.
  const bulletPublishers = [
    ...new Set([lead.publisherName, ...ranked.map((r) => r.a.publisherName)]),
  ].slice(0, 3);
  const bullets = bulletPublishers.map((name) => {
    const article =
      name === lead.publisherName ? lead : ranked.find((r) => r.a.publisherName === name)!.a;
    return `${name} reports: ${truncate(article.title, 180)}`;
  });
  const firstSeen = input.articles.map((a) => a.publishedAt).sort()[0]!;
  const why = describeAttention(input);
  const context =
    `This story about ${input.countryName} has been reported by ${formatList(publishers.slice(0, 5))}` +
    `${publishers.length > 5 ? ` and ${publishers.length - 5} other outlets` : ''} since ${firstSeen.slice(0, 10)}. ` +
    `EarthViral groups these reports into one cluster and links to each original article below. ` +
    `${FALLBACK_MARKER}, so it lists the reporting rather than synthesising it; ` +
    `read the linked sources for full details.`;
  const headline = truncate(lead.title, 100);

  return {
    headline,
    seoTitle: truncate(headline, 60),
    // Story-specific text first: the metrics sentence alone fills ~158 chars and is the same
    // for every story with the same counts, which made fallback descriptions collide.
    metaDescription: truncate(
      `${/[.!?…]$/.test(lead.title.trim()) ? lead.title : `${lead.title.trim()}.`} ${why}`,
      158,
    ),
    slug: headline,
    aiSummaryBullets: bullets,
    aiContextParagraph: context,
    whyItIsViral: why,
    categorySlug: guessCategory(input.articles.map((a) => `${a.title} ${a.snippet}`).join(' ')),
    entityTags: guessEntityTags(input.articles.map((a) => a.title)),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

// ── Failure classification ──────────────────────────────────────────────────

export type AiFailureCategory =
  | 'rate-limit' // HTTP 429 after retries
  | 'server-error' // HTTP 5xx after retries
  | 'http-error' // other HTTP status (auth, bad request, unknown model…)
  | 'timeout'
  | 'network'
  | 'empty' // no text: safety block, max tokens, etc.
  | 'refusal'
  | 'invalid-json'
  | 'schema' // valid JSON that doesn't match the output schema
  | 'other';

export interface AiFailure {
  category: AiFailureCategory;
  /** Short, key-free description (HTTP status + API message, or failing schema fields). */
  detail: string;
}

class AiResponseError extends Error {
  readonly category: AiFailureCategory;
  constructor(category: AiFailureCategory, message: string) {
    super(message);
    this.category = category;
  }
}

function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AiResponseError('invalid-json', `unparseable JSON: ${text.slice(0, 80)}`);
  }
}

/** Pull the human-readable message out of a provider's JSON error body. */
function apiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON
  }
  return body;
}

export function classifyAiError(err: unknown): AiFailure {
  const clip = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (err instanceof AiResponseError) return { category: err.category, detail: clip(err.message) };
  if (err instanceof HttpError) {
    const category: AiFailureCategory =
      err.status === 429 ? 'rate-limit' : err.status >= 500 ? 'server-error' : 'http-error';
    // The quota name goes before the message so clipping never cuts it off.
    const quota = quotaIds(err.body);
    const status = quota.length ? `HTTP ${err.status} [${quota.join(', ')}]` : `HTTP ${err.status}`;
    return { category, detail: clip(`${status}: ${apiErrorMessage(err.body)}`) };
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return { category: 'timeout', detail: clip(err.message) };
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    const cause = (err as TypeError & { cause?: { code?: string } }).cause?.code;
    return { category: 'network', detail: clip(cause ? `fetch failed (${cause})` : err.message) };
  }
  return { category: 'other', detail: clip(err instanceof Error ? err.message : String(err)) };
}

export type AiProviderName = Exclude<ProviderName, 'none'>;

export interface Summarizer {
  provider: ProviderName;
  model: string | null;
  /** Provider tried when the primary one fails (see resolveFailover), or null. */
  failover: { provider: AiProviderName; model: string } | null;
  summarize(input: SummaryInput): Promise<{
    output: SummaryOutput;
    usedAi: boolean;
    /** Why the text is the non-AI fallback (the last provider's failure). */
    error?: AiFailure;
    /** Set when the primary provider failed and the failover provider was tried. */
    failover?: { from: AiFailure; ok: boolean };
  }>;
}

export function resolveProvider(requested: string | undefined): ProviderName {
  if (requested === 'gemini' || requested === 'openai' || requested === 'none') return requested;
  if (requested)
    throw new Error(`Unknown --provider "${requested}" (expected gemini | openai | none)`);
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

/**
 * The provider to switch to when the primary one fails: OpenAI, for a run that picked Gemini
 * on its own and also has an OpenAI key. Gemini's free tier runs out of daily requests, and
 * every story after that would otherwise get non-AI text. An explicit --provider means that
 * provider only.
 */
export function resolveFailover(
  requested: string | undefined,
  primary: ProviderName,
): AiProviderName | null {
  if (requested || primary !== 'gemini') return null;
  return process.env.OPENAI_API_KEY ? 'openai' : null;
}

/** API key and model for an AI provider, from the environment. Throws when the key is missing. */
export function aiCredentials(provider: Exclude<ProviderName, 'none'>): {
  apiKey: string;
  model: string;
} {
  const apiKey = provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY;
  if (!apiKey)
    throw new Error(
      `--provider ${provider} needs ${provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'} in the environment`,
    );
  const model =
    provider === 'gemini'
      ? process.env.GEMINI_MODEL?.trim() || 'gemini-3.1-flash-lite'
      : process.env.OPENAI_MODEL?.trim() || 'gpt-5-mini';
  // `||`, not `??`: GitHub Actions passes an unset repository variable as an empty string,
  // and an empty model name made every request 404.
  return { apiKey, model };
}

/**
 * One structured-output call to the provider, with the same retries and error types as story
 * summaries. Returns the parsed (unvalidated) JSON; failures throw (see classifyAiError).
 */
export function requestModelJson(
  provider: Exclude<ProviderName, 'none'>,
  prompt: JsonPrompt,
  { apiKey, model } = aiCredentials(provider),
): Promise<unknown> {
  return (provider === 'gemini' ? callGemini : callOpenAI)(prompt, apiKey, model);
}

type SummaryAttempt = { output: SummaryOutput } | { error: AiFailure };

async function trySummary(
  provider: AiProviderName,
  credentials: { apiKey: string; model: string },
  input: SummaryInput,
): Promise<SummaryAttempt> {
  let raw: unknown;
  try {
    raw = await requestModelJson(provider, summaryPrompt(input), credentials);
  } catch (err) {
    return { error: classifyAiError(err) };
  }
  const parsed = outputSchema.safeParse(normalizeModelOutput(raw));
  if (parsed.success) {
    // Quoted scores go stale as soon as the next batch rescoring runs; use the
    // metric-free deterministic sentence instead.
    const output = hasScoreClaim(parsed.data.whyItIsViral)
      ? { ...parsed.data, whyItIsViral: describeAttention(input) }
      : parsed.data;
    return { output };
  }
  // Name the failing fields (e.g. "headline: Too big") instead of Zod's JSON dump.
  const detail = parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { error: { category: 'schema', detail: detail.slice(0, 200) } };
}

export function createSummarizer(
  provider: ProviderName,
  failover: AiProviderName | null = null,
): Summarizer {
  if (provider === 'none') {
    return {
      provider,
      model: null,
      failover: null,
      summarize: async (input) => ({ output: heuristicSummary(input), usedAi: false }),
    };
  }

  const primary = aiCredentials(provider);
  const backup = failover && failover !== provider ? aiCredentials(failover) : null;

  return {
    provider,
    model: primary.model,
    failover: backup && failover ? { provider: failover, model: backup.model } : null,
    async summarize(input) {
      const first = await trySummary(provider, primary, input);
      if ('output' in first) return { output: first.output, usedAi: true };
      if (!backup || !failover) {
        return { output: heuristicSummary(input), usedAi: false, error: first.error };
      }
      const second = await trySummary(failover, backup, input);
      if ('output' in second) {
        return { output: second.output, usedAi: true, failover: { from: first.error, ok: true } };
      }
      return {
        output: heuristicSummary(input),
        usedAi: false,
        error: second.error,
        failover: { from: first.error, ok: false },
      };
    },
  };
}
