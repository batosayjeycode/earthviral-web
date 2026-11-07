/**
 * SAMPLE DATA ONLY — fictional placeholder stories used to develop the UI before
 * the real AI batch pipeline (Phase 3) exists. None of these events are real.
 * Source links point to publisher homepages, not to real articles.
 *
 * The generator marks the batch `isSeed: true`, which makes every page render a
 * "Sample data" badge and `noindex`, so this content can never be indexed.
 */
import type { CategorySlug } from '../../src/lib/taxonomy.ts';

export const PUBLISHERS: Record<string, string> = {
  Kompas: 'kompas.com',
  Detik: 'detik.com',
  Antara: 'antaranews.com',
  Tempo: 'tempo.co',
  'CNN Indonesia': 'cnnindonesia.com',
  Reuters: 'reuters.com',
  'Associated Press': 'apnews.com',
  BBC: 'bbc.com',
  NHK: 'nhk.or.jp',
  'The Guardian': 'theguardian.com',
  'The Hindu': 'thehindu.com',
  'Times of India': 'timesofindia.indiatimes.com',
  'Folha de S.Paulo': 'folha.uol.com.br',
  Yonhap: 'en.yna.co.kr',
  'Deutsche Welle': 'dw.com',
  Punch: 'punchng.com',
  ABC: 'abc.net.au',
  'The Star': 'thestar.com.my',
  'The Straits Times': 'straitstimes.com',
  'El Universal': 'eluniversal.com.mx',
  'Le Monde': 'lemonde.fr',
  'Nation Africa': 'nation.africa',
};

export interface SeedStory {
  country: string;
  category: CategorySlug;
  slug: string;
  headline: string;
  whyItIsViral: string;
  bullets: [string, string, string];
  context: string;
  score: number;
  velocity: number;
  search: number;
  publishers: string[];
  tags: string[];
  hoursAgo: number;
}

