/**
 * Publisher content policy tests (EarthViral_Staging_Environment_PLAN.md Phase 5 / §7) —
 * the Joho no Todai headline-only acceptance checks. Run: `npm test`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ContentPolicyViolation,
  STANDARD_POLICY,
  aiOptOutExemption,
  HEADLINE_ONLY_POLICY,
  derivableArticles,
  displayableSources,
  hasDerivableCoverage,
  isRestricted,
  policyForDomain,
  redistributableSources,
  type PolicyRegistries,
} from '../../src/lib/publisherPolicy.ts';
import type { ViralClusterStaticRecord } from '../../src/lib/types.ts';
import { fetchAllRss, parseFeed } from './fetchers/fetchRss.ts';
import { RSS_SOURCES, activeSources, type RssSource } from './fetchers/rssSources.ts';
import { clusterArticles, type CountryArticle } from './intelligence/deduplicateAndCluster.ts';
import type { ViralScore } from './intelligence/computeViralScore.ts';
import {
  createSummarizer,
  geminiRequestBody,
  heuristicSummary,
  openAiRequestBody,
  type SummaryInput,
} from './intelligence/generateAiSummaries.ts';
import { summaryInput } from './intelligence/summaryInput.ts';
import { applyIngestionPolicy, cleanStoredStories } from './policy/applyContentPolicy.ts';

const NOW = new Date('2026-11-17T03:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const JOHO = RSS_SOURCES.find((s) => s.id === 'joho-no-todai-en')!;
const BBC = RSS_SOURCES.find((s) => s.id === 'bbc-world')!;
const JOHO_HEADLINE = 'Japan approves sweeping AI chip export rules for Nvidia suppliers';

/** RSS item carrying every field a headline-only publisher must NOT have used. */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Feed</title>
    <item>
      <title>${JOHO_HEADLINE}</title>
      <link>https://joho-todai.com/en/news/ai-chip-export-rules/?utm_source=rss</link>
      <pubDate>Tue, 17 Nov 2026 01:00:00 GMT</pubDate>
      <description><![CDATA[<p>SECRET-DESCRIPTION the ministry said on Monday.</p><img src="https://joho-todai.com/img/a.jpg">]]></description>
      <content:encoded><![CDATA[<p>SECRET-FULL-CONTENT body paragraph.</p>]]></content:encoded>
      <media:content url="https://joho-todai.com/img/SECRET-IMAGE.jpg" medium="image" />
      <enclosure url="https://joho-todai.com/img/SECRET-ENCLOSURE.jpg" type="image/jpeg" length="1" />
      <category>SECRET-CATEGORY</category>
      <author>SECRET-AUTHOR</author>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>${JOHO_HEADLINE}</title>
    <link rel="alternate" href="https://joho-todai.com/en/news/atom-entry/" />
    <published>2026-11-17T01:00:00Z</published>
    <summary>SECRET-SUMMARY text</summary>
    <content type="html">SECRET-ATOM-CONTENT</content>
  </entry>
</feed>`;

function article(over: Partial<CountryArticle> & { title: string; publisherDomain: string }) {
  return {
    countryCode: 'JP',
    url: `https://${over.publisherDomain}/${encodeURIComponent(over.title)}`,
    snippet: '',
    publishedAt: hoursAgo(1),
    publisherName: over.publisherDomain,
    ...over,
  } satisfies CountryArticle;
}

const joho = article({
  title: JOHO_HEADLINE,
  publisherDomain: 'joho-todai.com',
  publisherName: 'Joho no Todai',
  publishedAt: hoursAgo(1),
});
const nhk = article({
  title: 'Japan sets new AI chip export rules for Nvidia suppliers',
  publisherDomain: 'nhk.or.jp',
  publisherName: 'NHK',
  snippet: 'The trade ministry announced the measures.',
  publishedAt: hoursAgo(2),
});
const kyodo = article({
  title: 'Japan tightens AI chip export rules affecting Nvidia suppliers',
  publisherDomain: 'kyodonews.net',
  publisherName: 'Kyodo',
  publishedAt: hoursAgo(3),
});

