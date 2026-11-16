/**
 * Fulfil a publisher removal request on the committed data, without waiting for a batch.
 *
 *   npm run remove:publisher -- joho-todai.com --dry-run   # report only
 *   npm run remove:publisher -- joho-todai.com             # rewrite src/data + public/data
 *
 * The domain must first be added to REMOVED_PUBLISHERS in src/lib/publisherPolicy.ts (and its
 * RSS source deleted), so builds and later batches keep enforcing the removal. This script
 * then deletes every stored source from that publisher, withdraws stories left without
 * publishable coverage (301 → their country page) and regenerates the public JSON payloads.
 * Commit the result through the normal PR → CI → deploy path. The full procedure (caches,
 * backups, logs, git history) is in EarthViral_Staging_Environment_PLAN.md §12.
 */
import { REMOVED_PUBLISHERS } from '../src/lib/publisherPolicy.ts';
import { buildInternalLinks } from './lib/intelligence/buildInternalLinks.ts';
import { cleanStoredStories } from './lib/policy/applyContentPolicy.ts';
import {
  loadBatchMeta,
  loadExistingClusters,
  loadRetiredStories,
  mergeRetired,
  writeStaticJson,
} from './lib/builders/writeStaticJson.ts';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const domain = argv.find((a) => !a.startsWith('--'))?.toLowerCase();

async function main() {
  if (!domain) throw new Error('Usage: npm run remove:publisher -- <domain> [--dry-run]');
  if (!REMOVED_PUBLISHERS.some((r) => r.publisherDomain.toLowerCase() === domain)) {
    throw new Error(
      `${domain} is not in REMOVED_PUBLISHERS (src/lib/publisherPolicy.ts). Add it there first so builds and batches keep it removed.`,
    );
  }
  const meta = await loadBatchMeta();
  if (!meta) throw new Error('No batch data found.');
  const at = new Date(meta.generatedAt);

  const { kept, unpublishable, removedSources } = cleanStoredStories(await loadExistingClusters());
  console.log(
    `${domain}: ${removedSources} stored sources removed; ${unpublishable.length} stories withdrawn; ${kept.length} stories kept`,
  );
  for (const c of unpublishable) console.log(`  withdrawn ${c.canonicalPath}`);
  if (dryRun) return console.log('  (dry run — nothing written)');

  buildInternalLinks(kept, at);
  const retired = mergeRetired(
    await loadRetiredStories(),
    unpublishable.map((c) => ({
      path: c.canonicalPath,
      redirectTo: `/country/${c.countrySlug}/`,
      retiredAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    })),
    new Set(kept.map((c) => c.canonicalPath)),
    new Date(),
  );
  await writeStaticJson({
    clusters: kept,
    retired,
    batchId: meta.batchId,
    generatedAt: at,
    nextUpdateAt: new Date(meta.nextUpdateAt),
    isSeed: meta.isSeed,
    ...(meta.pipeline ? { pipeline: meta.pipeline } : {}),
  });
  console.log('  written. Review the diff, then commit through a pull request.');
}

await main();
