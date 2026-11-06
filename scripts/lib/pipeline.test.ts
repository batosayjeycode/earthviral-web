/** Unit tests for the batch pipeline. Run: `npm test` (node:test, no extra deps). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectCountry, mentionedCountries } from './intelligence/detectCountry.ts';
import {
  clusterArticles,
  dedupeArticles,
  type CountryArticle,
} from './intelligence/deduplicateAndCluster.ts';
import {
  computeViralScore,
  coverageScore,
  velocityScore,
} from './intelligence/computeViralScore.ts';
import { heuristicSummary } from './intelligence/generateAiSummaries.ts';
import { parseFeed } from './fetchers/fetchRss.ts';
import { parseTrendsFeed } from './fetchers/fetchGoogleTrends.ts';
import { nextWibBoundary } from './builders/writeStaticJson.ts';
import { slugify, tokenize, truncate } from './intelligence/text.ts';

const NOW = new Date('2026-11-06T03:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function article(
  over: Partial<CountryArticle> & { title: string; publisherDomain: string },
): CountryArticle {
  return {
    countryCode: 'ID',
    url: `https://${over.publisherDomain}/${encodeURIComponent(over.title)}`,
    snippet: '',
    publishedAt: hoursAgo(1),
    publisherName: over.publisherDomain,
    ...over,
  };
}

describe('detectCountry', () => {
  it('keeps national outlets on their home country by default', () => {
    assert.equal(detectCountry('Harga beras naik di pasar tradisional', '', 'ID'), 'ID');
  });
  it('moves a national-outlet story to the single other country named', () => {
    assert.equal(detectCountry('Gempa magnitudo 6 guncang Jepang', '', 'ID'), 'JP');
  });
  it('stays home when the home country is also named', () => {
    assert.equal(detectCountry('Indonesia dan Jepang teken kerja sama energi', '', 'ID'), 'ID');
  });
  it('attributes global wires to the first named country, or drops them', () => {
    assert.equal(detectCountry('Floods in Brazil displace thousands', '', null), 'BR');
    assert.equal(detectCountry('Markets steady as investors wait', '', null), null);
  });
  it('does not treat lower-case "us"/"as" as country codes', () => {
    assert.deepEqual(mentionedCountries('Tell us as soon as possible'), []);
    assert.deepEqual(mentionedCountries('US Senate passes bill'), ['US']);
  });
  it('prefers "South Africa" over nothing and avoids partial-word matches', () => {
    assert.deepEqual(mentionedCountries('South Africa wins'), ['ZA']);
    assert.deepEqual(mentionedCountries('Indianapolis weather'), []);
  });
});

describe('clustering', () => {
  it('groups headlines about the same event and separates unrelated ones', () => {
    const clusters = clusterArticles(
      [
        article({
          title: 'Timnas Indonesia menang dramatis atas Arab Saudi di kualifikasi Piala Dunia',
          publisherDomain: 'antaranews.com',
          publishedAt: hoursAgo(3),
        }),
        article({
          title: 'Kualifikasi Piala Dunia: Timnas Indonesia tumbangkan Arab Saudi',
          publisherDomain: 'detik.com',
          publishedAt: hoursAgo(2),
        }),
        article({
          title: 'Timnas Indonesia kalahkan Arab Saudi, peluang Piala Dunia terbuka',
          publisherDomain: 'tempo.co',
          publishedAt: hoursAgo(1),
        }),
        article({
          title: 'Bank Indonesia pertahankan suku bunga acuan 5,75 persen',
          publisherDomain: 'cnbcindonesia.com',
        }),
      ],
      [],
    );
    const sizes = clusters.map((c) => c.articles.length).sort();
    assert.deepEqual(sizes, [1, 3]);
  });
  it('never clusters across countries', () => {
    const clusters = clusterArticles(
      [
        article({
          title: 'Heavy floods hit capital after record rainfall',
          publisherDomain: 'a.com',
          countryCode: 'ID',
        }),
        article({
          title: 'Heavy floods hit capital after record rainfall',
          publisherDomain: 'b.com',
          countryCode: 'MY',
        }),
      ],
      [],
    );
    assert.equal(clusters.length, 2);
  });
  it('dedupes identical URLs and same-publisher reposts', () => {
    const a = article({ title: 'Same headline here today', publisherDomain: 'x.com' });
    assert.equal(dedupeArticles([a, { ...a }, { ...a, url: 'https://x.com/other' }]).length, 1);
  });
});

describe('viral score', () => {
  it('rises with publisher breadth and recency', () => {
    assert.ok(coverageScore(8) > coverageScore(3));
    assert.ok(
      velocityScore([hoursAgo(1), hoursAgo(1)], NOW) >
        velocityScore([hoursAgo(30), hoursAgo(30)], NOW),
    );
  });
  it('stays within 0–100 and rewards a matching Google Trends search', () => {
    const [cluster] = clusterArticles(
      ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'].map((d) =>
        article({
          title: 'Timnas Indonesia lolos ke putaran final Piala Asia',
          publisherDomain: d,
          url: `https://${d}/x`,
        }),
      ),
      [],
    );
    const without = computeViralScore(cluster!, [], NOW);
    const withTrend = computeViralScore(
      cluster!,
      [{ country: 'ID', keyword: 'timnas indonesia', traffic: 200_000, newsTitles: [] }],
      NOW,
    );
    assert.ok(withTrend.viralScore > without.viralScore);
    assert.ok(withTrend.viralScore <= 100 && without.viralScore >= 0);
    assert.equal(withTrend.publishers, 5);
  });
});

describe('feeds', () => {
  it('parses RSS items, strips HTML and tracking params, clamps future dates', () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[Banjir rendam <b>ribuan</b> rumah di Jakarta]]></title>
        <link>https://x.com/a?utm_source=rss&amp;id=1</link><description>&lt;p&gt;Snippet&lt;/p&gt;</description>
        <pubDate>Fri, 06 Nov 2099 01:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const [a] = parseFeed(
      xml,
      {
        id: 't',
        publisherName: 'T',
        publisherDomain: 'x.com',
        url: '',
        homeCountry: 'ID',
        language: 'id',
      },
      NOW,
    );
    assert.equal(a?.title, 'Banjir rendam ribuan rumah di Jakarta');
    assert.equal(a?.url, 'https://x.com/a?id=1');
    assert.equal(a?.snippet, 'Snippet');
    assert.ok(Date.parse(a!.publishedAt) <= NOW.getTime());
  });
  it('parses Atom entries', () => {
    const xml = `<feed><entry><title>Atom headline about Japan politics</title><link rel="alternate" href="https://y.com/1"/>
      <updated>2026-11-06T01:00:00Z</updated></entry></feed>`;
    const [a] = parseFeed(
      xml,
      {
        id: 't',
        publisherName: 'Y',
        publisherDomain: 'y.com',
        url: '',
        homeCountry: null,
        language: 'en',
      },
      NOW,
    );
    assert.equal(a?.url, 'https://y.com/1');
  });
  it('parses Google Trends traffic and news items', () => {
    const xml = `<rss xmlns:ht="x"><channel><item><title>timnas</title><ht:approx_traffic>200,000+</ht:approx_traffic>
      <ht:news_item><ht:news_item_title>Timnas menang</ht:news_item_title></ht:news_item></item></channel></rss>`;
    const [t] = parseTrendsFeed(xml, 'ID');
    assert.deepEqual(t, {
      country: 'ID',
      keyword: 'timnas',
      traffic: 200000,
      newsTitles: ['Timnas menang'],
    });
  });
});

describe('fallback summary', () => {
  it('produces valid fields without inventing content', () => {
    const out = heuristicSummary({
      countryCode: 'ID',
      countryName: 'Indonesia',
      articles: [
        {
          publisherName: 'Antara',
          title: 'Bank Indonesia Pertahankan Suku Bunga',
          snippet: '',
          publishedAt: hoursAgo(2),
        },
        {
          publisherName: 'CNBC Indonesia',
          title: 'Bank Indonesia Tahan Suku Bunga Acuan',
          snippet: '',
          publishedAt: hoursAgo(1),
        },
      ],
      metrics: { viralScore: 55, publishers: 2, velocity: 60, search: 0, trendKeyword: null },
    });
    assert.equal(out.categorySlug, 'economy-business');
    assert.equal(out.aiSummaryBullets.length, 2);
    assert.ok(out.aiSummaryBullets[0]!.startsWith('Antara reports:'));
    assert.ok(out.seoTitle.length <= 60 && out.metaDescription.length <= 158);
    assert.deepEqual(out.entityTags, ['Bank Indonesia', 'Suku Bunga']); // recurring phrases, longest/most frequent first
  });
});

describe('utilities', () => {
  it('computes the next WIB 3-hour boundary', () => {
    // 2026-11-06 10:20 WIB = 03:20Z → next boundary 12:00 WIB = 05:00Z
    assert.equal(
      nextWibBoundary(new Date('2026-11-06T03:20:00Z')).toISOString(),
      '2026-11-06T05:00:00.000Z',
    );
    // exactly on a boundary → the following one
    assert.equal(
      nextWibBoundary(new Date('2026-11-05T17:00:00Z')).toISOString(),
      '2026-11-05T20:00:00.000Z',
    );
  });
  it('slugifies to ASCII and truncates on word boundaries', () => {
    assert.equal(slugify('São Paulo Floods: What We Know'), 'sao-paulo-floods-what-we-know');
    assert.equal(truncate('one two three four five six', 15), 'one two three…');
    assert.deepEqual(tokenize('東京 の ニュース').length > 0, true);
  });
});

describe('AI providers (fetch stubbed)', async () => {
  const { createSummarizer } = await import('./intelligence/generateAiSummaries.ts');
  const input = {
    countryCode: 'ID',
    countryName: 'Indonesia',
    articles: [
      {
        publisherName: 'Antara',
        title: 'Bank Indonesia holds benchmark rate at 5.75 percent',
        snippet: '',
        publishedAt: hoursAgo(1),
      },
    ],
    metrics: { viralScore: 70, publishers: 3, velocity: 80, search: 0, trendKeyword: null },
  };
  const good = {
    headline: 'Bank Indonesia Holds Benchmark Rate Steady Amid Rupiah Pressure',
    seoTitle: 'Bank Indonesia Holds Benchmark Rate Steady',
    metaDescription:
      'Bank Indonesia kept its benchmark interest rate unchanged, according to three outlets, as markets watched the rupiah and inflation outlook closely.',
    slug: 'bank-indonesia-holds-benchmark-rate',
    aiSummaryBullets: [
      'Bank Indonesia kept its policy rate unchanged.',
      'Outlets linked the decision to currency stability.',
      'Analysts discussed the outlook for lending.',
    ],
    aiContextParagraph:
      'Bank Indonesia announced its monthly policy decision, keeping the benchmark rate unchanged according to the outlets in this cluster. '.repeat(
        3,
      ),
    whyItIsViral:
      'Three outlets covered the decision within hours, giving it a fast coverage pace.',
    categorySlug: 'economy-business',
    entityTags: ['Bank Indonesia', 'Rupiah'],
  };
  const realFetch = globalThis.fetch;
  const stub = (body: unknown, capture: Array<{ url: string; init: RequestInit }>) =>
    (async (url: string, init: RequestInit) => {
      capture.push({ url, init });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

  it('parses a Gemini responseSchema reply and sends the key in a header, not the URL', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = stub(
      { candidates: [{ content: { parts: [{ text: JSON.stringify(good) }] } }] },
      calls,
    );
    try {
      const r = await createSummarizer('gemini').summarize(input);
      assert.equal(r.usedAi, true);
      assert.equal(r.output.categorySlug, 'economy-business');
      assert.ok(!calls[0]!.url.includes('test-key'));
      assert.equal(
        (calls[0]!.init.headers as Record<string, string>)['x-goog-api-key'],
        'test-key',
      );
      // Default model is gemini-3.1-flash-lite, called without a custom temperature.
      assert.match(calls[0]!.url, /\/models\/gemini-3\.1-flash-lite:generateContent$/);
      const body = JSON.parse(String(calls[0]!.init.body));
      assert.equal(body.generationConfig.temperature, undefined);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('parses an OpenAI json_schema reply', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = stub({ choices: [{ message: { content: JSON.stringify(good) } }] }, calls);
    try {
      const r = await createSummarizer('openai').summarize(input);
      assert.equal(r.usedAi, true);
      const body = JSON.parse(String(calls[0]!.init.body));
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.response_format.json_schema.strict, true);
      // Default model is gpt-5-mini: reasoning models reject a custom temperature.
      assert.equal(body.model, 'gpt-5-mini');
      assert.equal(body.temperature, undefined);
      assert.equal(body.reasoning_effort, 'low');
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('leaves temperature at the default for Gemini 3+ models', async () => {
    const { geminiRequestBody, usesDefaultTemperature } =
      await import('./intelligence/generateAiSummaries.ts');
    for (const m of ['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-10-pro']) {
      assert.ok(usesDefaultTemperature(m), m);
      assert.equal('temperature' in geminiRequestBody(input, m).generationConfig, false, m);
    }
    for (const m of ['gemini-2.5-flash', 'gemini-2.0-flash-lite']) {
      assert.ok(!usesDefaultTemperature(m), m);
      assert.equal(geminiRequestBody(input, m).generationConfig.temperature, 0.2, m);
    }
  });

  it('sends temperature only to non-reasoning OpenAI models', async () => {
    const { openAiRequestBody, isReasoningModel } =
      await import('./intelligence/generateAiSummaries.ts');
    for (const m of ['gpt-5-mini', 'gpt-5', 'gpt-5.1-mini', 'o4-mini'])
      assert.ok(isReasoningModel(m), m);
    for (const m of ['gpt-4o-mini', 'gpt-4.1-mini']) assert.ok(!isReasoningModel(m), m);
    assert.equal(openAiRequestBody(input, 'gpt-4o-mini').temperature, 0.2);
    assert.equal('reasoning_effort' in openAiRequestBody(input, 'gpt-4o-mini'), false);
  });

  it('falls back to the non-AI summary when the model returns invalid output', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    globalThis.fetch = stub(
      {
        candidates: [
          { content: { parts: [{ text: JSON.stringify({ ...good, categorySlug: 'weather' }) }] } },
        ],
      },
      [],
    );
    try {
      const r = await createSummarizer('gemini').summarize(input);
      assert.equal(r.usedAi, false);
      assert.ok(r.error);
      assert.ok(r.output.aiSummaryBullets[0]!.startsWith('Antara reports:'));
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });
});