const SCORE: ViralScore = {
  viralScore: 60,
  intensityTier: 'high',
  coverage: 70,
  velocity: 60,
  search: 0,
  publishers: 3,
  matchedTrend: null,
} as ViralScore;

describe('configuration', () => {
  it('Joho no Todai is headline-only, by domain and subdomain', () => {
    assert.equal(policyForDomain('joho-todai.com'), HEADLINE_ONLY_POLICY);
    assert.equal(policyForDomain('www.joho-todai.com'), HEADLINE_ONLY_POLICY);
    assert.equal(policyForDomain('en.joho-todai.com'), HEADLINE_ONLY_POLICY);
    assert.equal(policyForDomain('notjoho-todai.com').mode, 'standard');
    assert.equal(HEADLINE_ONLY_POLICY.sendToAiProvider, false);
    assert.equal(HEADLINE_ONLY_POLICY.publishIfExclusiveSource, false);
  });

  it('the feed is fetched in staging only, never in production', () => {
    assert.ok(!activeSources('production').some((s) => s.publisherDomain === 'joho-todai.com'));
    assert.ok(activeSources('staging').some((s) => s.publisherDomain === 'joho-todai.com'));
    // Every existing production feed is unchanged.
    assert.equal(
      activeSources('production').length,
      RSS_SOURCES.filter((s) => s.id !== 'joho-no-todai-en').length,
    );
  });
});

describe('ingestion: only the four permitted fields', () => {
  it('RSS: description, content, images, enclosures and other fields are ignored', () => {
    const [a] = parseFeed(FEED, JOHO, NOW);
    assert.ok(a);
    assert.equal(a.title, JOHO_HEADLINE);
    assert.equal(a.url, 'https://joho-todai.com/en/news/ai-chip-export-rules/');
    assert.equal(a.publishedAt, '2026-11-17T01:00:00Z');
    assert.equal(a.publisherName, 'Joho no Todai');
    assert.equal(a.snippet, '');
    assert.doesNotMatch(JSON.stringify(a), /SECRET/);
  });

  it('Atom: summary and content are ignored', () => {
    const [a] = parseFeed(ATOM, JOHO, NOW);
    assert.equal(a?.snippet, '');
    assert.doesNotMatch(JSON.stringify(a), /SECRET/);
  });

  it('other publishers keep their description under their own policy', () => {
    const [a] = parseFeed(FEED, BBC, NOW);
    assert.match(a!.snippet, /SECRET-DESCRIPTION/);
  });

  it('GDELT (or any channel) articles from the domain are stripped too', () => {
    const [a] = applyIngestionPolicy([{ ...joho, snippet: 'leaked text' }, nhk]);
    assert.equal(a!.snippet, '');
    assert.equal(applyIngestionPolicy([nhk])[0]!.snippet, nhk.snippet);
  });

  it('only the feed URL is requested — never an article page', async () => {
    const requested: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return new Response(FEED, { status: 200, headers: { 'content-type': 'application/xml' } });
    }) as typeof fetch;
    try {
      const result = await fetchAllRss([JOHO], NOW);
      assert.equal(result.articles.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(requested, [JOHO.url]);
  });
});

