/**
 * Re-check every RSS source against the sourcing policy (rssSources.ts header): fetch the
 * robots.txt of the feed host and of the publisher site, and list the AI companies blocked.
 *
 *   npm run audit:feeds
 *
 * Exits non-zero when a source's `aiOptOut` mark no longer matches its robots.txt (a new
 * source that opts out, or a marked one that no longer does), so the list can be updated.
 */
import { RSS_SOURCES } from './lib/fetchers/rssSources.ts';
import { USER_AGENT } from './lib/http.ts';
import { aiCompaniesBlocked, isAiOptOut } from './lib/robotsPolicy.ts';

async function robotsOf(host: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${host}/robots.txt`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return res.ok && !/<html/i.test(text.slice(0, 500)) ? text : '';
  } catch {
    return null; // unreachable: not evidence either way
  }
}

let mismatches = 0;
const rows = await Promise.all(
  RSS_SOURCES.map(async (source) => {
    const hosts = [...new Set([new URL(source.url).hostname, `www.${source.publisherDomain}`])];
    const texts = await Promise.all(hosts.map(robotsOf));
    const companies = [...new Set(texts.flatMap((t) => (t ? aiCompaniesBlocked(t) : [])))].sort();
    const optOut = isAiOptOut(companies);
    const unreachable = texts.every((t) => t === null);
    const mismatch = !unreachable && optOut !== Boolean(source.aiOptOut);
    if (mismatch) mismatches++;
    const status = unreachable
      ? 'robots.txt unreachable'
      : companies.length
        ? `blocks ${companies.join(', ')}`
        : 'allows AI';
    return `${mismatch ? '✗' : ' '} ${source.id.padEnd(18)} ${(source.homeCountry ?? 'world').padEnd(6)} ${source.aiOptOut ? 'aiOptOut ' : '         '}${status}${mismatch ? (optOut ? '  → mark aiOptOut' : '  → no longer opts out') : ''}`;
  }),
);
console.log(rows.join('\n'));
console.log(
  `\n${RSS_SOURCES.length} sources, ${RSS_SOURCES.filter((s) => s.aiOptOut).length} marked aiOptOut, ${mismatches} mismatch(es).`,
);
if (mismatches) process.exitCode = 1;
