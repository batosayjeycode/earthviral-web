/**
 * Data-freshness evaluation for the staleness watchdog. Pure (no I/O) so it is unit-tested;
 * scripts/check-staleness.ts gathers the inputs.
 */

export type SourceReading =
  { ok: true; generatedAt: string; isSeed?: boolean } | { ok: false; error: string };

export interface StalenessInput {
  /** The deployed site's /data/map-pulse.json — catches failed deploys too. */
  live: SourceReading;
  /** src/data/generated/batch-meta.json on the default branch — catches failed batches. */
  repo: SourceReading;
  now: Date;
  staleAfterHours: number;
}

export interface StalenessResult {
  stale: boolean;
  /** One-line reason, used as the issue title suffix and in logs. */
  summary: string;
  /** Markdown report for the GitHub issue body. */
  report: string;
}

const ageHours = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / 3_600_000;
const fmt = (h: number) => (h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

export function evaluateStaleness(input: StalenessInput): StalenessResult {
  const { live, repo, now, staleAfterHours } = input;

  // Sample (seed) data is intentionally static — never alert on it.
  if (repo.ok && repo.isSeed) {
    return { stale: false, summary: 'sample data — not monitored', report: '' };
  }

  const checks: Array<{ name: string; ok: boolean; line: string }> = [];
  for (const [name, reading] of [
    ['Live site', live],
    ['Repository data', repo],
  ] as const) {
    if (!reading.ok) {
      checks.push({ name, ok: true, line: `- **${name}:** not checked (${reading.error})` });
      continue;
    }
    const age = ageHours(reading.generatedAt, now);
    const ok = age <= staleAfterHours;
    checks.push({
      name,
      ok,
      line: `- **${name}:** last generated ${reading.generatedAt} — ${fmt(age)} ago ${ok ? '✅' : '❌'}`,
    });
  }

  const staleChecks = checks.filter((c) => !c.ok);
  const stale = staleChecks.length > 0;
  const ages = [live, repo]
    .filter((r): r is Extract<SourceReading, { ok: true }> => r.ok)
    .map((r) => ageHours(r.generatedAt, now));
  const oldest = ages.length ? Math.max(...ages) : 0;
  const summary = stale
    ? `${staleChecks.map((c) => c.name.toLowerCase()).join(' and ')} ${fmt(oldest)} old`
    : 'fresh';

  const report = [
    stale
      ? `EarthViral's news data is older than **${staleAfterHours} hours** (batches normally run every 3 hours).`
      : `EarthViral's news data is fresh again.`,
    '',
    ...checks.map((c) => c.line),
    '',
    ...(stale
      ? [
          'Things to check:',
          '- Actions → **Update viral batch**: did recent runs fail or not run? (Scheduled workflows only run from the default branch.)',
          '- Actions → **CI**: did the deploy job fail after a batch?',
          '- AI provider quota or feed outages in the batch log.',
          '',
          'To refresh now: Actions → Update viral batch → **Run workflow**.',
          '',
        ]
      : []),
    `_Checked ${now.toISOString()} by the staleness watchdog. This issue closes itself when data is fresh again._`,
  ].join('\n');

  return { stale, summary, report };
}
