/**
 * EarthViral 3-hour AI batch generator (plan §7.2, Phase 3).
 *
 *   npm run update:viral                      # full run, writes static JSON
 *   npm run update:viral -- --dry-run         # fetch + cluster + score, print, write nothing
 *   npm run update:viral -- --provider none   # no AI calls (deterministic summaries)
 *
 * Flags:
 *   --provider gemini|openai|none   default: gemini if GEMINI_API_KEY, else openai if OPENAI_API_KEY, else none.
 *                          With the default and both keys, a failed Gemini call is retried with
 *                          OpenAI (e.g. once Gemini's free daily quota is used up); an explicit
 *                          --provider uses that provider only.
 *   --max-new <n>          new clusters per batch (default 60)
 *   --max-per-country <n>  new clusters per country per batch (default 8)
 *   --max-stories-per-country <n>  live (active) stories per country (default 10, env
 *                          MAX_STORIES_PER_COUNTRY; 0 = no cap). Only limits which new
 *                          stories are admitted; existing stories are never removed by it.
 *   --max-stored-stories <n>  stories kept on the site in total (default 2500, env
 *                          MAX_STORED_STORIES; 0 = no limit). Beyond it the stories with the
 *                          oldest coverage are removed and 301-redirect to their country page.
 *   --max-ai <n>           LLM calls per batch (default 80)
 *   --resummarize-fallback re-summarise kept stories that still have non-AI fallback text
 *                          (e.g. from runs without an API key); counts toward --max-ai
 *   --auto-resummarize <n> otherwise, retry up to n such stories per batch with AI calls left
 *                          over after new/updated stories (default 10, 0 = off)
 *   --ai-concurrency <n>   parallel LLM calls (default 2, env AI_CONCURRENCY); keep low on free
 *                          tiers, which rate-limit per minute
 *   --no-trends            skip Google Trends      --no-gdelt   skip GDELT
 *   --dry-run              don't write files
 *   --snapshot <file>      also save the batch's input articles + trend signals as JSON
 *                          (CI uploads it as an artifact so clustering can be replayed)
 *
 * Env: GEMINI_API_KEY, GEMINI_MODEL (default gemini-3.1-flash-lite), OPENAI_API_KEY, OPENAI_MODEL (default gpt-5-mini)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { categoryBySlug } from '../src/lib/taxonomy.ts';
import { VAS } from '../src/lib/scoring.ts';
import { buildDigestDays } from '../src/lib/digest.ts';
import type { ViralClusterStaticRecord } from '../src/lib/types.ts';
import { COUNTRIES, COUNTRY_BY_CODE } from './lib/countries.ts';
import { mapLimit } from './lib/http.ts';
import { RSS_SOURCES } from './lib/fetchers/rssSources.ts';
import { fetchAllRss, type RawArticle } from './lib/fetchers/fetchRss.ts';
import { fetchGoogleTrends, type TrendSignal } from './lib/fetchers/fetchGoogleTrends.ts';
import { fetchGdelt } from './lib/fetchers/fetchGdelt.ts';
import { detectCountry } from './lib/intelligence/detectCountry.ts';
import {
  clusterArticles,
  newArticleCount,
  type CountryArticle,
  type WorkingCluster,
} from './lib/intelligence/deduplicateAndCluster.ts';
import {
  computeViralScore,
  searchQueryFor,
  usesSearchTerms,
  type ViralScore,
} from './lib/intelligence/computeViralScore.ts';
import {
  createSummarizer,
  isFallbackSummary,
  keepsStoredAiText,
  resolveFailover,
  resolveProvider,
  type SummaryInput,
  type AiFailure,
  type AiFailureCategory,
  type SummaryOutput,
} from './lib/intelligence/generateAiSummaries.ts';
import { buildInternalLinks } from './lib/intelligence/buildInternalLinks.ts';
import {
  retireOldest,
  selectTopPerCountry,
  summaryQueue,
} from './lib/intelligence/selectStories.ts';
import { mergeDuplicateStories } from './lib/intelligence/mergeDuplicates.ts';
import { keepStoryNames, type TitleNameCheck } from './lib/intelligence/storyNames.ts';
import {
  generateDigestSummaries,
  loadDigestSummaries,
} from './lib/intelligence/generateDigestSummaries.ts';
import { slugify, truncate } from './lib/intelligence/text.ts';
import {
  RETENTION_DAYS,
  ROOT,
  isActive,
  iso,
  loadBatchMeta,
  loadExistingClusters,
  loadRetiredStories,
  mergeRetired,
  retiredDigestDays,
  nextScheduledBatch,
  writeStaticJson,
} from './lib/builders/writeStaticJson.ts';

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const intOption = (name: string, fallback: number) => {
  const raw = option(name);
  const n = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
};

const provider = resolveProvider(option('provider'));
const OPTS = {
  provider,
  failover: resolveFailover(option('provider'), provider),
  dryRun: flag('dry-run'),
  snapshot: option('snapshot'),
  maxNew: intOption('max-new', 60),
  maxPerCountry: intOption('max-per-country', 8),
  maxStoriesPerCountry: intOption(
    'max-stories-per-country',
    process.env.MAX_STORIES_PER_COUNTRY?.trim()
      ? Number.parseInt(process.env.MAX_STORIES_PER_COUNTRY, 10)
      : VAS.maxStoriesPerCountry,
  ),
  maxStoredStories: intOption(
    'max-stored-stories',
    process.env.MAX_STORED_STORIES?.trim()
      ? Number.parseInt(process.env.MAX_STORED_STORIES, 10)
      : VAS.maxStoredStories,
  ),
  maxAi: intOption('max-ai', 80),
  resummarizeFallback: flag('resummarize-fallback'),
  autoResummarize: intOption('auto-resummarize', 10),
  /** AI-written daily digest intros per batch (new days and recent days whose top stories changed). */
  maxDigestAi: intOption('max-digest-ai', 4),
  aiConcurrency: Math.max(
    1,
    intOption(
      'ai-concurrency',
      process.env.AI_CONCURRENCY?.trim() ? Number.parseInt(process.env.AI_CONCURRENCY, 10) : 2,
    ),
  ),
  trends: !flag('no-trends'),
  gdelt: !flag('no-gdelt'),
};

