/**
 * AI-written intro for each daily digest page (/digest/[day]/): one paragraph on what the
 * world was talking about that day, written from the day's top stories only.
 *
 * Summaries are stored in `src/data/generated/digest-summaries.json` and reused across
 * batches. A day is (re)written when it has no summary yet, or — while it is still recent
 * (today or yesterday, WIB) — when its top stories have changed. Older summaries are final.
 * Each batch writes at most `maxCalls` of them, newest day first, so a backlog is worked off
 * over a few batches. Without an AI provider nothing is written and pages show no intro.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'astro/zod';
import {
  DIGEST_TOP,
  buildDigestDays,
  formatDayLong,
  wibDay,
  type DigestDay,
} from '../../../src/lib/digest.ts';
import type { DigestSummary, ViralClusterStaticRecord } from '../../../src/lib/types.ts';
import { mapLimit } from '../http.ts';
import {
  aiCredentials,
  classifyAiError,
  hasScoreClaim,
  requestModelJson,
  type AiFailure,
  type AiProviderName,
  type JsonPrompt,
  type ProviderName,
} from './generateAiSummaries.ts';

export const DIGEST_SUMMARIES_PATH = join('src', 'data', 'generated', 'digest-summaries.json');

/** Top stories compared to decide whether a recent day's summary is out of date. */
const TOP_KEY = 5;
/** Days younger than this (today = 0, yesterday = 1) are still changing. */
const SETTLING_DAYS = 2;
const DAY_MS = 86_400_000;

export const digestSummarySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  summary: z.string().min(1),
  topIds: z.array(z.string()),
  generatedAt: z.string(),
  model: z.string(),
});

/** Stored summaries; a missing or unreadable file means none. */
export async function loadDigestSummaries(root: string): Promise<DigestSummary[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(root, DIGEST_SUMMARIES_PATH), 'utf8'));
    return z.array(digestSummarySchema).parse(raw);
  } catch {
    return [];
  }
}

const topKey = (d: DigestDay) =>
  d.stories
    .slice(0, TOP_KEY)
    .map((c) => c.id)
    .join('|');

const ageInDays = (day: string, today: string) =>
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS);

export interface DigestSummaryPlan {
  /** Days to (re)write this batch, newest first. */
  todo: DigestDay[];
  /** Days that need a summary but are over this batch's budget. */
  pending: number;
}

export function planDigestSummaries(
  days: DigestDay[],
  previous: DigestSummary[],
  now: Date,
  maxCalls: number,
): DigestSummaryPlan {
  const prevByDay = new Map(previous.map((s) => [s.day, s]));
  const today = wibDay(now.toISOString());
  const needs = days.filter((d) => {
    const prev = prevByDay.get(d.day);
    if (!prev) return true;
    if (ageInDays(d.day, today) >= SETTLING_DAYS) return false;
    return prev.topIds.slice(0, TOP_KEY).join('|') !== topKey(d);
  });
  const todo = needs.slice(0, Math.max(0, maxCalls));
  return { todo, pending: needs.length - todo.length };
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const LIMITS = { min: 300, max: 1000 } as const;

const SYSTEM_PROMPT = `You are the EarthViral Intelligence Desk. You write the short introduction of a daily round-up page listing the most viral news stories worldwide on one day.

Rules:
- Use ONLY facts stated in the supplied story headlines and summaries. Never add facts, numbers, quotes, motives or outcomes that are not in the input.
- Neutral, non-sensational tone. No clickbait, no emotive adjectives, no speculation, no opinions.
- No filler or verdicts on importance ("a significant development", "making headlines", "underscoring"): state what happened.
- Do not name private individuals; public figures and institutions are fine.
- Never quote a score, rank number or "/100" figure.
- Write in clear English.

Write one paragraph of 70–110 words that:
- opens with the day's leading story and where it happened;
- covers 3–5 of the top stories, naming their countries;
- mentions a common thread across stories or countries only when the input clearly shows one.
Do not start with "Today", "On this day" or the date, and do not address the reader.`;

function userPrompt(d: DigestDay): string {
  const byCategory = new Map<string, number>();
  for (const c of d.stories)
    byCategory.set(c.categoryName, (byCategory.get(c.categoryName) ?? 0) + 1);
  const categories = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
  const stories = d.stories
    .slice(0, DIGEST_TOP)
    .map(
      (c, i) =>
        `${i + 1}. [${c.countryName} · ${c.categoryName}] ${c.headline}\n` +
        c.aiSummaryBullets
          .slice(0, 2)
          .map((b) => `   - ${b}`)
          .join('\n'),
    )
    .join('\n');
  return `Day: ${formatDayLong(d.day)} (Western Indonesian Time)
${d.stories.length} viral stories from ${d.countryCount} countries. Stories by category: ${categories}.

Top stories, most viral first:
${stories}

Return the JSON object.`;
}

export function digestPrompt(d: DigestDay): JsonPrompt {
  return {
    name: 'digest_summary',
    system: SYSTEM_PROMPT,
    user: userPrompt(d),
    openAiSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary'],
      properties: { summary: { type: 'string' } },
    },
    geminiSchema: {
      type: 'OBJECT',
      required: ['summary'],
      properties: { summary: { type: 'STRING' } },
    },
  };
}

