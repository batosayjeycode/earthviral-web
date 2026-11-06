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
 *   --max-ai <n>           LLM calls per batch (default 80)
 *   --no-trends            skip Google Trends      --no-gdelt   skip GDELT
 *   --dry-run              don't write files
 *
 * Env: GEMINI_API_KEY, GEMINI_MODEL (default gemini-2.5-flash), OPENAI_API_KEY, OPENAI_MODEL (default gpt-5-mini)
 */
import { categoryBySlug } from '../src/lib/taxonomy.ts';
import { VAS } from '../src/lib/scoring.ts';
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
import { computeViralScore, type ViralScore } from './lib/intelligence/computeViralScore.ts';
import {
  createSummarizer,
  resolveProvider,
  type SummaryInput,
  type SummaryOutput,
} from './lib/intelligence/generateAiSummaries.ts';
import { buildInternalLinks } from './lib/intelligence/buildInternalLinks.ts';
import { slugify, truncate } from './lib/intelligence/text.ts';
import {
  RETENTION_DAYS,
  iso,
  loadBatchMeta,
  loadExistingClusters,
  nextWibBoundary,
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

const OPTS = {
  provider: resolveProvider(option('provider')),
  dryRun: flag('dry-run'),
  maxNew: intOption('max-new', 60),
  maxPerCountry: intOption('max-per-country', 8),
  maxAi: intOption('max-ai', 80),
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
    },
    previousHeadline: cluster.existing?.headline,
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
  const summarizer = createSummarizer(OPTS.provider);

  log(`▶ EarthViral batch ${batchId}${OPTS.dryRun ? ' (dry run)' : ''}`);
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
  const selectedNew = fresh
    .filter(({ cluster }) => {
      const n = perCountry.get(cluster.countryCode) ?? 0;
      if (n >= OPTS.maxPerCountry) return false;
      perCountry.set(cluster.countryCode, n + 1);
      return true;
    })
    .slice(0, OPTS.maxNew);
  const carried = scored.filter(({ cluster }) => cluster.existing);
  const updated = carried.filter(({ cluster }) => newArticleCount(cluster) > 0);
  log(
    `  ${working.length - existing.length} candidate new clusters → ${selectedNew.length} selected; ${updated.length} existing clusters received new coverage`,
  );

  // 4. Summarise (within the AI budget, highest scores first) ─────────────────
  // New clusters always need text; existing ones are re-summarised only after ≥ 2 new articles.
  const needsText = [
    ...selectedNew.map((x) => ({ ...x, isNew: true })),
    ...updated
      .filter(({ cluster }) => newArticleCount(cluster) >= 2)
      .map((x) => ({ ...x, isNew: false })),
  ].sort((a, b) => b.score.viralScore - a.score.viralScore);

  log(`▶ Summarising ${needsText.length} clusters (budget ${OPTS.maxAi} AI calls)…`);
  let aiCalls = 0;
  let aiFailures = 0;
  const texts = new Map<WorkingCluster, SummaryOutput>();
  await mapLimit(needsText, 4, async (item, i) => {
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
      aiFailures++;
      log(`  ! AI summary failed (${item.cluster.countryCode}): ${result.error} — using fallback`);
    }
    texts.set(item.cluster, result.output);
  });

  // 5. Build records ─────────────────────────────────────────────────────────
  const takenSlugs = new Set(existing.map((c) => c.slug));
  const records: ViralClusterStaticRecord[] = [];

  for (const { cluster, score } of carried) {
    const record: ViralClusterStaticRecord = structuredClone(cluster.existing!);
    applyScore(record, score);
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
  const result = await writeStaticJson(
    {
      clusters: records,
      batchId,
      generatedAt: now,
      nextUpdateAt: nextWibBoundary(now),
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
        aiCalls,
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
    `  AI calls ${aiCalls}${aiFailures ? ` (${aiFailures} fell back)` : ''} · ${((Date.now() - started) / 1000).toFixed(1)}s`,
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
