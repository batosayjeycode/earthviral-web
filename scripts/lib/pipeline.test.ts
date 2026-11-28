/** Unit tests for the batch pipeline. Run: `npm test` (node:test, no extra deps). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectCountry, mentionedCountries } from './intelligence/detectCountry.ts';
import {
  clusterArticles,
  dedupeArticles,
  hasDrifted,
  type CountryArticle,
} from './intelligence/deduplicateAndCluster.ts';
import {
  computeViralScore,
  coverageScore,
  matchTrend,
  velocityScore,
} from './intelligence/computeViralScore.ts';
import type { ViralClusterStaticRecord } from '../../src/lib/types.ts';
import { heuristicSummary, keepsStoredAiText } from './intelligence/generateAiSummaries.ts';
import { parseFeed } from './fetchers/fetchRss.ts';
import { summaryQueue } from './intelligence/selectStories.ts';
import { keepStoryNames, namesAnchor, storyAnchors } from './intelligence/storyNames.ts';
import { aiCompaniesBlocked, isAiOptOut } from './robotsPolicy.ts';
import { RSS_SOURCES } from './fetchers/rssSources.ts';
import { decodeBody, detectCharset, fetchText, isMislabelledSingleByte } from './http.ts';
import { parseTrendsFeed } from './fetchers/fetchGoogleTrends.ts';
import { nextScheduledBatch, nextWibBoundary } from './builders/writeStaticJson.ts';
import { looksEnglish, looksForeign, slugify, tokenize, truncate } from './intelligence/text.ts';

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

/** Minimal published story for clustering: only the fields clustering reads. */
function story(
  countryCode: string,
  slug: string,
  headline: string,
  titles: string[],
): ViralClusterStaticRecord {
  return {
    countryCode,
    slug,
    headline,
    sources: titles.map((t, i) => ({
      publisherName: `p${i}`,
      publisherDomain: `p${i}.com`,
      articleTitle: t,
      articleUrl: `https://p${i}.com/${i}`,
      publishedAt: hoursAgo(48 - i),
    })),
  } as unknown as ViralClusterStaticRecord;
}

describe('story drift', () => {
  // Real batches hold 1,000+ headlines, so a country's name is a rare, heavily weighted word.
  // Without other countries' headlines in the corpus, "South Africa" would weigh almost
  // nothing and these tests could not reproduce the drift.
  const filler = [
    'Parliament passes budget bill after long debate',
    'Central bank holds interest rates steady',
    'Storm cuts power to coastal towns',
    'Football club appoints new head coach',
    'Tech firm unveils new smartphone lineup',
    'Teachers strike over pay dispute',
    'Wildfire forces evacuations in hills',
    'Court jails former minister for graft',
    'Airline cancels flights amid strike',
    'Election commission sets vote date',
    'Oil prices climb on supply fears',
    'Hospital workers demand better conditions',
  ].map((title, i) =>
    article({ countryCode: 'GB', title, publisherDomain: `f${i}.com`, publishedAt: hoursAgo(5) }),
  );
  const airport = (
    titles: string[],
    headline = 'Foreign Nationals Arrested At South African Airport',
  ) =>
    story('ZA', 'foreign-nationals-arrested-south-africa-airport', headline, [
      'Nine foreigners caught allegedly trying to leave South Africa to fight in Ukraine',
      ...titles,
    ]);

  it("doesn't attach unrelated news that only shares the country's name", () => {
    const clusters = clusterArticles(
      [
        article({
          countryCode: 'ZA',
          title: '17 dead as 2 mass shootings rock South Africa',
          publisherDomain: 'a.com',
        }),
        article({
          countryCode: 'ZA',
          title: 'South Africa releases speech after protest',
          publisherDomain: 'b.com',
        }),
        ...filler,
      ],
      // Two sources that both say "South Africa" pull the cluster centroid towards the name;
      // before the fix both unrelated articles above attached to this story.
      [airport(['South Africa detains foreigners suspected of heading to join Russian forces'])],
    );
    const existing = clusters.find((c) => c.existing)!;
    assert.equal(existing.articles.filter((a) => a.isNew).length, 0);
    assert.equal(clusters.filter((c) => c.countryCode === 'ZA').length, 3);
  });

  it('still attaches genuine follow-up coverage', () => {
    const clusters = clusterArticles(
      [
        article({
          countryCode: 'ZA',
          title: 'Nine foreigners caught at airport trying to fight in Ukraine appear in court',
          publisherDomain: 'a.com',
        }),
      ],
      [airport([])],
    );
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]!.articles.length, 2);
  });

  it('does not let one stray word become an attach point (no snowballing)', () => {
    const clusters = clusterArticles(
      [
        article({
          title: 'Banjir rendam ribuan rumah di Bekasi',
          publisherDomain: 'a.com',
          publishedAt: hoursAgo(4),
        }),
        // Joins the flood story, and brings "warga" (residents) with it.
        article({
          title: 'Banjir Bekasi, ribuan warga mengungsi',
          publisherDomain: 'b.com',
          publishedAt: hoursAgo(3),
        }),
        // Shares only "ribuan" (thousands) and "warga" with the flood story; before the fix
        // "warga" counted as an attach point once one member used it, and the concert joined.
        article({
          title: 'Ribuan warga padati konser musik',
          publisherDomain: 'c.com',
          publishedAt: hoursAgo(1),
        }),
        ...filler,
      ],
      [],
    );
    const flood = clusters.filter((c) => c.countryCode === 'ID');
    assert.deepEqual(flood.map((c) => c.articles.length).sort(), [1, 2]);
  });

  it('repairs a story that drifted onto another event, around the source matching its URL', () => {
    const drifted = airport(
      [
        'South Africa releases speech after protest',
        'Pan-African solidarity call condemns Afrophobia in South Africa',
        '17 dead as 2 mass shootings rock South Africa within 24 hours',
        'South Africa: 17 killed in separate mass shooting incidents',
      ],
      'Mass Shooting Incidents Result In Seventeen Deaths In South Africa',
    );
    assert.ok(hasDrifted(drifted));
    const [cluster] = clusterArticles([], [drifted]);
    assert.equal(cluster!.pruned, 4);
    assert.match(cluster!.articles[0]!.title, /Nine foreigners/);
  });

  it('leaves an evolving but on-topic story alone', () => {
    const protests = story(
      'FR',
      'france-more-than-600-000-protest-as-anger-grows',
      'Over One Hundred Thousand March Across France In Fifth Weekend',
      [
        'France: More than 600,000 protest as anger grows over cost of living',
        'France faces fifth weekend of protests',
        'More than 100,000 protest across France for fifth consecutive weekend',
      ],
    );
    assert.ok(hasDrifted(protests)); // headline wording changed…
    const [cluster] = clusterArticles([], [protests]);
    assert.equal(cluster!.pruned, 0); // …but the sources are still the same story
  });

  it("doesn't match a search trend on the country's name alone", () => {
    const [cluster] = clusterArticles([], [airport([])]);
    assert.equal(
      matchTrend(cluster!, [
        { country: 'ZA', keyword: 'south africa', traffic: 50_000, newsTitles: [] },
      ]),
      null,
    );
  });
});