export const SEED_STORIES: SeedStory[] = [
  // ── Indonesia (deep launch market) ────────────────────────────────────────
  {
    country: 'ID',
    category: 'sports',
    slug: 'timnas-indonesia-world-cup-qualifier-surge',
    headline: 'Timnas Indonesia Late Winner Sparks Nationwide Qualifier Celebrations',
    whyItIsViral:
      'A stoppage-time goal pushed national-team searches to a 12-month high within two hours of the final whistle.',
    bullets: [
      'Sample story: a late goal keeps Indonesia in contention for the next qualifying round.',
      'Fan clips from viewing parties in Jakarta, Surabaya and Medan spread rapidly across social platforms.',
      'Coverage expanded from sports desks to front pages within one batch window.',
    ],
    context:
      'This placeholder cluster illustrates how EarthViral presents a fast-moving sports story. Multiple outlets reported on a dramatic late result in a qualifying fixture, and search interest for the national team climbed sharply in the hours that followed. The cluster groups match reports, fan-reaction pieces and analysis of the qualification table into a single page, with links back to every original publisher.',
    score: 96,
    velocity: 94,
    search: 98,
    publishers: ['Kompas', 'Detik', 'Antara', 'CNN Indonesia', 'Tempo'],
    tags: ['Timnas Indonesia', 'World Cup Qualifiers'],
    hoursAgo: 5,
  },
  {
    country: 'ID',
    category: 'politics-government',
    slug: 'ikn-nusantara-relocation-timeline-update',
    headline: 'IKN Nusantara Ministry Relocation Timeline Draws Fresh Debate',
    whyItIsViral:
      'An updated relocation schedule triggered a spike in explainer coverage and public questions about the move.',
    bullets: [
      'Sample story: officials publish a revised phase plan for moving ministries to the new capital.',
      'Commentators compare the new schedule with earlier targets.',
      'Regional outlets focus on the impact for civil-servant families.',
    ],
    context:
      'This placeholder cluster shows a policy story with steady, multi-day coverage. Reporting centres on a revised timeline for relocating government offices to the new capital region, with outlets publishing explainers, cost discussions and reactions from affected workers. The page brings those angles together and links each one to its original source.',
    score: 89,
    velocity: 82,
    search: 85,
    publishers: ['Kompas', 'Tempo', 'Antara', 'Detik'],
    tags: ['IKN Nusantara', 'Capital Relocation'],
    hoursAgo: 14,
  },
  {
    country: 'ID',
    category: 'economy-business',
    slug: 'bank-indonesia-rate-decision-rupiah-reaction',
    headline: 'Bank Indonesia Rate Decision Moves Rupiah and Bank Stocks',
    whyItIsViral: 'Currency and mortgage-rate searches surged right after the policy announcement.',
    bullets: [
      'Sample story: the central bank announces its monthly policy-rate decision.',
      'The rupiah and listed bank shares react within the trading session.',
      'Personal-finance outlets publish guides on what the move means for loans.',
    ],
    context:
      'This placeholder cluster demonstrates how an economic announcement becomes a viral topic. Coverage spans market reaction, analyst commentary and consumer-focused explainers about loans and savings. EarthViral groups these into one story page and scores it on publisher breadth, coverage velocity and public search interest.',
    score: 78,
    velocity: 74,
    search: 80,
    publishers: ['Kompas', 'CNN Indonesia', 'Reuters'],
    tags: ['Bank Indonesia', 'Rupiah'],
    hoursAgo: 9,
  },
  {
    country: 'ID',
    category: 'disasters-world-events',
    slug: 'east-java-flash-flood-evacuations',
    headline: 'East Java Flash Floods Prompt Evacuations Across Three Districts',
    whyItIsViral:
      'Residents shared live footage while local agencies posted evacuation updates, driving rapid coverage growth.',
    bullets: [
      'Sample story: heavy overnight rain causes flash flooding in several districts.',
      'Local disaster agencies coordinate evacuations and temporary shelters.',
      'Weather services warn of further rainfall over the next 48 hours.',
    ],
    context:
      'This placeholder cluster represents a developing disaster story. Reporting combines official agency updates, on-the-ground footage and weather forecasts. The story page highlights verified sources first and is refreshed with each three-hour batch while coverage remains active.',
    score: 71,
    velocity: 77,
    search: 66,
    publishers: ['Antara', 'Detik', 'Kompas'],
    tags: ['East Java', 'Flood'],
    hoursAgo: 4,
  },
  {
    country: 'ID',
    category: 'entertainment-celebrity',
    slug: 'indonesian-horror-film-box-office-record',
    headline: 'Indonesian Horror Film Breaks Opening-Weekend Box Office Record',
    whyItIsViral: 'Cinema queue videos and ticket-sale screenshots trended through the weekend.',
    bullets: [
      'Sample story: a local horror release posts a record opening weekend.',
      'Cinemas add late-night screenings to meet demand.',
      'Critics discuss the continued strength of the local horror genre.',
    ],
    context:
      'This placeholder cluster shows an entertainment trend driven by audience behaviour rather than an official announcement. Coverage mixes box-office reporting, reviews and social-media reaction. The page links to each review and report so readers can go to the original coverage.',
    score: 63,
    velocity: 60,
    search: 70,
    publishers: ['Kompas', 'Detik'],
    tags: ['Indonesian Cinema', 'Box Office'],
    hoursAgo: 20,
  },

  // ── Global ────────────────────────────────────────────────────────────────
  {
    country: 'US',
    category: 'technology-ai',
    slug: 'ai-chip-export-policy-update',
    headline: 'New AI Chip Export Rules Ripple Through Global Tech Markets',
    whyItIsViral:
      'Semiconductor stocks moved sharply and search interest for export rules climbed across Asia and Europe.',
    bullets: [
      'Sample story: updated export rules for advanced AI chips are announced.',
      'Chipmakers and cloud providers assess the impact on overseas sales.',
      'Analysts debate the effect on AI development timelines.',
    ],
    context:
      'This placeholder cluster illustrates a technology-policy story with global reach. Coverage includes market reaction, industry statements and explainers about which products are affected, with particular attention on suppliers in Japan and South Korea and on the wider Artificial Intelligence industry. Because the story is covered in many countries, it also feeds the global Technology & AI hub.',
    score: 91,
    velocity: 88,
    search: 90,
    publishers: ['Reuters', 'Associated Press', 'BBC', 'The Guardian'],
    tags: ['AI Chips', 'Export Controls', 'Artificial Intelligence'],
    hoursAgo: 7,
  },
  {
    country: 'US',
    category: 'entertainment-celebrity',
    slug: 'streaming-finale-breaks-viewing-record',
    headline: 'Streaming Series Finale Sets Global Same-Day Viewing Record',
    whyItIsViral:
      'Spoiler discussions and reaction videos dominated social feeds within hours of release.',
    bullets: [
      'Sample story: a popular series finale posts record first-day viewing.',
      'Fan theories and reactions trend across multiple platforms.',
      'Critics are split on the ending.',
    ],
    context:
      'This placeholder cluster shows a global entertainment moment. Reporting covers viewing figures, reviews and audience reaction. The page groups that coverage and links to each original review.',
    score: 74,
    velocity: 79,
    search: 76,
    publishers: ['Associated Press', 'The Guardian', 'BBC'],
    tags: ['Streaming', 'TV Finale'],
    hoursAgo: 11,
  },
  {
    country: 'JP',
    category: 'technology-ai',
    slug: 'japan-ai-regulation-framework-draft',
    headline: 'Japan Publishes Draft AI Governance Framework for Public Comment',
    whyItIsViral:
      'Business groups and developers responded quickly, making the draft a top technology topic in Japan.',
    bullets: [
      'Sample story: a draft framework sets out voluntary AI safety guidelines.',
      'Industry groups welcome the light-touch approach.',
      'Civil-society groups call for stronger transparency rules.',
    ],
    context:
      'This placeholder cluster demonstrates a regulation story followed by both domestic and international outlets. Coverage summarises the draft, collects reactions and compares it with approaches elsewhere. Related clusters in the Technology & AI category are linked from the page.',
    score: 86,
    velocity: 80,
    search: 84,
    publishers: ['NHK', 'Reuters', 'BBC'],
    tags: ['AI Regulation', 'Artificial Intelligence'],
    hoursAgo: 6,
  },
  {
    country: 'GB',
    category: 'economy-business',
    slug: 'uk-budget-household-energy-measures',
    headline: 'UK Budget Household Energy Measures Dominate Personal-Finance Searches',
    whyItIsViral:
      'Energy-bill calculators and explainers drove a surge in search traffic after the statement.',
    bullets: [
      'Sample story: the budget includes new measures on household energy costs.',
      'Consumer groups publish estimates of what households will save.',
      'Economists question the long-term cost.',
    ],
    context:
      'This placeholder cluster shows an economic story with strong consumer search interest. Coverage combines the official announcement, analysis and practical explainers.',
    score: 68,
    velocity: 64,
    search: 74,
    publishers: ['BBC', 'The Guardian', 'Reuters'],
    tags: ['UK Budget', 'Energy Bills'],
    hoursAgo: 10,
  },
  {
    country: 'IN',
    category: 'sports',
    slug: 'india-cricket-series-clinching-win',
    headline: 'India Clinches Cricket Series With Record Run Chase',
    whyItIsViral:
      'Highlight clips of the record chase were among the most shared sports videos of the day.',
    bullets: [
      'Sample story: India completes a record run chase to win the series.',
      'A young batter reaches a maiden century.',
      'Ticket demand for the next series rises sharply.',
    ],
    context:
      'This placeholder cluster illustrates a high-velocity sports story in a large market. Reporting includes match reports, player profiles and record statistics.',
    score: 88,
    velocity: 92,
    search: 87,
    publishers: ['The Hindu', 'Times of India', 'BBC'],
    tags: ['Cricket', 'Team India'],
    hoursAgo: 3,
  },
  {
    country: 'BR',
    category: 'social-issues',
    slug: 'brazil-amazon-heatwave-water-shortage',
    headline: 'Amazon Heatwave Leaves River Communities Facing Water Shortages',
    whyItIsViral: 'Aerial images of low river levels spread widely and prompted calls for aid.',
    bullets: [
      'Sample story: record heat lowers river levels used for transport and drinking water.',
      'Local authorities organise emergency water deliveries.',
      'Scientists link the event to longer-term climate trends.',
    ],
    context:
      'This placeholder cluster shows a social and environmental story with international interest. Coverage blends on-the-ground reporting, official response and scientific context.',
    score: 66,
    velocity: 61,
    search: 58,
    publishers: ['Folha de S.Paulo', 'Reuters', 'BBC'],
    tags: ['Amazon', 'Climate'],
    hoursAgo: 16,
  },
  {
    country: 'KR',
    category: 'entertainment-celebrity',
    slug: 'kpop-world-tour-announcement-ticket-rush',
    headline: 'K-Pop World Tour Announcement Triggers Global Ticket Rush',
    whyItIsViral:
      'Ticket queues numbering in the hundreds of thousands trended in more than 20 countries.',
    bullets: [
      'Sample story: a major group announces a world tour including Southeast Asian dates.',
      'Ticketing sites report heavy queues within minutes.',
      'Fans in Jakarta and Kuala Lumpur campaign for extra shows.',
    ],
    context:
      'This placeholder cluster illustrates cross-border entertainment demand. Coverage includes the announcement, ticketing problems and fan reaction across several countries.',
    score: 84,
    velocity: 90,
    search: 88,
    publishers: ['Yonhap', 'The Straits Times', 'The Star'],
    tags: ['K-Pop', 'World Tour'],
    hoursAgo: 8,
  },
  {
    country: 'DE',
    category: 'economy-business',
    slug: 'germany-automaker-ev-factory-investment',
    headline: 'German Automaker Commits to New EV Battery Plant Investment',
    whyItIsViral: 'Industry and regional outlets covered the jobs and supply-chain angle.',
    bullets: [
      'Sample story: an automaker announces a large battery-plant investment.',
      'Regional officials welcome the expected new jobs.',
      'Analysts see the move as a response to competition in electric vehicles.',
    ],
    context:
      'This placeholder cluster represents an industry story with moderate, steady coverage.',
    score: 52,
    velocity: 48,
    search: 45,
    publishers: ['Deutsche Welle', 'Reuters'],
    tags: ['Electric Vehicles', 'Batteries'],
    hoursAgo: 18,
  },
  {
    country: 'NG',
    category: 'lifestyle-culture',
    slug: 'lagos-afrobeats-festival-lineup',
    headline: 'Lagos Afrobeats Festival Lineup Announcement Lights Up Social Media',
    whyItIsViral:
      'Lineup posters and artist reactions spread quickly across African music communities.',
    bullets: [
      'Sample story: organisers reveal headline acts for a major music festival.',
      'Early-bird tickets sell out within hours.',
      'Local businesses prepare for a large visitor influx.',
    ],
    context: 'This placeholder cluster shows a culture story with strong social reach.',
    score: 58,
    velocity: 66,
    search: 55,
    publishers: ['Punch', 'BBC'],
    tags: ['Afrobeats', 'Music Festival'],
    hoursAgo: 12,
  },
  {
    country: 'AU',
    category: 'disasters-world-events',
    slug: 'australia-bushfire-season-early-warnings',
    headline: 'Australia Issues Early Bushfire Season Warnings for Eastern States',
    whyItIsViral: 'Emergency-service updates and preparedness guides were widely shared.',
    bullets: [
      'Sample story: fire authorities warn of an early and severe season.',
      'Residents are urged to update their bushfire plans.',
      'Firefighting resources are pre-positioned in high-risk areas.',
    ],
    context:
      'This placeholder cluster illustrates a preparedness story with steady public interest.',
    score: 47,
    velocity: 42,
    search: 50,
    publishers: ['ABC', 'The Guardian'],
    tags: ['Bushfire', 'Emergency Warnings'],
    hoursAgo: 15,
  },
  {
    country: 'MY',
    category: 'politics-government',
    slug: 'malaysia-subsidy-reform-fuel-prices',
    headline: 'Malaysia Fuel Subsidy Reform Prompts Price Questions at the Pump',
    whyItIsViral: 'Drivers shared pump-price comparisons and eligibility questions online.',
    bullets: [
      'Sample story: the government details the next phase of targeted fuel subsidies.',
      'Motorists ask how eligibility will be checked.',
      'Economists discuss the expected fiscal savings.',
    ],
    context: 'This placeholder cluster shows a policy story with a direct consumer impact.',
    score: 61,
    velocity: 58,
    search: 67,
    publishers: ['The Star', 'Reuters'],
    tags: ['Fuel Subsidy', 'Malaysia Economy'],
    hoursAgo: 13,
  },
  {
    country: 'SG',
    category: 'technology-ai',
    slug: 'singapore-ai-talent-programme-launch',
    headline: 'Singapore Launches National AI Talent Programme for Mid-Career Workers',
    whyItIsViral: 'Career-switch discussions picked up across regional professional networks.',
    bullets: [
      'Sample story: a new programme funds AI training for mid-career workers.',
      'Employers sign on to offer placements.',
      'Applicants ask about eligibility and course formats.',
    ],
    context: 'This placeholder cluster shows a regional technology-workforce story.',
    score: 39,
    velocity: 35,
    search: 41,
    publishers: ['The Straits Times'],
    tags: ['Artificial Intelligence', 'Upskilling'],
    hoursAgo: 19,
  },
  {
    country: 'MX',
    category: 'crime-law',
    slug: 'mexico-judicial-reform-court-ruling',
    headline: 'Mexico Court Ruling on Judicial Reform Sparks Legal Debate',
    whyItIsViral: 'Legal scholars and commentators posted rapid analyses of the ruling.',
    bullets: [
      'Sample story: a high court issues a ruling on parts of a judicial reform.',
      'Supporters and critics interpret the outcome differently.',
      'Further legal challenges are expected.',
    ],
    context: 'This placeholder cluster illustrates a legal story with active expert commentary.',
    score: 55,
    velocity: 51,
    search: 49,
    publishers: ['El Universal', 'Reuters'],
    tags: ['Judicial Reform', 'Rule of Law'],
    hoursAgo: 17,
  },
  {
    country: 'FR',
    category: 'lifestyle-culture',
    slug: 'paris-fashion-week-sustainability-shows',
    headline: 'Paris Fashion Week Sustainability Shows Draw Record Online Audience',
    whyItIsViral: 'Runway clips focused on recycled materials were widely shared.',
    bullets: [
      'Sample story: several houses present collections built on recycled materials.',
      'Livestream audiences reach new highs.',
      'Critics discuss whether the trend will last.',
    ],
    context: 'This placeholder cluster shows a culture story with global online reach.',
    score: 32,
    velocity: 30,
    search: 36,
    publishers: ['Le Monde'],
    tags: ['Fashion Week', 'Sustainability'],
    hoursAgo: 21,
  },
  {
    country: 'KE',
    category: 'sports',
    slug: 'kenya-marathon-course-record',
    headline: 'Kenyan Runner Sets New Course Record at Major City Marathon',
    whyItIsViral: 'Finish-line footage and split times circulated widely among running fans.',
    bullets: [
      'Sample story: a Kenyan athlete breaks a long-standing course record.',
      'Training-camp profiles spark interest in the athlete’s background.',
      'Fans speculate about a future world-record attempt.',
    ],
    context:
      'This placeholder cluster illustrates an athletics story with steady international interest.',
    score: 44,
    velocity: 47,
    search: 40,
    publishers: ['Nation Africa', 'BBC'],
    tags: ['Marathon', 'Athletics'],
    hoursAgo: 22,
  },
];