/** GDELT is slow (rate-limited, sequential); query only the highest-priority markets. */
const GDELT_COUNTRIES = ['ID', 'US', 'GB', 'IN', 'AU', 'MY', 'SG', 'JP'];
const MAX_SOURCES_PER_CLUSTER = 30;
const HOUR = 3_600_000;

const log = (msg: string) => console.log(msg);

// ── Helpers ─────────────────────────────────────────────────────────────────

function assignCountries(articles: RawArticle[]): CountryArticle[] {
  const out: CountryArticle[] = [];
  for (const a of articles) {
    const code = detectCountry(a.title, a.snippet, a.homeCountry);
    if (!code || !COUNTRY_BY_CODE.has(code)) continue;
    out.push({
      countryCode: code,
      url: a.url,
      title: a.title,
      snippet: a.snippet,
      publishedAt: a.publishedAt,
      publisherName: a.publisherName,
      publisherDomain: a.publisherDomain,
    });
  }
  return out;
}

function uniqueSlug(base: string, taken: Set<string>): string {
  const root = slugify(base) || 'viral-story';
  let slug = root;
  for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`;
  taken.add(slug);
  return slug;
}

function summaryInput(cluster: WorkingCluster, score: ViralScore): SummaryInput {
  const country = COUNTRY_BY_CODE.get(cluster.countryCode)!;
  // Newest first so the model sees the latest developments; one article per publisher first.
  const ordered = [...cluster.articles].sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
  const seen = new Set<string>();
  const primary = ordered.filter((a) =>
    seen.has(a.publisherDomain) ? false : (seen.add(a.publisherDomain), true),
  );
  const rest = ordered.filter((a) => !primary.includes(a));
  return {
    countryCode: country.code,
    countryName: country.name,
    articles: [...primary, ...rest].map((a) => ({
      publisherName: a.publisherName,
      title: a.title,
      snippet: a.snippet,
      publishedAt: a.publishedAt,
    })),
    metrics: {
      viralScore: score.viralScore,
      publishers: score.publishers,
      velocity: score.velocity,
      search: score.search,
      trendKeyword: score.matchedTrend?.keyword ?? null,
      searchQuery: searchQueryFor(cluster, score.matchedTrend),
    },
    // A repaired story's stored headline describes the event it drifted onto.
    previousHeadline: cluster.pruned > 0 ? undefined : cluster.existing?.headline,
    storySlug: cluster.existing?.slug,
  };
}

function sourcesOf(cluster: WorkingCluster): ViralClusterStaticRecord['sources'] {
  return [...cluster.articles]
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))
    .slice(-MAX_SOURCES_PER_CLUSTER)
    .map((a) => ({
      publisherName: a.publisherName,
      publisherDomain: a.publisherDomain,
      articleTitle: a.title,
      articleUrl: a.url,
      publishedAt: a.publishedAt.replace(/\.\d{3}Z$/, 'Z'),
    }));
}

function applyText(record: ViralClusterStaticRecord, text: SummaryOutput) {
  const category = categoryBySlug(text.categorySlug)!;
  record.headline = truncate(text.headline, 110);
  record.seoTitle = truncate(text.seoTitle, 60);
  record.metaDescription = truncate(text.metaDescription, 158);
  record.aiSummaryBullets = text.aiSummaryBullets.slice(0, 3).map((b) => truncate(b, 260));
  record.aiContextParagraph = text.aiContextParagraph.trim();
  record.whyItIsViral = text.whyItIsViral.trim();
  record.categorySlug = category.slug;
  record.categoryName = category.name;
  const tags = new Map<string, { name: string; slug: string }>();
  for (const name of text.entityTags) {
    const slug = slugify(name, 6);
    if (slug && !tags.has(slug)) tags.set(slug, { name: name.trim(), slug });
  }
  record.entityTags = [...tags.values()].slice(0, 4);
}

function applyScore(record: ViralClusterStaticRecord, score: ViralScore) {
  record.viralScore = score.viralScore;
  record.intensityTier = score.intensityTier;
  record.signalBreakdown = {
    verifiedPublisherCount: score.publishers,
    coverageVelocityScore: score.velocity,
    publicSearchSignalScore: score.search,
    confidenceLabel: score.publishers >= 3 ? 'Verified Multi-Source' : 'Emerging Coverage',
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const started = Date.now();
  const now = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const batchId = `batch-${iso(now).slice(0, 16).replace(/[-T:]/g, '')}`;
  const summarizer = createSummarizer(OPTS.provider, OPTS.failover);

  log(`▶ EarthViral batch ${batchId}${OPTS.dryRun ? ' (dry run)' : ''}`);
  log(
    `  provider: ${summarizer.provider}${summarizer.model ? ` (${summarizer.model})` : ''}${
      summarizer.failover
        ? `, failover: ${summarizer.failover.provider} (${summarizer.failover.model})`
        : ''
    }`,
  );
  if (summarizer.provider === 'none') {
    log(
      '  ! No GEMINI_API_KEY / OPENAI_API_KEY — summaries will be deterministic, not AI-written.',
    );
  }

  // 1. Previous state ────────────────────────────────────────────────────────
  const previousMeta = await loadBatchMeta();
  let existing = await loadExistingClusters();
  if (previousMeta?.isSeed) {
    log(`  previous data is the SAMPLE seed — discarding ${existing.length} sample clusters`);
    existing = [];
  }
  // As published before this batch, so digest days that drop out can be redirected.
  const previousClusters = existing;
  const retentionCutoff = now.getTime() - RETENTION_DAYS * 24 * HOUR;
  const expired = existing.filter((c) => Date.parse(c.lastUpdatedBatchAt) < retentionCutoff);
  existing = existing.filter((c) => !expired.includes(c));
  log(
    `  existing clusters: ${existing.length} kept, ${expired.length} expired (> ${RETENTION_DAYS} days)`,
  );

  // 2. Signals ───────────────────────────────────────────────────────────────
  log('▶ Fetching signals…');
  const trendGeos = COUNTRIES.filter((c) => c.trendsGeo).map((c) => ({
    code: c.code,
    geo: c.trendsGeo!,
  }));
  const gdeltTargets = GDELT_COUNTRIES.map((code) => ({
    code,
    gdeltName: COUNTRY_BY_CODE.get(code)!
      .name.toLowerCase()
      .replace(/[^a-z]/g, ''),
  }));
  const [rss, trends, gdelt] = await Promise.all([
    fetchAllRss(RSS_SOURCES, now),
    OPTS.trends
      ? fetchGoogleTrends(trendGeos)
      : Promise.resolve({ signals: [] as TrendSignal[], failed: [] as string[] }),
    OPTS.gdelt
      ? fetchGdelt(gdeltTargets)
      : Promise.resolve({ articles: [] as RawArticle[], failed: [] as string[] }),
  ]);
  const feedsFailed = [...rss.failed, ...trends.failed, ...gdelt.failed];
  log(`  RSS: ${rss.articles.length} articles from ${rss.ok.length}/${RSS_SOURCES.length} feeds`);
  log(`  Google Trends: ${trends.signals.length} trending searches`);
  log(`  GDELT: ${gdelt.articles.length} articles${OPTS.gdelt ? '' : ' (skipped)'}`);
  for (const f of feedsFailed) log(`  ! ${f}`);

  const articles = assignCountries([...rss.articles, ...gdelt.articles]);
  log(`  ${articles.length} articles attributed to a tracked country`);
  if (OPTS.snapshot) {
    // Raw inputs aren't otherwise kept (stories store only their own sources), so without
    // this a batch's clustering can't be reproduced.
    await mkdir(dirname(OPTS.snapshot), { recursive: true });
    await writeFile(
      OPTS.snapshot,
      JSON.stringify({
        batchId,
        generatedAt: iso(now),
        feedsFailed,
        trends: trends.signals,
        articles,
      }),
    );
    log(`  Snapshot: ${articles.length} articles → ${OPTS.snapshot}`);
  }

  // 3. Cluster + score ───────────────────────────────────────────────────────
  log('▶ Clustering & scoring…');
  const working = clusterArticles(articles, existing);
  const scored = working.map((cluster) => ({
    cluster,
    score: computeViralScore(cluster, trends.signals, now),
  }));

  const fresh = scored
    .filter(
      ({ cluster, score }) =>
        !cluster.existing && (score.publishers >= VAS.minPublishers || score.matchedTrend),
    )
    .sort((a, b) => b.score.viralScore - a.score.viralScore);
  const perCountry = new Map<string, number>();
  const candidatesNew = fresh
    .filter(({ cluster }) => {
      const n = perCountry.get(cluster.countryCode) ?? 0;
      if (n >= OPTS.maxPerCountry) return false;
      perCountry.set(cluster.countryCode, n + 1);
      return true;
    })
    .slice(0, OPTS.maxNew);

  // Admission: new candidates compete with each country's *active* stories on current score;
  // only the top N per country are admitted — decided before summarising so no AI call is
  // wasted. Existing stories are never dropped here: published URLs stay up as archive pages.
  const existingScored = scored.filter(({ cluster }) => cluster.existing);
  const { kept } = selectTopPerCountry(
    [
      ...existingScored
        .filter(({ cluster }) => isActive(cluster.existing!, now))
        .map((x) => ({ ...x, isExisting: true })),
      ...candidatesNew.map((x) => ({ ...x, isExisting: false })),
    ].map((x) => ({ ...x, countryCode: x.cluster.countryCode, viralScore: x.score.viralScore })),
    OPTS.maxStoriesPerCountry,
  );
  const selectedNew = kept.filter((x) => !x.isExisting);
  // Site size budget: new stories take their slots first; the stories with the oldest
  // coverage are retired (→ 301 to their country page) when over the limit.
  const budgetForExisting =
    OPTS.maxStoredStories > 0 ? OPTS.maxStoredStories - selectedNew.length : Infinity;
  const { kept: carried, dropped: overBudget } = retireOldest(
    existingScored.map((x) => {
      // New coverage this batch makes a story current again.
      const lastUpdatedAt =
        newArticleCount(x.cluster) > 0 ? iso(now) : x.cluster.existing!.lastUpdatedBatchAt;
      return { ...x, lastUpdatedAt };
    }),
    budgetForExisting,
  );
  const retiredNow = overBudget.map((x) => x.cluster.existing!);
  const updated = carried.filter(({ cluster }) => newArticleCount(cluster) > 0);
  log(
    `  ${working.length - existing.length} candidate new clusters → ${selectedNew.length} selected; ${updated.length} existing clusters received new coverage`,
  );
  log(
    `  live cap ${OPTS.maxStoriesPerCountry || 'off'} per country; site budget ${OPTS.maxStoredStories || 'off'} stories: ${retiredNow.length} oldest retired (→ 301 to country page)`,
  );

  // Stories whose stored sources had drifted onto other events were pruned while clustering;
  // their text describes the wrong event, so it is always rewritten.
  const repaired = carried.filter(({ cluster }) => cluster.pruned > 0);
  if (repaired.length > 0) {
    log(
      `  repaired ${repaired.length} drifted stories (${repaired.reduce((n, { cluster }) => n + cluster.pruned, 0)} unrelated sources pruned)`,
    );
  }

  // 4. Summarise (within the AI budget, highest scores first) ─────────────────
  // New and repaired clusters always need text; existing ones are re-summarised after ≥ 2 new
  // articles, or — with --resummarize-fallback and an AI provider — when they still have
  // non-AI text.
  // Kept stories still showing non-AI fallback text (an AI call failed or was over budget).
  // --resummarize-fallback queues all of them; otherwise a few are retried every batch with
  // leftover AI calls (see summaryQueue).
  const fallbackKept = carried.filter(
    ({ cluster }) =>
      summarizer.provider !== 'none' &&
      newArticleCount(cluster) < 2 &&
      cluster.pruned === 0 &&
      isFallbackSummary(cluster.existing!),
  );
  const { queue: needsText, retried } = summaryQueue(
    [
      ...selectedNew.map((x) => ({ ...x, isNew: true })),
      ...repaired.map((x) => ({ ...x, isNew: true })),
      ...updated
        .filter(({ cluster }) => newArticleCount(cluster) >= 2 && cluster.pruned === 0)
        .map((x) => ({ ...x, isNew: false })),
    ],
    fallbackKept.map((x) => ({ ...x, isNew: false })),
    { all: OPTS.resummarizeFallback, auto: OPTS.autoResummarize },
  );
  if (OPTS.resummarizeFallback) {
    log(`  --resummarize-fallback: ${retried.length} kept stories with non-AI text queued`);
  } else if (fallbackKept.length) {
    log(
      `  auto re-summarise: ${retried.length} of ${fallbackKept.length} stories with non-AI text queued (uses leftover budget)`,
    );
  }

  {
    const matched = needsText.filter((x) => x.score.matchedTrend);
    const usable = matched
      .map((x) => searchQueryFor(x.cluster, x.score.matchedTrend))
      .filter((q) => q !== null);
    log(
      `  ${matched.length} of ${needsText.length} stories match a Google Trends search; ${usable.length} usable as a title target${
        usable.length
          ? `: ${usable
              .slice(0, 6)
              .map((q) => `"${q}"`)
              .join(', ')}`
          : ''
      }`,
    );
  }
  log(
    `▶ Summarising ${needsText.length} clusters (budget ${OPTS.maxAi} AI calls, ${OPTS.aiConcurrency} at a time)…`,
  );
  let aiCalls = 0;
  const aiFailures = new Map<AiFailureCategory, number>();
  const aiFailureSamples: AiFailure[] = [];
  const texts = new Map<WorkingCluster, SummaryOutput>();
  let keptAiText = 0; // stories whose AI call failed but kept their stored AI text
  // Calls the primary provider failed and the failover provider retried, by the primary's
  // failure category, and how many of those the failover provider wrote.
  const failover = { tried: 0, written: 0, reasons: new Map<string, number>() };
  const countFailover = (f: { from: AiFailure; ok: boolean }) => {
    failover.tried++;
    if (f.ok) failover.written++;
    failover.reasons.set(f.from.category, (failover.reasons.get(f.from.category) ?? 0) + 1);
  };
  const titleNames: Record<TitleNameCheck, number> = {
    kept: 0,
    headline: 0,
    previous: 0,
    missing: 0,
    'no-anchor': 0,
  };
  await mapLimit(needsText, OPTS.aiConcurrency, async (item, i) => {
    const withinBudget = summarizer.provider !== 'none' && i < OPTS.maxAi;
    if (!withinBudget && !item.isNew) return; // keep the existing text
    const input = summaryInput(item.cluster, item.score);
    if (!withinBudget) {
      texts.set(item.cluster, (await createSummarizer('none').summarize(input)).output);
      return;
    }
    aiCalls++;
    const result = await summarizer.summarize(input);
    const existing = item.cluster.existing;
    // On a failed call an updated story keeps its AI text; sources and scores still update,
    // and the text is retried when more coverage arrives.
    const keepText = keepsStoredAiText({ isNew: item.isNew, existing }, result.output);
    if (result.failover) {
      countFailover(result.failover);
      if (result.failover.ok)
        log(
          `  ↪ ${summarizer.provider} failed (${item.cluster.countryCode}) [${result.failover.from.category}] — written by ${summarizer.failover!.provider}`,
        );
    }
    if (result.error) {
      const { category, detail } = result.error;
      aiFailures.set(category, (aiFailures.get(category) ?? 0) + 1);
      if (aiFailureSamples.length < 5) aiFailureSamples.push(result.error);
      log(
        `  ! AI summary failed (${item.cluster.countryCode}) [${category}]: ${detail} — ${keepText ? 'keeping the stored AI text' : 'using fallback'}`,
      );
    }
    if (keepText) {
      keptAiText++;
      return;
    }
    if (existing && !result.error && !isFallbackSummary(result.output)) {
      // An update must not drop the names the story's URL was published under.
      const kept = keepStoryNames(result.output, {
        slug: existing.slug,
        seoTitle: existing.seoTitle,
        entityTags: existing.entityTags.map((t) => t.name),
      });
      titleNames[kept.check]++;
      if (kept.check !== 'kept' && kept.check !== 'no-anchor')
        log(
          `  title names (${existing.slug}) [${kept.check}]: "${result.output.seoTitle}" → "${kept.output.seoTitle}" (anchors: ${kept.anchors.join(', ')})`,
        );
      texts.set(item.cluster, kept.output);
      return;
    }
    texts.set(item.cluster, result.output);
  });
  if (keptAiText)
    log(`  ${keptAiText} updated stories kept their stored AI text after a failed AI call`);
  // Trending searches targeted in titles, and how many AI titles actually used them.
  const targeted = needsText
    .map((item) => ({ item, query: searchQueryFor(item.cluster, item.score.matchedTrend) }))
    .filter((x): x is typeof x & { query: string } => x.query !== null)
    .map(({ item, query }) => ({ item, query, out: texts.get(item.cluster) }))
    .filter(({ out }) => out && !isFallbackSummary(out));
  const trendTitles = {
    targeted: targeted.length,
    inTitle: targeted.filter(({ item, query, out }) =>
      usesSearchTerms(out!.seoTitle, query, item.cluster.countryCode),
    ).length,
  };
  if (trendTitles.targeted) {
    log(`  trending searches in titles: ${trendTitles.inTitle}/${trendTitles.targeted}`);
    for (const { query, out } of targeted.slice(0, 5)) log(`    "${query}" → ${out!.seoTitle}`);
  }

  // 5. Build records ─────────────────────────────────────────────────────────
  // Retired slugs stay reserved: a redirect for an old URL must never shadow a new story.
  const previousRetired = previousMeta?.isSeed ? [] : await loadRetiredStories();
  const takenSlugs = new Set([
    ...existing.map((c) => c.slug),
    ...previousRetired
      .filter((r) => r.path.startsWith('/news/'))
      .map((r) => r.path.split('/').filter(Boolean).at(-1)!),
  ]);
  let records: ViralClusterStaticRecord[] = [];
  const newRecords = new Set<ViralClusterStaticRecord>();

  for (const { cluster, score } of carried) {
    const record: ViralClusterStaticRecord = structuredClone(cluster.existing!);
    applyScore(record, score);
    if (cluster.pruned > 0) record.sources = sourcesOf(cluster);
    if (newArticleCount(cluster) > 0) {
      record.sources = sourcesOf(cluster);
      record.lastUpdatedBatchAt = iso(now);
    }
    const text = texts.get(cluster);
    if (text) applyText(record, text); // slug + URL are never changed for existing stories
    records.push(record);
  }

  for (const { cluster, score } of selectedNew) {
    const country = COUNTRY_BY_CODE.get(cluster.countryCode)!;
    const text = texts.get(cluster)!;
    const slug = uniqueSlug(text.slug || text.headline, takenSlugs);
    const firstDetectedAt = cluster.articles.map((a) => a.publishedAt).sort()[0]!;
    const cc = country.code.toLowerCase();
    const record = {
      id: `${cc}-${firstDetectedAt.slice(0, 10).replaceAll('-', '')}-${slug}`,
      slug,
      canonicalPath: `/news/${cc}/${slug}/`,
      countryCode: country.code,
      countryName: country.name,
      countrySlug: country.slug,
      region: country.region,
      firstDetectedAt: firstDetectedAt.replace(/\.\d{3}Z$/, 'Z'),
      lastUpdatedBatchAt: iso(now),
      sources: sourcesOf(cluster),
      relatedInCountrySlugs: [],
      relatedInCategorySlugs: [],
    } as unknown as ViralClusterStaticRecord;
    applyText(record, text);
    applyScore(record, score);
    records.push(record);
    newRecords.add(record);
  }

  // Same event, two stories: the AI-written headlines of separately clustered reports come
  // out near-identical, so duplicates are merged here (see mergeDuplicates.ts). Published
  // duplicates redirect to the story that absorbed them.
  const merged = mergeDuplicateStories(records, (r) => newRecords.has(r));
  records = merged.records;
  const mergedAway = merged.merges.filter((m) => m.retired);
  if (merged.merges.length > 0) {
    log(
      `  merged ${merged.merges.length} duplicate stories (${merged.merges.length - mergedAway.length} new, ${mergedAway.length} published → 301 to the surviving story)`,
    );
    for (const m of merged.merges) log(`    ${m.from.canonicalPath} → ${m.into.canonicalPath}`);
  }

  // 6. Link graph + write ────────────────────────────────────────────────────
  buildInternalLinks(records, now);
  const retiredDigests = retiredDigestDays(previousClusters, records, iso(now));
  if (retiredDigests.length)
    log(
      `  ${retiredDigests.length} daily digest day(s) dropped out → 301 to /digest/: ${retiredDigests.map((r) => r.path).join(', ')}`,
    );
  const retired = mergeRetired(
    previousRetired,
    // Stories over the site size budget and past the retention window both redirect.
    [
      ...[...retiredNow, ...expired].map((c) => ({
        path: c.canonicalPath,
        redirectTo: `/country/${c.countrySlug}/`,
        retiredAt: iso(now),
      })),
      ...mergedAway.map((m) => ({
        path: m.from.canonicalPath,
        redirectTo: m.into.canonicalPath,
        retiredAt: iso(now),
      })),
      ...retiredDigests,
    ],
    new Set([
      ...records.map((r) => r.canonicalPath),
      ...buildDigestDays(records).map((d) => d.path),
    ]),
    now,
  );
  // Daily digest intros, from the final story set (after merges and retention).
  log(`▶ Daily digest summaries (up to ${OPTS.maxDigestAi} AI calls)…`);
  const digest = await generateDigestSummaries({
    clusters: records,
    previous: previousMeta?.isSeed ? [] : await loadDigestSummaries(ROOT),
    provider: summarizer.provider,
    failover: OPTS.failover,
    now,
    maxCalls: OPTS.maxDigestAi,
    concurrency: OPTS.aiConcurrency,
    log,
  });
  aiCalls += digest.stats.written + digest.stats.failed;
  digest.failovers.forEach(countFailover);
  for (const f of digest.failures) {
    aiFailures.set(f.category, (aiFailures.get(f.category) ?? 0) + 1);
    if (aiFailureSamples.length < 5) aiFailureSamples.push(f);
  }
  log(
    `  digest summaries: ${digest.stats.written} written, ${digest.stats.kept} kept, ${digest.stats.pending} waiting`,
  );
  const aiFailureCount = [...aiFailures.values()].reduce((a, b) => a + b, 0);
  const aiFailureSummary = [...aiFailures.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, n]) => `${category} ${n}`)
    .join(', ');

  const result = await writeStaticJson(
    {
      clusters: records,
      retired,
      batchId,
      generatedAt: now,
      nextUpdateAt: nextScheduledBatch(now),
      isSeed: false,
      digestSummaries: digest.summaries,
      pipeline: {
        provider: summarizer.model
          ? `${summarizer.provider}:${summarizer.model}`
          : summarizer.provider,
        feedsOk: rss.ok.length,
        feedsFailed,
        articlesFetched: rss.articles.length + gdelt.articles.length,
        newClusters: selectedNew.length - (merged.merges.length - mergedAway.length),
        updatedClusters: updated.length,
        retiredClusters: retiredNow.length,
        ...(merged.merges.length ? { mergedDuplicates: merged.merges.length } : {}),
        aiCalls,
        fallbackSummaries: records.filter(isFallbackSummary).length,
        ...(trendTitles.targeted ? { trendTitles } : {}),
        titleNames,
        digestSummaries: digest.stats,
        ...(aiFailureCount ? { aiFailures: Object.fromEntries(aiFailures), aiFailureSamples } : {}),
        ...(failover.tried && summarizer.failover
          ? {
              failover: {
                provider: `${summarizer.failover.provider}:${summarizer.failover.model}`,
                tried: failover.tried,
                written: failover.written,
                reasons: Object.fromEntries(failover.reasons),
              },
            }
          : {}),
        durationMs: Date.now() - started,
      },
    },
    { dryRun: OPTS.dryRun },
  );

  // 7. Report ────────────────────────────────────────────────────────────────
  const { totals } = result.batchMeta;
  log(
    `▶ ${OPTS.dryRun ? 'Would write' : 'Wrote'} ${result.clusterCount} clusters across ${result.countries.length} countries`,
  );
  log(
    `  active countries ${totals.activeCountries} · viral topics ${totals.viralTopics} · global index ${totals.globalIndex}`,
  );
  log(
    `  AI calls ${aiCalls}${aiFailureCount ? ` (${aiFailureCount} fell back: ${aiFailureSummary})` : ''}${
      failover.tried
        ? ` · failover ${summarizer.failover!.provider}: ${failover.written} of ${failover.tried} written`
        : ''
    } · ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  log('  Top stories:');
  for (const r of [...records].sort((a, b) => b.viralScore - a.viralScore).slice(0, 10)) {
    log(
      `   ${String(r.viralScore).padStart(3)}  ${r.countryCode}  ${r.categorySlug.padEnd(24)} ${r.headline}`,
    );
  }
}

main().catch((err) => {
  console.error('✖ Batch failed:', err);
  process.exit(1);
});