describe('search trends', async () => {
  const { searchQueryFor, usesSearchTerms } = await import('./intelligence/computeViralScore.ts');
  /** The biggest cluster built from these GB headlines (one story). */
  const story = (titles: string[]) =>
    clusterArticles(
      titles.map((title, i) =>
        article({ title, countryCode: 'GB', publisherDomain: `outlet${i}.co.uk` }),
      ),
      [],
    ).sort((a, b) => b.articles.length - a.articles.length)[0]!;
  const trend = (keyword: string, newsTitles: string[] = []) => ({
    country: 'GB',
    keyword,
    traffic: 100_000,
    newsTitles,
  });
  const brexit = story([
    'Boris Johnson says Britain would vote for Brexit again',
    'Johnson defends Brexit and attacks Labour on zero-hours contracts',
    'Brexit was right, Boris Johnson insists in new interview',
  ]);

  it('matches a search whose words are core to the story, and targets it in the title', () => {
    const t = trend('brexit');
    assert.equal(matchTrend(brexit, [t]), t);
    assert.equal(searchQueryFor(brexit, t), 'brexit');
  });

  it('ignores a generic word that appears in only one headline', () => {
    const s = story([
      'Boris Johnson says Britain would vote for Brexit again',
      'Boris Johnson says Brexit insurance against EU decline',
      'Brexit was right, Boris Johnson insists in new interview',
    ]);
    assert.equal(s.articles.length, 3);
    assert.equal(matchTrend(s, [trend('insurance')]), null);
  });

  it("doesn't match through Google's linked news titles when the search itself is unrelated", () => {
    // "uson nevers rugby" was linked to French politics headlines and gave them a search bonus.
    const t = trend('uson nevers rugby', [
      'Boris Johnson says Britain would vote for Brexit again',
    ]);
    assert.equal(matchTrend(brexit, [t]), null);
  });

  it('treats plurals as the same word but not shared prefixes', () => {
    const alerts = story([
      'Government tests new emergency alert system on mobile phones',
      'Emergency alert test to sound on phones across the country',
      'Phones to receive emergency alert in nationwide test',
    ]);
    assert.equal(searchQueryFor(alerts, trend('emergency alerts')), 'emergency alerts');
    const palmer = story([
      'Cole Palmer injury blow for Chelsea ahead of derby',
      'Chelsea sweat on Cole Palmer fitness',
      'Palmer ruled out of Chelsea derby with groin injury',
    ]);
    assert.equal(matchTrend(palmer, [trend('palmeiras')]), null);
  });

  it('checks whether a title uses the search terms', () => {
    assert.ok(usesSearchTerms('Iran Targets US Bases in Kuwait', 'kuwait', 'GB'));
    assert.ok(usesSearchTerms('Emergency Alert Test Sounds Nationwide', 'emergency alerts', 'GB'));
    assert.ok(!usesSearchTerms('Military Tensions Between Iran And US', 'kuwait', 'GB'));
  });
});

