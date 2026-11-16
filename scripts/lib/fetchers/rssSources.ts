/**
 * Curated Indonesian & global RSS feeds (plan §7.2 step 1). Every URL below was probed
 * and returned a valid feed on 2026-11-06. Feeds fail independently — a dead feed is
 * logged in batch-meta `pipeline.feedsFailed` and never aborts the batch.
 *
 * `homeCountry` is the outlet's country: articles default to it when the headline
 * does not clearly name another tracked country. Global wires use `null`, so their
 * articles are kept only when a country can be detected.
 *
 * Not included (probed and unavailable): Kompas (no public feed), The Jakarta Post,
 * The Star (404), Globo g1 (403), Korea Herald (empty feed), Tribunnews (403), Tempo.
 *
 * Tempo: since 2026-11-16 every tempo.co feed URL answers with a Cloudflare "Attention
 * Required" challenge (HTTP 403) for any automated client, whatever its user agent. That is
 * a deliberate block, so the source was removed rather than worked around; VIVA and
 * Okezone replace it. Re-add Tempo only if they allowlist EarthViralBot.
 *
 * Re-checked 2026-11-07: Nation Africa (an intermittent 404 on 2026-11-06) works; Capital FM
 * and KBC were added so Kenya keeps coverage when one outlet is down.
 *
 * Content policies are per publisher domain (src/lib/publisherPolicy.ts) and apply to every
 * article from that domain, including GDELT ones. `environments` limits where a feed is
 * fetched: a source under review is listed for 'staging' only, so production never reads it.
 */
import type { SiteEnvironment } from '../../../src/lib/environment.ts';
import { policyForDomain, type PolicyRegistries } from '../../../src/lib/publisherPolicy.ts';

export interface RssSource {
  id: string;
  publisherName: string;
  publisherDomain: string;
  url: string;
  homeCountry: string | null;
  language: 'id' | 'en' | 'pt' | 'fr';
  /** Environments whose batch fetches this feed (default: all). */
  environments?: readonly SiteEnvironment[];
}

/** Feeds fetched by the batch in `environment`; removed publishers are never fetched. */
export function activeSources(
  environment: SiteEnvironment,
  sources: readonly RssSource[] = RSS_SOURCES,
  registries: PolicyRegistries = {},
): RssSource[] {
  return sources.filter(
    (s) =>
      (s.environments ?? ['production', 'staging']).includes(environment) &&
      policyForDomain(s.publisherDomain, registries.policies, registries.removed).mode !==
        'removed',
  );
}