const outputSchema = z.object({
  summary: z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(LIMITS.min).max(LIMITS.max)),
});

/** The validated summary text, or a failure (bad shape, wrong length, quoted score). */
export function parseDigestSummary(raw: unknown): { summary: string } | { error: AiFailure } {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 2)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { error: { category: 'schema', detail: detail.slice(0, 200) } };
  }
  if (hasScoreClaim(parsed.data.summary))
    return { error: { category: 'schema', detail: 'summary quotes a score' } };
  return { summary: parsed.data.summary };
}

// ── Batch step ──────────────────────────────────────────────────────────────

export interface DigestSummaryResult {
  /** Summaries for every current digest day that has one, newest first. */
  summaries: DigestSummary[];
  stats: { written: number; kept: number; pending: number; failed: number };
  failures: AiFailure[];
  /** Days the primary provider failed and the failover provider was tried (see resolveFailover). */
  failovers: Array<{ from: AiFailure; ok: boolean }>;
}

export async function generateDigestSummaries(opts: {
  clusters: ViralClusterStaticRecord[];
  previous: DigestSummary[];
  provider: ProviderName;
  /** Provider to try when the primary one fails. */
  failover?: AiProviderName | null;
  now: Date;
  maxCalls: number;
  concurrency?: number;
  log?: (msg: string) => void;
}): Promise<DigestSummaryResult> {
  const { provider, now, log = () => {} } = opts;
  const days = buildDigestDays(opts.clusters);
  const plan =
    provider === 'none'
      ? { todo: [], pending: 0 }
      : planDigestSummaries(days, opts.previous, now, opts.maxCalls);

  const written = new Map<string, DigestSummary>();
  const failures: AiFailure[] = [];
  const failovers: DigestSummaryResult['failovers'] = [];
  if (provider !== 'none' && plan.todo.length > 0) {
    const routes = [provider, opts.failover]
      .filter((p): p is AiProviderName => Boolean(p))
      .filter((p, i, all) => all.indexOf(p) === i)
      .map((p) => ({ provider: p, credentials: aiCredentials(p) }));
    await mapLimit(plan.todo, opts.concurrency ?? 2, async (d) => {
      let result: ReturnType<typeof parseDigestSummary> = {
        error: { category: 'other', detail: 'not attempted' },
      };
      let model = '';
      for (const [i, route] of routes.entries()) {
        const previous = 'error' in result ? result.error : null;
        try {
          result = parseDigestSummary(
            await requestModelJson(route.provider, digestPrompt(d), route.credentials),
          );
        } catch (err) {
          result = { error: classifyAiError(err) };
        }
        if (i > 0 && previous) failovers.push({ from: previous, ok: !('error' in result) });
        if (!('error' in result)) {
          model = `${route.provider}:${route.credentials.model}`;
          break;
        }
      }
      if ('error' in result) {
        failures.push(result.error);
        log(
          `  ! digest summary failed (${d.day}) [${result.error.category}]: ${result.error.detail}`,
        );
        return;
      }
      written.set(d.day, {
        day: d.day,
        summary: result.summary,
        topIds: d.stories.slice(0, DIGEST_TOP).map((c) => c.id),
        generatedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        model,
      });
    });
  }

  // Keep a day's earlier summary when it wasn't rewritten (settled, over budget or failed);
  // days without a digest page any more are dropped.
  const prevByDay = new Map(opts.previous.map((s) => [s.day, s]));
  const summaries = days
    .map((d) => written.get(d.day) ?? prevByDay.get(d.day))
    .filter((s): s is DigestSummary => Boolean(s));
  return {
    summaries,
    stats: {
      written: written.size,
      kept: summaries.length - written.size,
      pending: plan.pending + failures.length,
      failed: failures.length,
    },
    failures,
    failovers,
  };
}
