/**
 * Staleness watchdog check (run hourly by .github/workflows/staleness-watchdog.yml).
 *
 *   node scripts/check-staleness.ts                 # prints the report, exit 0
 *
 * Env: SITE_URL (default https://earthviral.com), STALE_AFTER_HOURS (default from
 * src/lib/scoring.ts), GITHUB_OUTPUT (set by Actions: receives `stale`, `summary`, and the
 * report is written to staleness-report.md for the issue body).
 *
 * Uses only Node built-ins so the workflow doesn't need `npm ci`.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAS } from '../src/lib/scoring.ts';
import { evaluateStaleness, type SourceReading } from './lib/staleness.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const siteUrl = (process.env.SITE_URL?.trim() || 'https://earthviral.com').replace(/\/$/, '');
const staleAfterHours = Number(process.env.STALE_AFTER_HOURS?.trim() || VAS.staleAfterHours);

async function readLive(): Promise<SourceReading> {
  try {
    const res = await fetch(`${siteUrl}/data/map-pulse.json?watchdog=${Date.now()}`, {
      headers: { 'user-agent': 'EarthViralWatchdog/1.0', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${siteUrl}` };
    if (!(res.headers.get('content-type') ?? '').includes('json')) {
      return { ok: false, error: `${siteUrl} serves HTML, not the EarthViral site yet` };
    }
    const body = (await res.json()) as { generatedAt?: string };
    if (!body.generatedAt) return { ok: false, error: 'no generatedAt in map-pulse.json' };
    return { ok: true, generatedAt: body.generatedAt };
  } catch (err) {
    return {
      ok: false,
      error: `${siteUrl} unreachable (${err instanceof Error ? err.message : err})`,
    };
  }
}

async function readRepo(): Promise<SourceReading> {
  try {
    const meta = JSON.parse(
      await readFile(join(ROOT, 'src', 'data', 'generated', 'batch-meta.json'), 'utf8'),
    ) as { generatedAt: string; isSeed?: boolean };
    return { ok: true, generatedAt: meta.generatedAt, isSeed: meta.isSeed };
  } catch (err) {
    return {
      ok: false,
      error: `batch-meta.json unreadable (${err instanceof Error ? err.message : err})`,
    };
  }
}

const result = evaluateStaleness({
  live: await readLive(),
  repo: await readRepo(),
  now: new Date(),
  staleAfterHours,
});

console.log(`${result.stale ? 'STALE' : 'OK'}: ${result.summary}`);
if (result.report) console.log(`\n${result.report}`);

if (process.env.GITHUB_OUTPUT) {
  await writeFile(join(ROOT, 'staleness-report.md'), result.report);
  await appendFile(process.env.GITHUB_OUTPUT, `stale=${result.stale}\nsummary=${result.summary}\n`);
}
