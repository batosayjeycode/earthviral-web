/**
 * Re-title published stories in place: new headline, seoTitle and metaDescription from the
 * AI, with the same name check as batch updates (storyNames.ts). Summaries, slug, URL,
 * category and tags are left as they are: the stored record has only source headlines (no
 * snippets), which is enough to word a title but too thin to rewrite a summary safely.
 *
 * Meant for the Search Console loop: stories that get impressions but few clicks.
 *
 *   node scripts/retitle-stories.ts /news/id/some-story/ /news/sg/other-story/ [--dry-run]
 *   node scripts/retitle-stories.ts --from paths.txt     (one path or full URL per line)
 *
 * Needs GEMINI_API_KEY (or OPENAI_API_KEY with --provider openai).
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ViralClusterStaticRecord } from '../src/lib/types.ts';
import { derivableArticles } from '../src/lib/publisherPolicy.ts';
import { COUNTRY_BY_CODE } from './lib/countries.ts';
import { createSummarizer, isFallbackSummary } from './lib/intelligence/generateAiSummaries.ts';
import { keepStoryNames } from './lib/intelligence/storyNames.ts';
import { truncate } from './lib/intelligence/text.ts';

const CLUSTERS = 'src/data/generated/clusters';
const argv = process.argv.slice(2);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv.splice(i, 2)[1];
};
const dryRun = argv.includes('--dry-run');
const provider = (option('provider') ?? 'gemini') as 'gemini' | 'openai';
const from = option('from');
const wanted = [
  ...argv.filter((a) => !a.startsWith('--')),
  ...(from ? (await readFile(from, 'utf8')).split('\n') : []),
]
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (s.startsWith('http') ? new URL(s).pathname : s));
if (!wanted.length) throw new Error('Give story paths, or --from <file>');

const files = new Map<string, string>(); // canonicalPath → file
for (const dir of await readdir(CLUSTERS))
  for (const f of await readdir(join(CLUSTERS, dir))) {
    const file = join(CLUSTERS, dir, f);
    const c = JSON.parse(await readFile(file, 'utf8')) as ViralClusterStaticRecord;
    files.set(c.canonicalPath, file);
  }

const summarizer = createSummarizer(provider);
let changed = 0;
for (const path of wanted) {
  const file = files.get(path);
  if (!file) {
    console.log(`- ${path}: not published (expired?), skipped`);
    continue;
  }
  const record = JSON.parse(await readFile(file, 'utf8')) as ViralClusterStaticRecord;
  // Publisher content policy: headline-only (and removed) publishers never go to the AI.
  const sources = derivableArticles(record.sources).sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
  if (sources.length === 0) {
    console.log(`- ${path}: no sources usable for AI under publisher policy, skipped`);
    continue;
  }
  const { output, error } = await summarizer.summarize({
    countryCode: record.countryCode,
    countryName: COUNTRY_BY_CODE.get(record.countryCode)?.name ?? record.countryName,
    articles: sources.map((s) => ({
      publisherName: s.publisherName,
      publisherDomain: s.publisherDomain,
      title: s.articleTitle,
      snippet: '',
      publishedAt: s.publishedAt,
    })),
    metrics: {
      viralScore: record.viralScore,
      publishers: record.signalBreakdown.verifiedPublisherCount,
      velocity: record.signalBreakdown.coverageVelocityScore,
      search: record.signalBreakdown.publicSearchSignalScore,
      trendKeyword: null,
    },
    previousHeadline: record.headline,
    storySlug: record.slug,
  });
  if (error || isFallbackSummary(output)) {
    console.log(`! ${path}: AI failed (${error?.category ?? 'fallback'}), unchanged`);
    continue;
  }
  const kept = keepStoryNames(output, {
    slug: record.slug,
    seoTitle: record.seoTitle,
    entityTags: record.entityTags.map((t) => t.name),
  });
  // An over-long seoTitle would be clipped with "…"; a headline that fits reads better.
  const seoTitle =
    kept.output.seoTitle.length > 60 && kept.output.headline.length <= 70
      ? kept.output.headline
      : kept.output.seoTitle;
  const next = {
    headline: truncate(kept.output.headline, 110),
    seoTitle: truncate(seoTitle, 70),
    metaDescription: truncate(kept.output.metaDescription, 158),
  };
  console.log(
    `${path} [${kept.check}]\n  title: ${record.seoTitle}\n      → ${next.seoTitle}\n  head:  ${record.headline}\n      → ${next.headline}`,
  );
  if (kept.check === 'missing') {
    console.log('  ! names still missing, unchanged');
    continue;
  }
  Object.assign(record, next);
  if (!dryRun) await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  changed++;
}
console.log(`\n${changed} of ${wanted.length} stories re-titled${dryRun ? ' (dry run)' : ''}.`);