describe('duplicate stories', async () => {
  const { mergeDuplicateStories, isDuplicate } = await import('./intelligence/mergeDuplicates.ts');
  const rec = (over: Partial<ViralClusterStaticRecord> & { slug: string; headline: string }) =>
    ({
      id: over.slug,
      countryCode: 'PH',
      seoTitle: over.headline.slice(0, 60),
      canonicalPath: `/news/ph/${over.slug}/`,
      firstDetectedAt: '2026-11-17T04:00:00Z',
      lastUpdatedBatchAt: '2026-11-17T08:18:00Z',
      viralScore: 50,
      signalBreakdown: { verifiedPublisherCount: 1 },
      sources: [
        {
          publisherName: over.slug,
          publisherDomain: `${over.slug}.com`,
          articleTitle: over.headline,
          articleUrl: `https://${over.slug}.com/a`,
          publishedAt: '2026-11-17T04:00:00Z',
        },
      ],
      ...over,
    }) as unknown as ViralClusterStaticRecord;

  it('merges a new story into the published one covering the same event', () => {
    const published = rec({
      slug: 'prime-minister-modi-manila-gurudwara-visit',
      headline: 'Prime Minister Narendra Modi Visits Historic Manila Gurudwara',
    });
    const fresh = rec({
      slug: 'prime-minister-modi-philippines-gurudwara-visit',
      headline: 'Prime Minister Narendra Modi Visits Historic Gurudwara In Manila',
      firstDetectedAt: '2026-11-17T08:06:00Z',
    });
    const { records, merges } = mergeDuplicateStories([published, fresh], (r) => r === fresh);
    assert.deepEqual(records, [published]);
    assert.equal(merges[0]!.retired, false); // never published: no redirect needed
    assert.equal(published.sources.length, 2);
    assert.equal(published.signalBreakdown.verifiedPublisherCount, 2);
  });

  it('retires the published duplicate whose URL fits the event worse, with a redirect', () => {
    const early = rec({
      slug: 'protests-at-vice-presidential-palace',
      headline: 'Vice President Gibran Rakabuming Raka Formally Resigns From Office',
      countryCode: 'ID',
      firstDetectedAt: '2026-11-15T00:00:00Z',
    });
    const named = rec({
      slug: 'gibran-rakabuming-raka-resigns-vice-presidency',
      headline: 'Vice President Gibran Rakabuming Raka Resigns From Office',
      countryCode: 'ID',
      firstDetectedAt: '2026-11-16T00:00:00Z',
    });
    const { records, merges } = mergeDuplicateStories([early, named], () => false);
    assert.deepEqual(records, [named]);
    assert.equal(merges[0]!.from, early);
    assert.equal(merges[0]!.retired, true);
  });

  it('keeps different events, other countries and old stories apart', () => {
    const semi = rec({
      slug: 'a',
      headline: 'Mirra Andreeva Secures WTA Finals Semifinal Spot In Riyadh',
    });
    const title = rec({
      slug: 'b',
      headline: 'Mirra Andreeva Secures WTA Finals Title In Her Debut',
    });
    assert.ok(!isDuplicate(semi, title));
    const same = rec({ slug: 'c', headline: semi.headline });
    assert.ok(isDuplicate(semi, same));
    assert.ok(!isDuplicate(semi, { ...same, countryCode: 'SA' }));
    assert.ok(!isDuplicate(semi, { ...same, firstDetectedAt: '2026-11-25T00:00:00Z' }));
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

describe('fallback summary retries', () => {
  const item = (id: string, viralScore: number) => ({ id, score: { viralScore } });
  const required = [item('new-low', 40), item('new-high', 90), item('updated', 60)];
  const fallback = [item('fb-a', 95), item('fb-b', 20), item('fb-c', 70)];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it('retries the top fallback stories after all required work, whatever their score', () => {
    const { queue, retried } = summaryQueue(required, fallback, { all: false, auto: 2 });
    assert.deepEqual(ids(queue), ['new-high', 'updated', 'new-low', 'fb-a', 'fb-c']);
    assert.deepEqual(ids(retried), ['fb-a', 'fb-c']);
  });

  it('can be switched off, and never retries more than exist', () => {
    assert.deepEqual(ids(summaryQueue(required, fallback, { all: false, auto: 0 }).queue), [
      'new-high',
      'updated',
      'new-low',
    ]);
    assert.equal(summaryQueue(required, fallback, { all: false, auto: 50 }).retried.length, 3);
  });

  it('--resummarize-fallback ranks every fallback story together with required work', () => {
    const { queue, retried } = summaryQueue(required, fallback, { all: true, auto: 2 });
    assert.deepEqual(ids(queue), ['fb-a', 'new-high', 'fb-c', 'updated', 'new-low', 'fb-b']);
    assert.equal(retried.length, 3);
  });
});

describe('feed encodings', () => {
  // "Relação" / "Escândalo" in ISO-8859-1 (one byte per accented letter).
  const latin1Feed = Uint8Array.from(
    Buffer.from(
      '<?xml version="1.0" encoding="ISO-8859-1" ?><rss><channel><item><title>Relação e escândalo</title></item></channel></rss>',
      'latin1',
    ),
  );

  it('detects the charset from Content-Type, then the XML declaration, else UTF-8', () => {
    assert.equal(detectCharset('text/xml; charset=windows-1252', latin1Feed), 'windows-1252');
    assert.equal(detectCharset('application/rss+xml; charset="UTF-8"', latin1Feed), 'utf-8');
    assert.equal(detectCharset('text/xml', latin1Feed), 'iso-8859-1');
    assert.equal(detectCharset(null, new TextEncoder().encode('<rss></rss>')), 'utf-8');
    assert.equal(
      detectCharset(null, new TextEncoder().encode("<?xml version='1.0' encoding='utf-8'?><rss/>")),
      'utf-8',
    );
  });

  it('decodes Latin-1 without replacement characters, and survives unknown labels', () => {
    const text = decodeBody(latin1Feed, 'iso-8859-1');
    assert.match(text, /Relação e escândalo/);
    assert.doesNotMatch(text, /\uFFFD/);
    assert.equal(decodeBody(new TextEncoder().encode('Açaí'), 'x-unknown-charset'), 'Açaí');
  });

  it('reads Latin-1 bytes mislabelled as UTF-8 as Windows-1252, but keeps real UTF-8', () => {
    const noDeclaration = Uint8Array.from(
      Buffer.from('<rss><title>Relação e escândalo</title></rss>', 'latin1'),
    );
    assert.equal(isMislabelledSingleByte(noDeclaration), true);
    assert.equal(
      decodeBody(noDeclaration, 'utf-8'),
      '<rss><title>Relação e escândalo</title></rss>',
    );
    // Real UTF-8 (even with one stray byte) is left as UTF-8.
    const utf8 = new TextEncoder().encode('Açaí — São Paulo');
    assert.equal(isMislabelledSingleByte(utf8), false);
    assert.equal(decodeBody(utf8, 'UTF-8'), 'Açaí — São Paulo');
    const mixed = Uint8Array.from([...utf8, 0xe9]);
    assert.equal(isMislabelledSingleByte(mixed), false);
    assert.match(decodeBody(mixed, 'utf-8'), /^Açaí — São Paulo/);
    // Plain ASCII is unaffected.
    assert.equal(isMislabelledSingleByte(new TextEncoder().encode('<rss/>')), false);
  });

  it('fetchText decodes a Latin-1 feed served as plain text/xml (Folha)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(latin1Feed, { headers: { 'content-type': 'text/xml' } });
    try {
      const xml = await fetchText('https://feeds.example/rss.xml');
      assert.match(xml, /Relação e escândalo/);
      const utf8 = new TextEncoder().encode('<rss><title>Açaí — São Paulo</title></rss>');
      globalThis.fetch = async () =>
        new Response(utf8, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
      assert.match(await fetchText('https://feeds.example/utf8.xml'), /Açaí — São Paulo/);
    } finally {
      globalThis.fetch = realFetch;
    }
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

  it('leads the meta description with the story, so equal metrics never collide', () => {
    const metrics = {
      viralScore: 95,
      publishers: 4,
      velocity: 80,
      search: 60,
      trendKeyword: 'delhi high court',
    };
    const describe = (title: string) =>
      heuristicSummary({
        countryCode: 'IN',
        countryName: 'India',
        articles: [{ publisherName: 'NDTV', title, snippet: '', publishedAt: hoursAgo(1) }],
        metrics,
      }).metaDescription;
    const a = describe('Kerala High Court quashes suspension of Sanskrit varsity students');
    const b = describe('Tensions rise over Karthigai Deepam lighting in Tamil Nadu');
    assert.notEqual(a, b);
    assert.ok(
      a.startsWith('Kerala High Court quashes suspension of Sanskrit varsity students. 4 '),
    );
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

  describe('failover from Gemini to OpenAI', async () => {
    const { resetQuotaStops, resolveFailover } =
      await import('./intelligence/generateAiSummaries.ts');
    const dailyQuota = {
      error: {
        code: 429,
        message: 'You exceeded your current quota.',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.001s' },
        ],
      },
    };
    // Gemini answers with `gemini`, OpenAI with `openai`; counts requests per provider.
    const route = (
      gemini: { status: number; body: unknown },
      openai: { status: number; body: unknown },
      count: { gemini: number; openai: number },
    ) =>
      (async (url: string) => {
        const which = url.includes('googleapis.com') ? 'gemini' : 'openai';
        count[which]++;
        const r = which === 'gemini' ? gemini : openai;
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;
    const openAiGood = {
      status: 200,
      body: { choices: [{ message: { content: JSON.stringify(good) } }] },
    };
    const withKeys = async (fn: () => Promise<void>) => {
      process.env.GEMINI_API_KEY = 'g-key';
      process.env.OPENAI_API_KEY = 'o-key';
      try {
        await fn();
      } finally {
        resetQuotaStops();
        globalThis.fetch = realFetch;
        delete process.env.GEMINI_API_KEY;
        delete process.env.OPENAI_API_KEY;
      }
    };

    it('fails over only for an automatically chosen Gemini with an OpenAI key', () =>
      withKeys(async () => {
        assert.equal(resolveFailover(undefined, 'gemini'), 'openai');
        assert.equal(resolveFailover('gemini', 'gemini'), null); // explicit provider: that one only
        assert.equal(resolveFailover(undefined, 'openai'), null);
        delete process.env.OPENAI_API_KEY;
        assert.equal(resolveFailover(undefined, 'gemini'), null);
      }));

    it('writes the summary with OpenAI once Gemini hits its daily quota, then skips Gemini', () =>
      withKeys(async () => {
        const count = { gemini: 0, openai: 0 };
        globalThis.fetch = route({ status: 429, body: dailyQuota }, openAiGood, count);
        const summarizer = createSummarizer('gemini', 'openai');
        assert.deepEqual(summarizer.failover, { provider: 'openai', model: 'gpt-5-mini' });

        const first = await summarizer.summarize(input);
        assert.equal(first.usedAi, true);
        assert.equal(first.error, undefined);
        assert.equal(first.output.headline, good.headline);
        assert.equal(first.failover?.ok, true);
        assert.equal(first.failover?.from.category, 'rate-limit');
        assert.deepEqual(count, { gemini: 3, openai: 1 }); // Gemini: 3 attempts

        const second = await summarizer.summarize(input);
        assert.equal(second.usedAi, true);
        assert.deepEqual(count, { gemini: 3, openai: 2 }); // no Gemini request after the daily stop
      }));

    it('fails over on a bad Gemini reply too, and falls back to non-AI text if OpenAI fails', () =>
      withKeys(async () => {
        const count = { gemini: 0, openai: 0 };
        const badGemini = {
          status: 200,
          body: { candidates: [{ content: { parts: [{ text: '{}' }] } }] },
        };
        globalThis.fetch = route(
          badGemini,
          { status: 400, body: { error: { message: 'Bad' } } },
          count,
        );
        const r = await createSummarizer('gemini', 'openai').summarize(input);
        assert.equal(r.usedAi, false);
        assert.equal(r.failover?.from.category, 'schema');
        assert.equal(r.failover?.ok, false);
        assert.equal(r.error?.category, 'http-error'); // the failover provider's failure
        assert.ok(r.output.aiContextParagraph.includes('without an AI model'));
        assert.deepEqual(count, { gemini: 1, openai: 1 });
      }));

    it('never calls OpenAI when Gemini succeeds or no failover is set', () =>
      withKeys(async () => {
        const count = { gemini: 0, openai: 0 };
        const geminiGood = {
          status: 200,
          body: { candidates: [{ content: { parts: [{ text: JSON.stringify(good) }] } }] },
        };
        globalThis.fetch = route(geminiGood, openAiGood, count);
        const ok = await createSummarizer('gemini', 'openai').summarize(input);
        assert.equal(ok.usedAi, true);
        assert.equal(ok.failover, undefined);

        globalThis.fetch = route({ status: 429, body: dailyQuota }, openAiGood, count);
        const alone = await createSummarizer('gemini').summarize(input);
        assert.equal(alone.usedAi, false);
        assert.equal(alone.failover, undefined);
        assert.equal(count.openai, 0);
      }));
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
      assert.equal(r.error?.category, 'schema');
      assert.match(r.error?.detail ?? '', /categorySlug/);
      assert.ok(r.output.aiSummaryBullets[0]!.startsWith('Antara reports:'));
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });
});

describe('per-country story cap', async () => {
  const { selectTopPerCountry } = await import('./intelligence/selectStories.ts');
  const { mergeRetired, redirectsFile } = await import('./builders/writeStaticJson.ts');
  const item = (countryCode: string, viralScore: number, isExisting: boolean, id: string) => ({
    countryCode,
    viralScore,
    isExisting,
    id,
  });

  it('keeps the top N per country, ranking existing and new stories together', () => {
    const items = [
      item('ID', 90, true, 'id-old-hot'),
      item('ID', 40, true, 'id-old-cold'),
      item('ID', 70, false, 'id-new-hot'),
      item('ID', 30, false, 'id-new-cold'),
      item('US', 50, false, 'us-new'),
    ];
    const { kept, dropped } = selectTopPerCountry(items, 2);
    assert.deepEqual(kept.map((x) => x.id).sort(), ['id-new-hot', 'id-old-hot', 'us-new']);
    assert.deepEqual(dropped.map((x) => x.id).sort(), ['id-new-cold', 'id-old-cold']);
  });

  it('prefers existing stories on a tie (no URL churn) and treats 0 as no cap', () => {
    const items = [item('ID', 60, false, 'new'), item('ID', 60, true, 'old')];
    assert.deepEqual(
      selectTopPerCountry(items, 1).kept.map((x) => x.id),
      ['old'],
    );
    assert.equal(selectTopPerCountry(items, 0).kept.length, 2);
  });

  it('merges redirects: newest wins, live paths and expired entries are dropped', () => {
    const at = new Date('2026-11-07T00:00:00Z');
    const merged = mergeRetired(
      [
        {
          path: '/news/id/a/',
          redirectTo: '/country/indonesia/',
          retiredAt: '2026-11-01T00:00:00Z',
        },
        {
          path: '/news/id/old/',
          redirectTo: '/country/indonesia/',
          retiredAt: '2026-01-01T00:00:00Z',
        },
        {
          path: '/news/id/back/',
          redirectTo: '/country/indonesia/',
          retiredAt: '2026-11-02T00:00:00Z',
        },
      ],
      [
        {
          path: '/news/us/b/',
          redirectTo: '/country/united-states/',
          retiredAt: '2026-11-06T00:00:00Z',
        },
      ],
      new Set(['/news/id/back/']),
      at,
    );
    assert.deepEqual(
      merged.map((r) => r.path),
      ['/news/us/b/', '/news/id/a/'],
    );
    assert.match(redirectsFile(merged), /^\/news\/us\/b\/ \/country\/united-states\/ 301$/m);
  });
});

describe('story retention', async () => {
  const { retireOldest } = await import('./intelligence/selectStories.ts');
  const { mergeRetired } = await import('./builders/writeStaticJson.ts');
  const story = (id: string, lastUpdatedAt: string) => ({ id, lastUpdatedAt });

  it('retires the stories with the oldest coverage when over budget, keeping input order', () => {
    const items = [
      story('new', '2026-11-16T00:00:00Z'),
      story('oldest', '2026-11-01T00:00:00Z'),
      story('mid', '2026-11-10T00:00:00Z'),
    ];
    const { kept, dropped } = retireOldest(items, 2);
    assert.deepEqual(
      kept.map((x) => x.id),
      ['new', 'mid'],
    );
    assert.deepEqual(
      dropped.map((x) => x.id),
      ['oldest'],
    );
  });

  it('keeps everything within budget or with no limit, and drops all with a zero budget', () => {
    const items = [story('a', '2026-11-01T00:00:00Z'), story('b', '2026-11-02T00:00:00Z')];
    assert.equal(retireOldest(items, 5).kept.length, 2);
    assert.equal(retireOldest(items, Infinity).kept.length, 2);
    assert.equal(retireOldest(items, 0).dropped.length, 2);
  });

  it('re-points a redirect to a story at the country hub once that story is gone', () => {
    const at = new Date('2026-11-16T00:00:00Z');
    const dup = {
      path: '/news/id/event-2/',
      redirectTo: '/news/id/event/',
      retiredAt: '2026-11-15T00:00:00Z',
    };
    const live = mergeRetired([dup], [], new Set(['/news/id/event/']), at);
    assert.equal(live[0]!.redirectTo, '/news/id/event/');
    const gone = mergeRetired([dup], [], new Set(), at);
    assert.equal(gone[0]!.redirectTo, '/country/indonesia/');
  });
});

describe('score claims in "why it is viral"', async () => {
  const { hasScoreClaim, describeAttention } =
    await import('./intelligence/generateAiSummaries.ts');

  it('flags quoted score figures', () => {
    assert.ok(hasScoreClaim('It reached a viral activity score of 71/100.'));
    assert.ok(hasScoreClaim('High interest, reflected by an 84/100 search signal score.'));
    assert.ok(hasScoreClaim('The story has reached a viral activity score of 52 today.'));
  });

  it('accepts metric descriptions without figures', () => {
    assert.ok(!hasScoreClaim('Four independent outlets are covering this story within hours.'));
    const sentence = describeAttention({
      countryName: 'Indonesia',
      metrics: { publishers: 3, velocity: 80, search: 70, viralScore: 75, trendKeyword: 'banjir' },
    });
    assert.ok(!hasScoreClaim(sentence), sentence);
  });
});

describe('AI failure classification', async () => {
  const { createSummarizer, classifyAiError } =
    await import('./intelligence/generateAiSummaries.ts');
  const { HttpError, suggestedRetryMs } = await import('./http.ts');
  const input = {
    countryCode: 'ID',
    countryName: 'Indonesia',
    articles: [
      {
        publisherName: 'Antara',
        title: 'A headline long enough to keep',
        snippet: '',
        publishedAt: hoursAgo(1),
      },
    ],
    metrics: { viralScore: 50, publishers: 1, velocity: 50, search: 0, trendKeyword: null },
  };
  const realFetch = globalThis.fetch;
  const reply = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

  it('labels HTTP errors with the provider message and never leaks the key', () => {
    const f = classifyAiError(
      new HttpError(
        429,
        'https://x/models/m:generateContent',
        JSON.stringify({ error: { message: 'Quota exceeded' } }),
      ),
    );
    assert.deepEqual(f, { category: 'rate-limit', detail: 'HTTP 429: Quota exceeded' });
    assert.equal(classifyAiError(new HttpError(503, 'u', '')).category, 'server-error');
    assert.equal(classifyAiError(new HttpError(404, 'u', '{}')).category, 'http-error');
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    assert.equal(classifyAiError(timeout).category, 'timeout');
  });

  it('names the exceeded Gemini quota and stops calling after a per-day one', async () => {
    const { resetQuotaStops } = await import('./intelligence/generateAiSummaries.ts');
    const quotaReply = (quotaId: string) => ({
      error: {
        code: 429,
        message: 'You exceeded your current quota, please check your plan and billing details.',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.001s' },
        ],
      },
    });
    process.env.GEMINI_API_KEY = 'test-key';
    let calls = 0;
    const counted = (body: unknown) =>
      (async () => {
        calls++;
        return new Response(JSON.stringify(body), { status: 429 });
      }) as unknown as typeof fetch;
    try {
      // Per-minute: reported with its quota name, later calls still go out.
      globalThis.fetch = counted(
        quotaReply('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
      );
      const minute = await createSummarizer('gemini').summarize(input);
      assert.equal(minute.error?.category, 'rate-limit');
      assert.match(minute.error?.detail ?? '', /^HTTP 429 \[GenerateRequestsPerMinute/);
      await createSummarizer('gemini').summarize(input);
      assert.equal(calls, 6); // 3 attempts each

      // Per-day: the next story is skipped without a request.
      calls = 0;
      globalThis.fetch = counted(quotaReply('GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
      await createSummarizer('gemini').summarize(input);
      assert.equal(calls, 3);
      const skipped = await createSummarizer('gemini').summarize(input);
      assert.equal(calls, 3);
      assert.equal(skipped.error?.category, 'rate-limit');
      assert.match(skipped.error?.detail ?? '', /skipped: daily quota GenerateRequestsPerDay/);
    } finally {
      resetQuotaStops();
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('stops calling OpenAI for the run once the account has no credits', async () => {
    const { resetQuotaStops, isOpenAiOutOfCredits } =
      await import('./intelligence/generateAiSummaries.ts');
    const noCredits = {
      error: {
        message:
          'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    };
    assert.equal(isOpenAiOutOfCredits(JSON.stringify(noCredits)), true);
    assert.equal(
      isOpenAiOutOfCredits(
        JSON.stringify({
          error: { message: 'Rate limit reached for gpt-5-mini', code: 'rate_limit_exceeded' },
        }),
      ),
      false,
    );
    process.env.OPENAI_API_KEY = 'test-key';
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(noCredits), { status: 429 });
    }) as unknown as typeof fetch;
    try {
      const first = await createSummarizer('openai').summarize(input);
      assert.equal(calls, 1); // no retries: waiting doesn't add credits
      assert.equal(first.usedAi, false);
      assert.equal(first.error?.category, 'rate-limit');
      assert.match(first.error?.detail ?? '', /no credits remaining/);
      const second = await createSummarizer('openai').summarize(input);
      assert.equal(calls, 1); // skipped without a request
      assert.match(second.error?.detail ?? '', /skipped: OpenAI account has no credits/);
    } finally {
      resetQuotaStops();
      globalThis.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('cancels AI calls and retry waits once the AI time budget runs out', async () => {
    const { setAiDeadline, aiTimeUp } = await import('./intelligence/generateAiSummaries.ts');
    process.env.GEMINI_API_KEY = 'test-key';
    let calls = 0;
    // Deadline timers are unref'd; a real request's socket keeps the process alive, a mock doesn't.
    const keepAlive = setTimeout(() => {}, 10_000);
    try {
      // A call in flight: Gemini hangs (overloaded), and the budget ends 50 ms in.
      globalThis.fetch = ((_url: string, init: RequestInit) => {
        calls++;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        });
      }) as unknown as typeof fetch;
      setAiDeadline(Date.now() + 50);
      const t0 = Date.now();
      const cut = await createSummarizer('gemini').summarize(input);
      assert.ok(Date.now() - t0 < 2_000, 'returns at the deadline, not after the 60 s timeout');
      assert.equal(calls, 1);
      assert.equal(cut.usedAi, false);
      assert.equal(cut.error?.category, 'time-budget');

      // A retry wait (server-suggested 30 s after a 503) is cut short too.
      calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response('{"error":{"message":"high demand"}}', {
          status: 503,
          headers: { 'retry-after': '30' },
        });
      }) as unknown as typeof fetch;
      setAiDeadline(Date.now() + 50);
      const t1 = Date.now();
      const waited = await createSummarizer('gemini').summarize(input);
      assert.ok(Date.now() - t1 < 2_000, 'does not sit out the retry wait');
      assert.equal(calls, 1);
      assert.equal(waited.error?.category, 'time-budget');

      // Past the deadline: no request at all.
      assert.equal(aiTimeUp(), true);
      calls = 0;
      const skipped = await createSummarizer('gemini').summarize(input);
      assert.equal(calls, 0);
      assert.match(skipped.error?.detail ?? '', /AI time budget for this run is used up/);
    } finally {
      clearTimeout(keepAlive);
      setAiDeadline(null);
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('counts the AI time budget as used up once a call is cut off, even if the clock lags', async () => {
    const { setAiDeadline, aiTimeUp } = await import('./intelligence/generateAiSummaries.ts');
    process.env.GEMINI_API_KEY = 'test-key';
    const realNow = Date.now;
    const keepAlive = setTimeout(() => {}, 10_000);
    try {
      globalThis.fetch = ((_url: string, init: RequestInit) => {
        // The cancel timer is already set. From here Date.now() lags, so when the timer fires
        // the clock still says the deadline is ahead, as when it fires a millisecond early (CI).
        Date.now = () => realNow() - 60_000;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        });
      }) as unknown as typeof fetch;
      setAiDeadline(realNow() + 30);
      const cut = await createSummarizer('gemini').summarize(input);
      assert.equal(cut.error?.category, 'time-budget');
      assert.equal(aiTimeUp(), true);
      // A new budget starts fresh.
      Date.now = realNow;
      setAiDeadline(realNow() + 60_000);
      assert.equal(aiTimeUp(), false);
    } finally {
      Date.now = realNow;
      clearTimeout(keepAlive);
      setAiDeadline(null);
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('reports an empty Gemini reply with its finish reason', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    globalThis.fetch = reply(200, {
      candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
    });
    try {
      const r = await createSummarizer('gemini').summarize(input);
      assert.equal(r.usedAi, false);
      assert.equal(r.error?.category, 'empty');
      assert.match(r.error?.detail ?? '', /SAFETY/);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('reports invalid JSON and OpenAI refusals', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    globalThis.fetch = reply(200, {
      candidates: [{ content: { parts: [{ text: '{not json' }] } }],
    });
    try {
      assert.equal(
        (await createSummarizer('gemini').summarize(input)).error?.category,
        'invalid-json',
      );
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
    process.env.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = reply(200, {
      choices: [{ message: { content: null, refusal: 'I cannot help' } }],
    });
    try {
      const r = await createSummarizer('openai').summarize(input);
      assert.deepEqual(r.error, { category: 'refusal', detail: 'I cannot help' });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("honours Retry-After and Google's retryDelay, capped at 60 s", () => {
    assert.equal(suggestedRetryMs('7', ''), 7000);
    assert.equal(suggestedRetryMs(null, '{"error":{"details":[{"retryDelay":"37s"}]}}'), 37000);
    assert.equal(suggestedRetryMs(null, '{"retryDelay": "600s"}'), 60000);
    assert.equal(suggestedRetryMs(null, '{}'), null);
  });
});

describe('fallback detection', async () => {
  const { heuristicSummary, isFallbackSummary } =
    await import('./intelligence/generateAiSummaries.ts');
  it('recognises stored non-AI summaries, and only those', () => {
    const fallback = heuristicSummary({
      countryCode: 'ID',
      countryName: 'Indonesia',
      articles: [
        {
          publisherName: 'Antara',
          title: 'A headline long enough to keep',
          snippet: '',
          publishedAt: hoursAgo(1),
        },
      ],
      metrics: { viralScore: 50, publishers: 1, velocity: 50, search: 0, trendKeyword: null },
    });
    assert.ok(isFallbackSummary(fallback));
    assert.ok(
      !isFallbackSummary({ aiContextParagraph: 'Bank Indonesia kept its rate unchanged.' }),
    );
  });
});

describe('headline language', () => {
  it('recognises English, including names in other languages', () => {
    for (const t of [
      'Real Madrid striker Endrick ruled out with thigh injury',
      'Military Police Operation In Rio De Janeiro Disrupts Key Roadways',
    ]) {
      assert.ok(looksEnglish(t), t);
      assert.ok(!looksForeign(t), t);
    }
  });

  it('recognises Portuguese, Indonesian, Malay, French and non-Latin headlines as foreign', () => {
    for (const t of [
      'Endrick sofre lesão na coxa direita e desfalca o Real Madrid',
      'Menhan Sjafrie: Tak Ada Rencana Pergantian Panglima TNI',
      'Polis siasat penemuan bungkusan naskhah di tepi jalan di Ulu Tiram',
      'Guerre au Moyen-Orient : palestinien tué en Cisjordanie',
      '中国神舟飞船发射成功',
    ]) {
      assert.ok(looksForeign(t), t);
      assert.ok(!looksEnglish(t), t);
    }
  });

  it('leaves headlines without function words undecided', () => {
    for (const t of [
      'Matildas keeper reveals career-threatening health scare',
      'Bek Bali United Ketar-ketir Hadapi Trio Maut Persib',
    ]) {
      assert.ok(!looksEnglish(t) && !looksForeign(t), t);
    }
  });
});

describe('fallback headline language', () => {
  const summarise = (titles: Array<[string, string]>) =>
    heuristicSummary({
      countryCode: 'ES',
      countryName: 'Spain',
      articles: titles.map(([publisherName, title]) => ({
        publisherName,
        title,
        snippet: '',
        publishedAt: hoursAgo(1),
      })),
      metrics: {
        viralScore: 50,
        publishers: titles.length,
        velocity: 0,
        search: 0,
        trendKeyword: null,
      },
    });

  it('uses an English source headline when the central one is foreign', () => {
    const out = summarise([
      ['Globo', 'Endrick sofre lesão na coxa e desfalca o Real Madrid'],
      ['UOL', 'Endrick tem lesão na coxa e desfalca o Real Madrid contra o Barcelona'],
      ['ESPN', 'Real Madrid striker Endrick ruled out with thigh injury'],
    ]);
    assert.equal(out.headline, 'Real Madrid striker Endrick ruled out with thigh injury');
    assert.ok(out.aiSummaryBullets[0]!.startsWith('ESPN reports: Real Madrid striker'));
    assert.ok(out.metaDescription.startsWith('Real Madrid striker Endrick'));
  });

  it('keeps the central headline when it is not foreign, or nothing is English', () => {
    const english = summarise([
      ['ABC', 'Matildas keeper reveals career-threatening health scare'],
      ['SBS', 'Matildas keeper health scare revealed'],
      ['Guardian', 'Coach says the squad is behind the Matildas keeper'],
    ]);
    assert.equal(english.headline, 'Matildas keeper reveals career-threatening health scare');
    const portuguese = summarise([
      ['Globo', 'Endrick sofre lesão na coxa e desfalca o Real Madrid'],
      ['UOL', 'Endrick tem lesão na coxa e desfalca o Real Madrid'],
    ]);
    assert.match(portuguese.headline, /^Endrick (sofre|tem) lesão/);
  });
});

describe('failed AI call on a stored story', () => {
  const fallback = heuristicSummary({
    countryCode: 'IN',
    countryName: 'India',
    articles: [
      {
        publisherName: 'NDTV',
        title: 'Tensions rise over Karthigai Deepam lighting in Tamil Nadu',
        snippet: '',
        publishedAt: hoursAgo(1),
      },
    ],
    metrics: { viralScore: 95, publishers: 4, velocity: 80, search: 0, trendKeyword: null },
  });
  const aiText = { aiContextParagraph: 'Protests broke out over the lamp lighting.' };

  it('keeps stored AI text instead of the non-AI fallback', () => {
    assert.ok(keepsStoredAiText({ isNew: false, existing: aiText }, fallback));
  });

  it('still replaces it with a new AI summary', () => {
    const fresh = { aiContextParagraph: 'Police detained activists at the hill.' };
    assert.ok(!keepsStoredAiText({ isNew: false, existing: aiText }, fresh));
  });

  it('uses the fallback for new and repaired stories and for stored fallback text', () => {
    assert.ok(!keepsStoredAiText({ isNew: true }, fallback));
    assert.ok(!keepsStoredAiText({ isNew: true, existing: aiText }, fallback)); // repaired
    assert.ok(!keepsStoredAiText({ isNew: false, existing: fallback }, fallback));
  });
});

describe('model environment variables', async () => {
  const { createSummarizer } = await import('./intelligence/generateAiSummaries.ts');
  it('treats an empty GEMINI_MODEL / OPENAI_MODEL (unset GitHub variable) as unset', () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.OPENAI_API_KEY = 'k';
    process.env.GEMINI_MODEL = '';
    process.env.OPENAI_MODEL = '  ';
    try {
      assert.equal(createSummarizer('gemini').model, 'gemini-3.1-flash-lite');
      assert.equal(createSummarizer('openai').model, 'gpt-5-mini');
      process.env.GEMINI_MODEL = 'gemini-custom';
      assert.equal(createSummarizer('gemini').model, 'gemini-custom');
    } finally {
      for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'GEMINI_MODEL', 'OPENAI_MODEL'])
        delete process.env[k];
    }
  });
});

describe('model output normalisation', async () => {
  const { normalizeModelOutput, createSummarizer } =
    await import('./intelligence/generateAiSummaries.ts');
  const longTag = 'The Extraordinarily Long Name Of A Government Programme';
  const base = {
    headline: 'Bank Indonesia Holds Benchmark Rate Steady Amid Rupiah Pressure',
    seoTitle: 'Bank Indonesia Holds Benchmark Rate Steady',
    metaDescription:
      'Bank Indonesia kept its benchmark interest rate unchanged, according to three outlets, as markets watched the rupiah.',
    slug: 'bank-indonesia-holds-benchmark-rate',
    aiSummaryBullets: ['Bank Indonesia kept its policy rate.', 'Outlets linked it to the rupiah.'],
    aiContextParagraph:
      'Bank Indonesia announced its monthly policy decision, according to outlets. '.repeat(4),
    whyItIsViral: 'Three outlets covered the decision within hours.',
    categorySlug: 'economy-business',
    entityTags: ['Bank Indonesia', 'Rupiah'],
  };

  it('drops over-long tags but keeps the rest', () => {
    const out = normalizeModelOutput({
      ...base,
      entityTags: [longTag, 'Bank Indonesia'],
    }) as typeof base;
    assert.deepEqual(out.entityTags, ['Bank Indonesia']);
  });

  it('shortens the first tag when every tag is too long, and caps tags at 4', () => {
    const one = normalizeModelOutput({ ...base, entityTags: [longTag, longTag] }) as typeof base;
    assert.equal(one.entityTags.length, 1);
    assert.ok(one.entityTags[0]!.length <= 40);
    const many = normalizeModelOutput({
      ...base,
      entityTags: ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'],
    }) as typeof base;
    assert.equal(many.entityTags.length, 4);
  });

  it('truncates over-long text and extra bullets; leaves short text for validation to reject', () => {
    const out = normalizeModelOutput({
      ...base,
      headline: 'Word '.repeat(40),
      aiSummaryBullets: [
        'First bullet text here.',
        'Second bullet text.',
        'Third one here.',
        'Fourth one.',
        'Fifth one.',
      ],
    }) as typeof base;
    assert.ok(out.headline.length <= 110);
    assert.equal(out.aiSummaryBullets.length, 4);
    const short = normalizeModelOutput({ ...base, headline: 'Too short' }) as typeof base;
    assert.equal(short.headline, 'Too short');
  });

  it('a reply with one over-long tag is now accepted as an AI summary', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ ...base, entityTags: [longTag, 'Rupiah'] }) }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    try {
      const r = await createSummarizer('gemini').summarize({
        countryCode: 'ID',
        countryName: 'Indonesia',
        articles: [
          {
            publisherName: 'Antara',
            title: 'Bank Indonesia holds rate',
            snippet: '',
            publishedAt: hoursAgo(1),
          },
        ],
        metrics: { viralScore: 60, publishers: 2, velocity: 60, search: 0, trendKeyword: null },
      });
      assert.equal(r.usedAi, true, r.error?.detail);
      assert.deepEqual(r.output.entityTags, ['Rupiah']);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GEMINI_API_KEY;
    }
  });
});

describe('batch schedule', async () => {
  const { readFile } = await import('node:fs/promises');
  const { VAS } = await import('../../src/lib/scoring.ts');

  it('next scheduled batch is the next 3-hour WIB slot plus the cron minute', () => {
    // 03:20Z (10:20 WIB) → next slot 12:17 WIB = 05:17Z
    assert.equal(
      nextScheduledBatch(new Date('2026-11-06T03:20:00Z')).toISOString(),
      '2026-11-06T05:17:00.000Z',
    );
    // A run that starts at 05:17:30Z (slightly late) → the following slot, 08:17Z
    assert.equal(
      nextScheduledBatch(new Date('2026-11-06T05:17:30Z')).toISOString(),
      '2026-11-06T08:17:00.000Z',
    );
    // A manual run at 05:05Z, before the slot's minute → still today's 05:17Z
    assert.equal(
      nextScheduledBatch(new Date('2026-11-06T05:05:00Z')).toISOString(),
      '2026-11-06T05:17:00.000Z',
    );
  });

  it('the workflow cron minute matches VAS.batchCronMinute', async () => {
    const yml = await readFile(
      new URL('../../.github/workflows/update-viral-batch.yml', import.meta.url),
      'utf8',
    );
    const cron = /cron: '(\d+) 2-23\/3 \* \* \*'/.exec(yml);
    assert.ok(cron, 'batch cron not found');
    assert.equal(Number(cron[1]), VAS.batchCronMinute);
  });
});

// Cases from Search Console (Nov 2026): page-1 stories whose updated titles lost the names
// people searched for ("gayo lues regency floods", "giring ganesha") and got no clicks.
describe('story names in titles', () => {
  const output = (seoTitle: string, headline: string, entityTags: string[] = []) =>
    ({ ...heuristicSummary(input), seoTitle, headline, entityTags }) as ReturnType<
      typeof heuristicSummary
    >;
  const input = {
    countryCode: 'ID',
    countryName: 'Indonesia',
    articles: [
      {
        publisherName: 'A',
        title: 'Banjir bandang di Gayo Lues',
        snippet: '',
        publishedAt: '2026-11-08T08:00:00Z',
      },
    ],
    metrics: { viralScore: 50, publishers: 1, velocity: 10, search: 0, trendKeyword: null },
  };

  it('anchors are entity names whose words are all in the slug', () => {
    const slug = 'giring-ganesha-resigns-from-psi-party';
    assert.deepEqual(
      storyAnchors(slug, ['Partai Solidaritas Indonesia', 'Giring Ganesha', 'Raja Juli Antoni']),
      ['Giring Ganesha'],
    );
    assert.deepEqual(
      storyAnchors('flash-floods-damage-gayo-lues-aceh', ['BPBD', 'Aceh', 'Bengkulu', 'Flooding']),
      ['Aceh'],
    );
  });

  it('matches whole words, folding plurals and accents', () => {
    assert.ok(namesAnchor('Floods Hit Gayo Lues, Aceh', ['Gayo Lues']));
    assert.ok(namesAnchor('São Paulo Metro Strike', ['Sao Paulo']));
    assert.ok(!namesAnchor('Acehnese Families Displaced', ['Aceh']));
    assert.ok(!namesAnchor('Ganesha Statue Unveiled', ['Giring Ganesha']));
  });

  it('a generalised update title falls back to a headline that keeps the name', () => {
    const previous = {
      slug: 'giring-ganesha-resigns-from-psi-party',
      seoTitle: 'Three Senior PSI Officials Resign From Party',
      entityTags: ['Giring Ganesha', 'Raja Juli Antoni'],
    };
    const r = keepStoryNames(
      output(
        'Three Senior PSI Officials Resign From Party',
        'Giring Ganesha and Two Others Quit PSI',
      ),
      previous,
    );
    assert.equal(r.check, 'headline');
    assert.equal(r.output.seoTitle, 'Giring Ganesha and Two Others Quit PSI');
  });

  it('then to the previous title when only it has the name', () => {
    const r = keepStoryNames(
      output(
        'Flash Floods Impact Multiple Regions Across Indonesia',
        'Flash Floods Impact Thousands of Families Across Several Indonesian Provinces',
        ['BPBD', 'Aceh'],
      ),
      {
        slug: 'flash-floods-damage-gayo-lues-aceh',
        seoTitle: 'Flash Floods Damage Homes in Gayo Lues, Aceh',
        entityTags: ['Gayo Lues', 'BPBD'],
      },
    );
    assert.equal(r.check, 'previous');
    assert.equal(r.output.seoTitle, 'Flash Floods Damage Homes in Gayo Lues, Aceh');
  });

  it('leaves titles that keep a name, and stories without anchors, alone', () => {
    const previous = {
      slug: 'senior-politician-panda-nababan-passes-away',
      seoTitle: 'Panda Nababan Dies at 82',
      entityTags: ['Panda Nababan', 'PDIP'],
    };
    const kept = output('Panda Nababan Funeral Details Announced', 'Funeral Set For Panda Nababan');
    assert.equal(keepStoryNames(kept, previous).check, 'kept');
    assert.equal(keepStoryNames(kept, previous).output, kept);
    const none = keepStoryNames(output('Markets Fall Sharply', 'Markets Fall Sharply'), {
      slug: 'stock-markets-fall-sharply',
      seoTitle: 'Markets Fall',
      entityTags: ['Jakarta Composite Index'],
    });
    assert.equal(none.check, 'no-anchor');
  });

  it('never drops a name the current title has, even when another survives', () => {
    const previous = {
      slug: 'federal-police-investigates-threats-deputy-ana-elisa',
      seoTitle: 'Federal Police Investigate Threats Against Ana Elisa',
      entityTags: ['Federal Police', 'Ana Elisa', 'Andrei Rodrigues'],
    };
    const r = keepStoryNames(
      output(
        'Senator Claims Federal Police Interference',
        'Senator Claims Interference by Andrei Rodrigues in Federal Police',
      ),
      previous,
    );
    assert.equal(r.check, 'previous');
    assert.equal(r.output.seoTitle, previous.seoTitle);
    const both = output('Federal Police Protect Deputy Ana Elisa', 'Ana Elisa Gets Protection');
    assert.equal(keepStoryNames(both, previous).check, 'kept');
  });

  it('reports a title it cannot repair', () => {
    const r = keepStoryNames(output('Party Officials Resign', 'Party Officials Resign'), {
      slug: 'giring-ganesha-resigns-from-psi-party',
      seoTitle: 'PSI Officials Resign',
      entityTags: ['Giring Ganesha'],
    });
    assert.equal(r.check, 'missing');
    assert.equal(r.output.seoTitle, 'Party Officials Resign');
  });
});

describe('sourcing policy (robots.txt)', () => {
  it('counts the AI companies whose agents are blocked from the whole site', () => {
    const txt = `User-agent: *
Disallow: /admin/

User-agent: GPTBot
User-agent: ChatGPT-User
Disallow: /

User-agent: ClaudeBot
Disallow: / # no AI

User-agent: Google-Extended
Allow: /

User-agent: CCBot
Disallow: /private/`;
    assert.deepEqual(aiCompaniesBlocked(txt), ['OpenAI', 'Anthropic']);
    assert.ok(isAiOptOut(aiCompaniesBlocked(txt)));
  });

  it('one company, or none, is not an opt-out', () => {
    assert.ok(!isAiOptOut(aiCompaniesBlocked('User-agent: GPTBot\nDisallow: /')));
    assert.ok(!isAiOptOut(aiCompaniesBlocked('User-agent: *\nDisallow: /search')));
    assert.deepEqual(aiCompaniesBlocked(''), []);
  });

  it('an explicit Allow: / for the agent wins', () => {
    const txt = 'User-agent: ClaudeBot\nDisallow: /\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /';
    assert.deepEqual(aiCompaniesBlocked(txt), ['OpenAI']);
  });

  it('source ids are unique and every country keeps a source that allows AI', () => {
    const ids = RSS_SOURCES.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    const countries = new Set(RSS_SOURCES.map((s) => s.homeCountry).filter(Boolean));
    for (const cc of countries)
      assert.ok(
        RSS_SOURCES.some((s) => s.homeCountry === cc && !s.aiOptOut),
        `${cc} relies only on aiOptOut sources`,
      );
  });
});
