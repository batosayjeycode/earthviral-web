/**
 * EarthViral 3-hour AI batch generator (plan §7.2, Phase 3).
 *
 *   npm run update:viral                      # full run, writes static JSON
 *   npm run update:viral -- --dry-run         # fetch + cluster + score, print, write nothing
 *   npm run update:viral -- --provider none   # no AI calls (deterministic summaries)
 *
 * Flags:
 *   --provider gemini|openai|none   default: gemini if GEMINI_API_KEY, else openai if OPENAI_API_KEY, else none
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
 *   --ai-concurrency <n>   parallel LLM calls (default 2, env AI_CONCURRENCY); keep low on free
 *                          tiers, which rate-limit per minute
 *   --no-trends            skip Google Trends      --no-gdelt   skip GDELT
 *   --dry-run              don't write files
 *   --snapshot <file>      also save the batch's input articles + trend signals as JSON
 *                          (CI uploads it as an artifact so clustering can be replayed)
 *
 * Env: GEMINI_API_KEY, GEMINI_MODEL (default gemini-3.1-flash-lite), OPENAI_API_KEY, OPENAI_MODEL (default gpt-5-mini)
 *      SITE_ENV=staging  staging batch: fetches staging-only feeds too, and makes no AI calls
 *                        unless --provider is given explicitly (never inferred from keys)
 *
 * Publisher content policies (src/lib/publisherPolicy.ts) are enforced at ingestion,
 * summary input, story selection and publication — see the plan's Phase 4.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { categoryBySlug } from '../src/lib/taxonomy.ts';
import { VAS } from '../src/lib/scoring.ts';
import type { ViralClusterStaticRecord } from '../src/lib/types.ts';
import { resolveSiteEnvironment } from '../src/lib/environment.ts';
import { hasDerivableCoverage } from '../src/lib/publisherPolicy.ts';
import { COUNTRIES, COUNTRY_BY_CODE } from './lib/countries.ts';
import { mapLimit } from './lib/http.ts';
import { activeSources } from './lib/fetchers/rssSources.ts';
import { applyIngestionPolicy, cleanStoredStories } from './lib/policy/applyContentPolicy.ts';
import { summaryInput } from './lib/intelligence/summaryInput.ts';
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
import { computeViralScore, type ViralScore } from './lib/intelligence/computeViralScore.ts';
import {
  createSummarizer,
  isFallbackSummary,
  resolveProvider,
  type AiFailure,
  type AiFailureCategory,
  type SummaryOutput,
} from './lib/intelligence/generateAiSummaries.ts';
import { buildInternalLinks } from './lib/intelligence/buildInternalLinks.ts';
import { retireOldest, selectTopPerCountry } from './lib/intelligence/selectStories.ts';
import { slugify, truncate } from './lib/intelligence/text.ts';
import {
  RETENTION_DAYS,
  isActive,
  iso,
  loadBatchMeta,
  loadExistingClusters,
  loadRetiredStories,
  mergeRetired,
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

const ENVIRONMENT = resolveSiteEnvironment(process.env.SITE_ENV);
const RSS_SOURCES = activeSources(ENVIRONMENT);

const OPTS = {
  // Staging never infers an AI provider from whatever keys are present: AI is opt-in there.
  provider:
    ENVIRONMENT === 'staging' && !option('provider') ? 'none' : resolveProvider(option('provider')),
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
  const summarizer = createSummarizer(OPTS.provider);

  log(
    `▶ EarthViral batch ${batchId}${OPTS.dryRun ? ' (dry run)' : ''} [${ENVIRONMENT} environment]`,
  );
  log(`  provider: ${summarizer.provider}${summarizer.model ? ` (${summarizer.model})` : ''}`);
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
  const retentionCutoff = now.getTime() - RETENTION_DAYS * 24 * HOUR;
  const expired = existing.filter((c) => Date.parse(c.lastUpdatedBatchAt) < retentionCutoff);
  existing = existing.filter((c) => !expired.includes(c));
  // Publisher policies on stored data: removed publishers' sources are deleted, and stories
  // left without publishable coverage are withdrawn (→ 301 to their country page).
  const policy = cleanStoredStories(existing);
  existing = policy.kept;
  const withdrawn = policy.unpublishable;
  if (policy.removedSources > 0 || withdrawn.length > 0) {
    log(
      `  content policy: ${policy.removedSources} stored sources of removed publishers deleted; ${withdrawn.length} stories withdrawn`,
    );
  }
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

  // Publisher policies at ingestion (RSS and GDELT alike): removed publishers dropped,
  // descriptions blanked for headline-only publishers.
  const articles = assignCountries(applyIngestionPolicy([...rss.articles, ...gdelt.articles]));
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
        !cluster.existing &&
        (score.publishers >= VAS.minPublishers || score.matchedTrend) &&
        // Never publish a story covered only by headline-only publishers.
        hasDerivableCoverage(cluster.articles),
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
  const { kept: carriedAll, dropped: overBudget } = retireOldest(
    existingScored.map((x) => {
      // New coverage this batch makes a story current again.
      const lastUpdatedAt =
        newArticleCount(x.cluster) > 0 ? iso(now) : x.cluster.existing!.lastUpdatedBatchAt;
      return { ...x, lastUpdatedAt };
    }),
    budgetForExisting,
  );
  // A stored story whose publishable sources were all pruned (drift repair) is withdrawn too.
  const carried = carriedAll.filter(({ cluster }) => hasDerivableCoverage(cluster.articles));
  const lostCoverage = carriedAll.filter((x) => !carried.includes(x));
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
  const resummarize = carried.filter(
    ({ cluster }) =>
      OPTS.resummarizeFallback &&
      summarizer.provider !== 'none' &&
      newArticleCount(cluster) < 2 &&
      cluster.pruned === 0 &&
      isFallbackSummary(cluster.existing!),
  );
  const needsText = [
    ...selectedNew.map((x) => ({ ...x, isNew: true })),
    ...repaired.map((x) => ({ ...x, isNew: true })),
    ...updated
      .filter(({ cluster }) => newArticleCount(cluster) >= 2 && cluster.pruned === 0)
      .map((x) => ({ ...x, isNew: false })),
    ...resummarize.map((x) => ({ ...x, isNew: false })),
  ].sort((a, b) => b.score.viralScore - a.score.viralScore);
  if (OPTS.resummarizeFallback) {
    log(`  --resummarize-fallback: ${resummarize.length} kept stories with non-AI text queued`);
  }

  log(
    `▶ Summarising ${needsText.length} clusters (budget ${OPTS.maxAi} AI calls, ${OPTS.aiConcurrency} at a time)…`,
  );
  let aiCalls = 0;
  const aiFailures = new Map<AiFailureCategory, number>();
  const aiFailureSamples: AiFailure[] = [];
  const texts = new Map<WorkingCluster, SummaryOutput>();
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
    if (result.error) {
      const { category, detail } = result.error;
      aiFailures.set(category, (aiFailures.get(category) ?? 0) + 1);
      if (aiFailureSamples.length < 5) aiFailureSamples.push(result.error);
      log(
        `  ! AI summary failed (${item.cluster.countryCode}) [${category}]: ${detail} — using fallback`,
      );
    }
    texts.set(item.cluster, result.output);
  });
  const aiFailureCount = [...aiFailures.values()].reduce((a, b) => a + b, 0);
  const aiFailureSummary = [...aiFailures.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, n]) => `${category} ${n}`)
    .join(', ');

  // 5. Build records ─────────────────────────────────────────────────────────
  // Retired slugs stay reserved: a redirect for an old URL must never shadow a new story.
  const previousRetired = previousMeta?.isSeed ? [] : await loadRetiredStories();
  const takenSlugs = new Set([
    ...existing.map((c) => c.slug),
    ...withdrawn.map((c) => c.slug),
    ...previousRetired.map((r) => r.path.split('/').filter(Boolean).at(-1)!),
  ]);
  const records: ViralClusterStaticRecord[] = [];

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
  }

  // 6. Link graph + write ────────────────────────────────────────────────────
  buildInternalLinks(records, now);
  const retired = mergeRetired(
    previousRetired,
    // Stories over the site size budget, past the retention window or withdrawn by a
    // publisher content policy all redirect.
    [...retiredNow, ...expired, ...withdrawn, ...lostCoverage.map((x) => x.cluster.existing!)].map(
      (c) => ({
        path: c.canonicalPath,
        redirectTo: `/country/${c.countrySlug}/`,
        retiredAt: iso(now),
      }),
    ),
    new Set(records.map((r) => r.canonicalPath)),
    now,
  );
  const result = await writeStaticJson(
    {
      clusters: records,
      retired,
      batchId,
      generatedAt: now,
      nextUpdateAt: nextScheduledBatch(now),
      isSeed: false,
      pipeline: {
        provider: summarizer.model
          ? `${summarizer.provider}:${summarizer.model}`
          : summarizer.provider,
        feedsOk: rss.ok.length,
        feedsFailed,
        articlesFetched: rss.articles.length + gdelt.articles.length,
        newClusters: selectedNew.length,
        updatedClusters: updated.length,
        retiredClusters: retiredNow.length,
        aiCalls,
        ...(aiFailureCount ? { aiFailures: Object.fromEntries(aiFailures), aiFailureSamples } : {}),
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
    `  AI calls ${aiCalls}${aiFailureCount ? ` (${aiFailureCount} fell back: ${aiFailureSummary})` : ''} · ${((Date.now() - started) / 1000).toFixed(1)}s`,
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