describe('AI exclusion', () => {
  const mixed = clusterArticles([joho, nhk, kyodo], [])[0]!;

  it('internal non-AI matching still groups the restricted headline with other coverage', () => {
    assert.equal(clusterArticles([joho, nhk, kyodo], []).length, 1);
    assert.equal(mixed.articles.length, 3);
  });

  it('mixed-source summary input excludes Joho no Todai but still counts it', () => {
    const input = summaryInput(mixed, SCORE);
    assert.deepEqual(input.articles.map((a) => a.publisherName).sort(), ['Kyodo', 'NHK']);
    assert.equal(input.metrics.publishers, 3); // coverage counting is allowed
    assert.doesNotMatch(JSON.stringify(input), /Joho|joho-todai/);
  });

  it('Gemini and OpenAI payloads never contain the restricted headline', () => {
    const input = summaryInput(mixed, SCORE);
    for (const body of [
      geminiRequestBody(input, 'gemini-3.1-flash-lite'),
      openAiRequestBody(input, 'gpt-5-mini'),
    ]) {
      const json = JSON.stringify(body);
      assert.ok(!json.includes(JOHO_HEADLINE));
      assert.doesNotMatch(json, /Joho|joho-todai/);
      assert.ok(json.includes(nhk.title)); // other publishers are processed normally
    }
  });

  it('non-AI fallback text is not derived from the restricted headline', () => {
    const out = heuristicSummary(summaryInput(mixed, SCORE));
    assert.doesNotMatch(JSON.stringify(out), /Joho|joho-todai|sweeping/);
  });

  it('payload builders and fallback fail closed if a restricted article slips through', () => {
    const leaked: SummaryInput = {
      ...summaryInput(mixed, SCORE),
      articles: [{ ...joho, publisherDomain: 'joho-todai.com' }],
    };
    assert.throws(() => geminiRequestBody(leaked, 'gemini-3.1-flash-lite'), ContentPolicyViolation);
    assert.throws(() => openAiRequestBody(leaked, 'gpt-5-mini'), ContentPolicyViolation);
    assert.throws(() => heuristicSummary(leaked), ContentPolicyViolation);
  });

  it('the summariser makes no provider request for a leaked input (and does not fall back)', async () => {
    const realFetch = globalThis.fetch;
    const realKey = process.env.GEMINI_API_KEY;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    process.env.GEMINI_API_KEY = 'test-key';
    try {
      const leaked = { ...summaryInput(mixed, SCORE), articles: [{ ...joho }] };
      await assert.rejects(createSummarizer('gemini').summarize(leaked), ContentPolicyViolation);
    } finally {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = realKey;
    }
    assert.equal(calls, 0);
  });

  it('the summariser sends only eligible publishers for a mixed cluster', async () => {
    const realFetch = globalThis.fetch;
    const realKey = process.env.GEMINI_API_KEY;
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ error: { message: 'stub' } }), { status: 400 });
    }) as unknown as typeof fetch;
    process.env.GEMINI_API_KEY = 'test-key';
    try {
      await createSummarizer('gemini').summarize(summaryInput(mixed, SCORE));
    } finally {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = realKey;
    }
    assert.ok(bodies.length > 0);
    for (const b of bodies) assert.doesNotMatch(b, /Joho|joho-todai|sweeping/);
  });
});

describe('publication rules', () => {
  it('a story covered only by Joho no Todai is not publishable', () => {
    const only = clusterArticles(
      [joho, { ...joho, url: 'https://joho-todai.com/en/2', title: `${JOHO_HEADLINE} update` }],
      [],
    );
    for (const c of only) assert.equal(hasDerivableCoverage(c.articles), false);
    assert.equal(derivableArticles(only.flatMap((c) => c.articles)).length, 0);
  });

  it('a mixed story is publishable', () => {
    assert.equal(hasDerivableCoverage([joho, nhk]), true);
  });

  const src = (domain: string, name = domain) => ({
    publisherName: name,
    publisherDomain: domain,
    articleTitle: `Headline from ${name}`,
    articleUrl: `https://${domain}/a`,
    publishedAt: hoursAgo(1),
  });

  it('the original headline is displayed only beside another publisher', () => {
    assert.deepEqual(displayableSources([src('joho-todai.com')]), []);
    assert.deepEqual(
      displayableSources([src('joho-todai.com'), src('nhk.or.jp')]).map((s) => s.publisherDomain),
      ['joho-todai.com', 'nhk.or.jp'],
    );
  });

  it('it is excluded from redistributed outputs (search, JSON-LD, public JSON)', () => {
    assert.deepEqual(
      redistributableSources([src('joho-todai.com'), src('nhk.or.jp')]).map(
        (s) => s.publisherDomain,
      ),
      ['nhk.or.jp'],
    );
    assert.ok(isRestricted('joho-todai.com'));
    assert.ok(!isRestricted('nhk.or.jp'));
  });
});

