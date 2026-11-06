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
  /** Minimum independent outlets for a new story (or 1 outlet + a matching Google Trends search). */
  minPublishers: 2,
} as const;
