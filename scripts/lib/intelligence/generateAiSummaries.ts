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
import { tokenize, truncate } from './text.ts';

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
  };
  previousHeadline?: string;
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

const outputSchema = z.object({
  headline: z.string().min(20).max(110),
  seoTitle: z.string().min(10).max(90),
  metaDescription: z.string().min(60).max(220),
  slug: z.string().min(3).max(100),
  aiSummaryBullets: z.array(z.string().min(10).max(260)).min(2).max(4),
  aiContextParagraph: z.string().min(200).max(1600),
  whyItIsViral: z.string().min(20).max(400),
  categorySlug: z.enum(CATEGORY_SLUGS),
  entityTags: z.array(z.string().min(2).max(40)).min(1).max(4),
});

const SYSTEM_PROMPT = `You are the EarthViral Intelligence Desk, writing neutral, factual summaries of trending news clusters for a global audience.

Rules:
- Use ONLY facts stated in the supplied headlines and snippets. Never add facts, numbers, quotes, motives or outcomes that are not in the input. If sources disagree, say so.
- Paraphrase. Do not copy any sentence or headline from a source verbatim.
- Neutral, non-sensational tone. No clickbait, no emotive adjectives, no speculation, no opinions.
- Attribute contested claims ("according to …", "officials said …").
- Do not name private individuals; public figures and institutions are fine.
- Write in clear English, even when sources are in Indonesian or another language.
- "whyItIsViral" explains the attention using the supplied coverage metrics (number of outlets, coverage pace, search interest) — not the story's moral importance.

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
${input.previousHeadline ? `Previous headline for this story (update it if the new coverage changes the picture): ${input.previousHeadline}\n` : ''}
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
    responseSchema: typeof GEMINI_SCHEMA;
  };
}

export function geminiRequestBody(input: SummaryInput, model: string): GeminiRequestBody {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt(input) }] }],
    generationConfig: {
      ...(usesDefaultTemperature(model) ? {} : { temperature: 0.2 }),
      responseMimeType: 'application/json',
      responseSchema: GEMINI_SCHEMA,
    },
  };
}

async function callGemini(input: SummaryInput, apiKey: string, model: string): Promise<unknown> {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(geminiRequestBody(input, model)),
      timeoutMs: 60_000,
      retries: 2,
      backoffMs: 4_000,
    },
  );
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
    json_schema: { name: string; strict: boolean; schema: typeof OPENAI_SCHEMA };
  };
}

export function openAiRequestBody(input: SummaryInput, model: string): OpenAiRequestBody {
  return {
    model,
    ...(isReasoningModel(model) ? { reasoning_effort: 'low' } : { temperature: 0.2 }),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(input) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'cluster_summary', strict: true, schema: OPENAI_SCHEMA },
    },
  };
}

async function callOpenAI(input: SummaryInput, apiKey: string, model: string): Promise<unknown> {
  const res = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(openAiRequestBody(input, model)),
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
  const lead = ranked[0]?.a ?? input.articles[0]!;

  // One bullet per outlet, using that outlet's most central (most on-topic) headline,
  // with the outlets carrying the most on-topic coverage first.
  const bulletPublishers = [...new Set(ranked.map((r) => r.a.publisherName))].slice(0, 3);
  const bullets = bulletPublishers.map((name) => {
    const article = ranked.find((r) => r.a.publisherName === name)!.a;
    return `${name} reports: ${truncate(article.title, 180)}`;
  });
  const firstSeen = input.articles.map((a) => a.publishedAt).sort()[0]!;
  const why =
    `${input.metrics.publishers} independent ${input.metrics.publishers === 1 ? 'outlet is' : 'outlets are'} covering this story` +
    (input.metrics.velocity >= 50 ? ', with coverage accelerating in the latest batch' : '') +
    (input.metrics.trendKeyword
      ? `, and "${input.metrics.trendKeyword}" is trending in Google searches in ${input.countryName}.`
      : '.');
  const context =
    `This story about ${input.countryName} has been reported by ${formatList(publishers.slice(0, 5))}` +
    `${publishers.length > 5 ? ` and ${publishers.length - 5} other outlets` : ''} since ${firstSeen.slice(0, 10)}. ` +
    `EarthViral groups these reports into one cluster and links to each original article below. ` +
    `This summary was generated without an AI model, so it lists the reporting rather than synthesising it; ` +
    `read the linked sources for full details.`;
  const headline = truncate(lead.title, 100);

  return {
    headline,
    seoTitle: truncate(headline, 60),
    metaDescription: truncate(`${why} ${bullets[0] ?? ''}`, 158),
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
    return { category, detail: clip(`HTTP ${err.status}: ${apiErrorMessage(err.body)}`) };
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

export interface Summarizer {
  provider: ProviderName;
  model: string | null;
  summarize(
    input: SummaryInput,
  ): Promise<{ output: SummaryOutput; usedAi: boolean; error?: AiFailure }>;
}

export function resolveProvider(requested: string | undefined): ProviderName {
  if (requested === 'gemini' || requested === 'openai' || requested === 'none') return requested;
  if (requested)
    throw new Error(`Unknown --provider "${requested}" (expected gemini | openai | none)`);
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

export function createSummarizer(provider: ProviderName): Summarizer {
  if (provider === 'none') {
    return {
      provider,
      model: null,
      summarize: async (input) => ({ output: heuristicSummary(input), usedAi: false }),
    };
  }

  const apiKey = provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY;
  if (!apiKey)
    throw new Error(
      `--provider ${provider} needs ${provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'} in the environment`,
    );
  const model =
    provider === 'gemini'
      ? (process.env.GEMINI_MODEL ?? 'gemini-3.1-flash-lite')
      : (process.env.OPENAI_MODEL ?? 'gpt-5-mini');
  const call = provider === 'gemini' ? callGemini : callOpenAI;

  return {
    provider,
    model,
    async summarize(input) {
      let raw: unknown;
      try {
        raw = await call(input, apiKey, model);
      } catch (err) {
        return { output: heuristicSummary(input), usedAi: false, error: classifyAiError(err) };
      }
      const parsed = outputSchema.safeParse(raw);
      if (parsed.success) return { output: parsed.data, usedAi: true };
      // Name the failing fields (e.g. "headline: Too big") instead of Zod's JSON dump.
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return {
        output: heuristicSummary(input),
        usedAi: false,
        error: { category: 'schema', detail: detail.slice(0, 200) },
      };
    },
  };
}
