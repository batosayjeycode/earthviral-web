/**
 * IndexNow ping (plan §9.4 item 5): after a batch is deployed, submit the story URLs that
 * were created or updated in that batch to IndexNow (Bing, Yandex, Naver, Seznam…).
 *
 *   INDEXNOW_KEY=… npm run indexnow                 # waits for the deploy, then pings
 *   INDEXNOW_KEY=… npm run indexnow -- --no-wait    # ping immediately
 *   npm run indexnow -- --dry-run                   # list URLs only
 *
 * The same INDEXNOW_KEY must be set for the site build so /{key}.txt is published
 * (src/pages/[indexNowKey].txt.ts) — IndexNow fetches it to verify ownership.
 *
 * Cloudflare Pages deploys asynchronously after the data commit, so by default the script
 * polls the live /data/map-pulse.json until it reports this batch's id (max 15 minutes).
 */
import { fetchWithRetry, sleep } from './lib/http.ts';
import { loadBatchMeta, loadExistingClusters } from './lib/builders/writeStaticJson.ts';

const SITE_URL = 'https://earthviral.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const MAX_URLS = 10_000; // IndexNow per-request limit

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const wait = !argv.includes('--no-wait');

async function waitForDeploy(batchId: string, timeoutMs = 15 * 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithRetry(
        `${SITE_URL}/data/map-pulse.json?b=${encodeURIComponent(batchId)}`,
        {
          headers: { 'cache-control': 'no-cache' },
          retries: 0,
        },
      );
      const live = (await res.json()) as { batchId?: string };
      if (live.batchId === batchId) return true;
      console.log(`  live site still on ${live.batchId ?? 'unknown'} — waiting…`);
    } catch (err) {
      console.log(`  live check failed (${err instanceof Error ? err.message : err}) — retrying…`);
    }
    await sleep(30_000);
  }
  return false;
}

async function main() {
  const meta = await loadBatchMeta();
  if (!meta) throw new Error('No batch-meta.json — run `npm run update:viral` first.');
  if (meta.isSeed) {
    console.log('Sample (seed) data — nothing to submit.');
    return;
  }

  const changed = (await loadExistingClusters())
    .filter((c) => c.lastUpdatedBatchAt === meta.generatedAt)
    .map((c) => `${SITE_URL}${c.canonicalPath}`);
  const urlList = [`${SITE_URL}/`, ...changed].slice(0, MAX_URLS);
  console.log(`IndexNow: ${urlList.length} URLs from batch ${meta.batchId}`);
  if (dryRun) {
    urlList.forEach((u) => console.log(`  ${u}`));
    return;
  }

  const key = process.env.INDEXNOW_KEY?.trim();
  if (!key) {
    console.log('INDEXNOW_KEY not set — skipping.');
    return;
  }
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(key))
    throw new Error('INDEXNOW_KEY must be 8–128 characters of a–z, A–Z, 0–9 or "-".');

  if (wait && !(await waitForDeploy(meta.batchId))) {
    console.log(
      'Deploy not live within 15 minutes — skipping ping (the next batch will include these URLs).',
    );
    return;
  }

  const res = await fetchWithRetry(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(SITE_URL).host,
      key,
      keyLocation: `${SITE_URL}/${key}.txt`,
      urlList,
    }),
    retries: 2,
  });
  // 200 OK and 202 Accepted (key validation pending) are both success.
  console.log(`IndexNow responded ${res.status}.`);
}

main().catch((err) => {
  console.error('✖ IndexNow failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