describe('removal requests', () => {
  const removal: PolicyRegistries = {
    removed: [{ publisherDomain: 'joho-todai.com', removedAt: '2026-11-17', reason: 'test' }],
  };
  const story = (slug: string, domains: string[]) =>
    ({
      slug,
      canonicalPath: `/news/jp/${slug}/`,
      countrySlug: 'japan',
      sources: domains.map((d) => ({
        publisherName: d,
        publisherDomain: d,
        articleTitle: `Headline ${d}`,
        articleUrl: `https://${d}/${slug}`,
        publishedAt: hoursAgo(1),
      })),
    }) as unknown as ViralClusterStaticRecord;

  it('stored sources are deleted and stories left without coverage are withdrawn', () => {
    const { kept, unpublishable, removedSources } = cleanStoredStories(
      [story('mixed', ['joho-todai.com', 'nhk.or.jp']), story('only', ['joho-todai.com'])],
      removal,
    );
    assert.equal(removedSources, 2);
    assert.deepEqual(
      kept.map((s) => s.slug),
      ['mixed'],
    );
    assert.deepEqual(
      kept[0]!.sources.map((s) => s.publisherDomain),
      ['nhk.or.jp'],
    );
    assert.deepEqual(
      unpublishable.map((s) => s.slug),
      ['only'],
    );
  });

  it('removed publishers disappear from displays and ingestion', () => {
    const s = story('mixed', ['joho-todai.com', 'nhk.or.jp']).sources;
    assert.deepEqual(
      displayableSources(s, removal).map((x) => x.publisherDomain),
      ['nhk.or.jp'],
    );
    assert.deepEqual(applyIngestionPolicy([joho, nhk], removal), [nhk]);
  });

  it('without a removal, headline-only stories are kept but exclusive ones withdrawn', () => {
    const { kept, unpublishable } = cleanStoredStories([
      story('mixed', ['joho-todai.com', 'nhk.or.jp']),
      story('only', ['joho-todai.com']),
    ]);
    assert.deepEqual(
      kept.map((s) => s.slug),
      ['mixed'],
    );
    assert.equal(kept[0]!.sources.length, 2);
    assert.deepEqual(
      unpublishable.map((s) => s.slug),
      ['only'],
    );
  });

  it('a removed publisher feed is not fetched', () => {
    const feed: RssSource = { ...JOHO, environments: ['production', 'staging'] };
    assert.equal(activeSources('staging', [feed]).length, 1);
    assert.deepEqual(activeSources('staging', [feed], removal), []);
    assert.deepEqual(activeSources('production', [feed], removal), []);
  });
});

describe('AI opt-out sourcing rule exception', () => {
  it('Joho no Todai is exempt by agreement; standard publishers are not', () => {
    assert.match(aiOptOutExemption('joho-todai.com') ?? '', /Headline-only/);
    assert.equal(aiOptOutExemption('bbc.com'), null);
  });

  it('only a recorded agreement whose policy excludes all AI use is exempt', () => {
    const entry = { publisherDomain: 'x.example', publisherName: 'X', terms: 'by email' };
    assert.ok(aiOptOutExemption('x.example', [{ ...entry, policy: HEADLINE_ONLY_POLICY }]));
    assert.equal(aiOptOutExemption('x.example', [{ ...entry, policy: STANDARD_POLICY }]), null);
    assert.equal(
      aiOptOutExemption('x.example', [{ ...entry, terms: ' ', policy: HEADLINE_ONLY_POLICY }]),
      null,
    );
    assert.equal(
      aiOptOutExemption(
        'x.example',
        [{ ...entry, policy: HEADLINE_ONLY_POLICY }],
        [{ publisherDomain: 'x.example', removedAt: '2026-11-21', reason: 'test' }],
      ),
      null,
    );
  });
});
