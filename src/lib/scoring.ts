/**
 * Viral Activity Score constants — shared by the batch pipeline
 * (`scripts/lib/intelligence/computeViralScore.ts`) and the public methodology page
 * (`/about/`), so the published explanation can never drift from the real formula.
 */
export const VAS = {
  /** coverage = 100 · (1 − e^(−publishers / coverageScale)) */
  coverageScale: 2.5,
  /** velocity = 100 · (1 − e^(−Σ e^(−ageHours / velocityHalfLifeHours) / velocityScale)) */
  velocityHalfLifeHours: 6,
  velocityScale: 2.5,
  /** search = searchBase + searchPerDecade · log10(traffic + 1), capped at 100 */
  searchBase: 40,
  searchPerDecade: 12,
  weights: { coverage: 0.55, velocity: 0.45, searchBonus: 0.15 },
  /** Hours without new coverage before a story leaves the live map. */
  activeWindowHours: 48,
  /** Days without new coverage before a story is removed. */
  retentionDays: 30,
  /**
   * Stories per country that can be *live* (active) at once — new candidates compete with
   * active stories on current score. Existing stories are never removed by this cap; they
   * stay published as archive pages. Override per run with --max-stories-per-country or the
   * MAX_STORIES_PER_COUNTRY env var; 0 = no cap.
   */
  maxStoriesPerCountry: 10,
  /**
   * Total stories kept on the site; beyond this the oldest (by last coverage) are retired.
   * Bounds the static build: each story costs ~5 files (page, OG image, search index) and
   * Cloudflare Pages allows 20,000 files per deployment on the free plan (100,000 on paid).
   * Override per run with --max-stored-stories or MAX_STORED_STORIES; 0 = no limit.
   */
  maxStoredStories: 2500,
  /** How long a removed story's URL keeps redirecting to its country page. */
  redirectRetentionDays: 90,
  /**
   * Minute past the hour the scheduled batch runs (cron `17 2-23/3 * * *`). Kept off :00,
   * where GitHub most often delays or drops scheduled runs. Keep in sync with
   * .github/workflows/update-viral-batch.yml — the site's "Next Update" time uses it.
   */
  batchCronMinute: 17,
  /**
   * Data older than this is "delayed": the telemetry bar shows a notice and the staleness
   * watchdog (.github/workflows/staleness-watchdog.yml) opens a GitHub issue. Batches run
   * every 3 hours, so 9 hours means three missed runs.
   */
  staleAfterHours: 9,
  /** Minimum independent outlets for a new story (or 1 outlet + a matching Google Trends search). */
  minPublishers: 2,
} as const;