export const RSS_SOURCES: RssSource[] = [
  // ── Indonesia (launch market) ─────────────────────────────────────────────
  {
    id: 'antara',
    publisherName: 'Antara',
    publisherDomain: 'antaranews.com',
    url: 'https://www.antaranews.com/rss/terkini.xml',
    homeCountry: 'ID',
    language: 'id',
  },
  {
    id: 'detik',
    publisherName: 'Detik',
    publisherDomain: 'detik.com',
    url: 'https://news.detik.com/rss',
    homeCountry: 'ID',
    language: 'id',
  },
  {
    id: 'cnn-id',
    publisherName: 'CNN Indonesia',
    publisherDomain: 'cnnindonesia.com',
    url: 'https://www.cnnindonesia.com/nasional/rss',
    homeCountry: 'ID',
    language: 'id',
  },
  {
    id: 'cnbc-id',
    publisherName: 'CNBC Indonesia',
    publisherDomain: 'cnbcindonesia.com',
    url: 'https://www.cnbcindonesia.com/news/rss',
    homeCountry: 'ID',
    language: 'id',
  },
  {
    id: 'republika',
    publisherName: 'Republika',
    publisherDomain: 'republika.co.id',
    url: 'https://www.republika.co.id/rss',
    homeCountry: 'ID',
    language: 'id',
  },
  {
    id: 'viva',
    publisherName: 'VIVA',
    publisherDomain: 'viva.co.id',
    // All sections, ~100 latest items. Probed 2026-11-17.
    url: 'https://www.viva.co.id/get/all',
    homeCountry: 'ID',
    language: 'id',
  },
  {
    id: 'okezone',
    publisherName: 'Okezone',
    publisherDomain: 'okezone.com',
    // Syndication feed across sections (news, economy, sports, celebrity); article links use
    // section subdomains such as news.okezone.com. Probed 2026-11-17.
    url: 'https://sindikasi.okezone.com/index.php/rss/0/RSS2.0',
    homeCountry: 'ID',
    language: 'id',
  },

  // ── Global wires & international desks ────────────────────────────────────
  {
    id: 'bbc-world',
    publisherName: 'BBC',
    publisherDomain: 'bbc.com',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    homeCountry: null,
    language: 'en',
  },
  {
    id: 'guardian-world',
    publisherName: 'The Guardian',
    publisherDomain: 'theguardian.com',
    url: 'https://www.theguardian.com/world/rss',
    homeCountry: null,
    language: 'en',
  },
  {
    id: 'aljazeera',
    publisherName: 'Al Jazeera',
    publisherDomain: 'aljazeera.com',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    homeCountry: null,
    language: 'en',
  },
  {
    id: 'france24',
    publisherName: 'France 24',
    publisherDomain: 'france24.com',
    url: 'https://www.france24.com/en/rss',
    homeCountry: null,
    language: 'en',
  },
  {
    id: 'dw',
    publisherName: 'Deutsche Welle',
    publisherDomain: 'dw.com',
    url: 'https://rss.dw.com/xml/rss-en-all',
    homeCountry: null,
    language: 'en',
  },

  // ── National outlets ──────────────────────────────────────────────────────
  {
    id: 'bbc-uk',
    publisherName: 'BBC',
    publisherDomain: 'bbc.com',
    url: 'https://feeds.bbci.co.uk/news/uk/rss.xml',
    homeCountry: 'GB',
    language: 'en',
  },
  {
    id: 'npr',
    publisherName: 'NPR',
    publisherDomain: 'npr.org',
    url: 'https://feeds.npr.org/1001/rss.xml',
    homeCountry: 'US',
    language: 'en',
  },
  {
    id: 'cbs',
    publisherName: 'CBS News',
    publisherDomain: 'cbsnews.com',
    url: 'https://www.cbsnews.com/latest/rss/main',
    homeCountry: 'US',
    language: 'en',
  },
  {
    id: 'toi',
    publisherName: 'Times of India',
    publisherDomain: 'timesofindia.indiatimes.com',
    url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms',
    homeCountry: 'IN',
    language: 'en',
  },
  {
    id: 'the-hindu',
    publisherName: 'The Hindu',
    publisherDomain: 'thehindu.com',
    url: 'https://www.thehindu.com/news/national/feeder/default.rss',
    homeCountry: 'IN',
    language: 'en',
  },
  {
    id: 'straits-times',
    publisherName: 'The Straits Times',
    publisherDomain: 'straitstimes.com',
    url: 'https://www.straitstimes.com/news/singapore/rss.xml',
    homeCountry: 'SG',
    language: 'en',
  },
  {
    id: 'cna',
    publisherName: 'CNA',
    publisherDomain: 'channelnewsasia.com',
    url: 'https://www.channelnewsasia.com/rssfeeds/8395986',
    homeCountry: 'SG',
    language: 'en',
  },
  {
    id: 'malay-mail',
    publisherName: 'Malay Mail',
    publisherDomain: 'malaymail.com',
    url: 'https://www.malaymail.com/feed/rss/malaysia',
    homeCountry: 'MY',
    language: 'en',
  },
  {
    id: 'abc-au',
    publisherName: 'ABC',
    publisherDomain: 'abc.net.au',
    url: 'https://www.abc.net.au/news/feed/51120/rss.xml',
    homeCountry: 'AU',
    language: 'en',
  },
  {
    id: 'yonhap',
    publisherName: 'Yonhap',
    publisherDomain: 'en.yna.co.kr',
    url: 'https://en.yna.co.kr/RSS/news.xml',
    homeCountry: 'KR',
    language: 'en',
  },
  {
    id: 'japan-times',
    publisherName: 'The Japan Times',
    publisherDomain: 'japantimes.co.jp',
    url: 'https://www.japantimes.co.jp/feed/',
    homeCountry: 'JP',
    language: 'en',
  },
  {
    id: 'punch',
    publisherName: 'Punch',
    publisherDomain: 'punchng.com',
    url: 'https://punchng.com/feed/',
    homeCountry: 'NG',
    language: 'en',
  },
  {
    id: 'premium-times',
    publisherName: 'Premium Times',
    publisherDomain: 'premiumtimesng.com',
    url: 'https://www.premiumtimesng.com/feed',
    homeCountry: 'NG',
    language: 'en',
  },
  {
    id: 'nation-ke',
    publisherName: 'Nation Africa',
    publisherDomain: 'nation.africa',
    url: 'https://nation.africa/kenya/rss.xml',
    homeCountry: 'KE',
    language: 'en',
  },
  {
    id: 'capitalfm-ke',
    publisherName: 'Capital FM',
    publisherDomain: 'capitalfm.co.ke',
    url: 'https://www.capitalfm.co.ke/news/feed/',
    homeCountry: 'KE',
    language: 'en',
  },
  {
    id: 'kbc-ke',
    publisherName: 'KBC',
    publisherDomain: 'kbc.co.ke',
    url: 'https://www.kbc.co.ke/feed/',
    homeCountry: 'KE',
    language: 'en',
  },
  {
    id: 'standard-ke',
    publisherName: 'The Standard',
    publisherDomain: 'standardmedia.co.ke',
    url: 'https://www.standardmedia.co.ke/rss/headlines.php',
    homeCountry: 'KE',
    language: 'en',
  },
  {
    id: 'mexico-news-daily',
    publisherName: 'Mexico News Daily',
    publisherDomain: 'mexiconewsdaily.com',
    url: 'https://mexiconewsdaily.com/feed/',
    homeCountry: 'MX',
    language: 'en',
  },
  {
    id: 'le-monde-en',
    publisherName: 'Le Monde',
    publisherDomain: 'lemonde.fr',
    url: 'https://www.lemonde.fr/en/rss/une.xml',
    homeCountry: 'FR',
    language: 'en',
  },
  {
    id: 'folha',
    publisherName: 'Folha de S.Paulo',
    publisherDomain: 'folha.uol.com.br',
    url: 'https://feeds.folha.uol.com.br/emcimadahora/rss091.xml',
    homeCountry: 'BR',
    language: 'pt',
  },

  // ── Under review: staging only ────────────────────────────────────────────
  {
    // Headline-only terms (src/lib/publisherPolicy.ts HEADLINE_ONLY_POLICY): name, headline,
    // date and URL only; never sent to AI; shown only beside other publishers' coverage.
    // Do not add 'production' until every check in the staging plan §7 has passed review.
    // homeCountry null: AI/tech news is global, so articles are kept only when a tracked
    // country is named.
    id: 'joho-no-todai-en',
    publisherName: 'Joho no Todai',
    publisherDomain: 'joho-todai.com',
    url: 'https://joho-todai.com/en/rss/',
    homeCountry: null,
    language: 'en',
    environments: ['staging'],
  },
];
