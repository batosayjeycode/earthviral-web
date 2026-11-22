/** Daily digest intros: which days get (re)written, reply validation, and the batch step. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MIN_DIGEST_STORIES, buildDigestDays } from '../../src/lib/digest.ts';
import type { DigestSummary, ViralClusterStaticRecord } from '../../src/lib/types.ts';
import {
  digestPrompt,
  generateDigestSummaries,
  parseDigestSummary,
  planDigestSummaries,
} from './intelligence/generateDigestSummaries.ts';

const story = (id: string, day: string, viralScore: number) =>
  ({
    id,
    countryCode: 'ID',
    countryName: 'Indonesia',
    categoryName: 'Sports',
    headline: `Headline ${id}`,
    aiSummaryBullets: [`Bullet for ${id}.`],
    viralScore,
    firstDetectedAt: `${day}T03:00:00Z`,
    lastUpdatedBatchAt: `${day}T03:00:00Z`,
    sources: [],
  }) as unknown as ViralClusterStaticRecord;

const dayOf = (day: string, prefix = day) =>
  Array.from({ length: MIN_DIGEST_STORIES }, (_, i) => story(`${prefix}-${i}`, day, 90 - i));

const summaryFor = (day: string, topIds: string[]): DigestSummary => ({
  day,
  summary: 'Earlier summary.',
  topIds,
  generatedAt: '2026-11-20T00:00:00Z',
  model: 'gemini:test',
});

// 2026-11-22T10:00Z is 17:00 WIB on Nov 22: today = 22nd, yesterday = 21st.
const NOW = new Date('2026-11-22T10:00:00Z');
const clusters = [...dayOf('2026-11-22'), ...dayOf('2026-11-21'), ...dayOf('2026-11-18')];
const days = buildDigestDays(clusters);
const ids = (day: string) => days.find((d) => d.day === day)!.stories.map((c) => c.id);

describe('planDigestSummaries', () => {
  test('writes missing days newest first, within the budget', () => {
    const plan = planDigestSummaries(days, [], NOW, 2);
    assert.deepEqual(
      plan.todo.map((d) => d.day),
      ['2026-11-22', '2026-11-21'],
    );
    assert.equal(plan.pending, 1);
  });

  test('rewrites a recent day only when its top stories changed; older days are final', () => {
    const previous = [
      summaryFor('2026-11-22', ids('2026-11-22')), // unchanged → keep
      summaryFor('2026-11-21', ['other', ...ids('2026-11-21')]), // changed, recent → rewrite
      summaryFor('2026-11-18', ['other']), // changed, but settled → keep
    ];
    const plan = planDigestSummaries(days, previous, NOW, 10);
    assert.deepEqual(
      plan.todo.map((d) => d.day),
      ['2026-11-21'],
    );
  });
});

describe('parseDigestSummary', () => {
  const ok = 'Persib Bandung won a comeback match in Indonesia. '.repeat(8);

  test('accepts a paragraph of the right length and tidies whitespace', () => {
    const r = parseDigestSummary({ summary: `  ${ok}\n` });
    assert.ok('summary' in r);
    assert.equal(r.summary, ok.trim());
  });

  test('rejects too short, too long, wrong shape and quoted scores', () => {
    for (const raw of [
      { summary: 'Too short.' },
      { summary: 'x '.repeat(600) },
      { text: ok },
      null,
      { summary: `${ok} It scored 93/100.` },
    ])
      assert.ok('error' in parseDigestSummary(raw), JSON.stringify(raw).slice(0, 40));
  });
});

test('the prompt lists the top stories with their country', () => {
  const prompt = digestPrompt(days[0]!);
  assert.match(prompt.user, /November 22, 2026/);
  assert.match(prompt.user, /1\. \[Indonesia · Sports\] Headline 2026-11-22-0/);
});

describe('generateDigestSummaries', () => {
  test('without an AI provider, keeps stored summaries of current days and drops the rest', async () => {
    const r = await generateDigestSummaries({
      clusters,
      previous: [summaryFor('2026-11-18', []), summaryFor('2026-10-01', [])],
      provider: 'none',
      now: NOW,
      maxCalls: 5,
    });
    assert.deepEqual(
      r.summaries.map((s) => s.day),
      ['2026-11-18'],
    );
    assert.deepEqual(r.stats, { written: 0, kept: 1, pending: 0, failed: 0 });
  });

  test('writes AI summaries and keeps the old one when a call fails', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const realFetch = globalThis.fetch;
    const good = 'A factory fire in Indonesia led coverage across several outlets. '.repeat(6);
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      const text = call === 1 ? JSON.stringify({ summary: good }) : 'not json';
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    try {
      const r = await generateDigestSummaries({
        clusters,
        previous: [summaryFor('2026-11-21', ['changed'])],
        provider: 'gemini',
        now: NOW,
        maxCalls: 2,
        concurrency: 1,
      });
      assert.equal(r.stats.written, 1);
      assert.equal(r.stats.failed, 1);
      const byDay = new Map(r.summaries.map((s) => [s.day, s]));
      assert.equal(byDay.get('2026-11-22')?.summary, good.trim());
      assert.equal(byDay.get('2026-11-22')?.topIds.length, 10);
      assert.equal(byDay.get('2026-11-21')?.summary, 'Earlier summary.');
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });
});
