/** Unit tests for the staleness watchdog evaluation. Run: `npm test`. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateStaleness } from './staleness.ts';

const now = new Date('2026-11-07T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const base = { now, staleAfterHours: 9 };

describe('staleness watchdog', () => {
  it('is fresh when both sources are recent', () => {
    const r = evaluateStaleness({
      ...base,
      live: { ok: true, generatedAt: hoursAgo(2) },
      repo: { ok: true, generatedAt: hoursAgo(2) },
    });
    assert.equal(r.stale, false);
    assert.equal(r.summary, 'fresh');
  });

  it('flags a failed deploy (live site old, repository fresh)', () => {
    const r = evaluateStaleness({
      ...base,
      live: { ok: true, generatedAt: hoursAgo(15) },
      repo: { ok: true, generatedAt: hoursAgo(1) },
    });
    assert.equal(r.stale, true);
    assert.match(r.summary, /^live site 15\.0 h old$/);
    assert.match(r.report, /CI/);
  });

  it('flags failed batches and reports days for long gaps', () => {
    const r = evaluateStaleness({
      ...base,
      live: { ok: true, generatedAt: hoursAgo(72) },
      repo: { ok: true, generatedAt: hoursAgo(72) },
    });
    assert.equal(r.stale, true);
    assert.match(r.summary, /live site and repository data 3\.0 days old/);
  });

  it('falls back to the repository when the live site is unreachable (e.g. before launch)', () => {
    const fresh = evaluateStaleness({
      ...base,
      live: { ok: false, error: 'unreachable' },
      repo: { ok: true, generatedAt: hoursAgo(3) },
    });
    assert.equal(fresh.stale, false);
    assert.match(fresh.report, /not checked \(unreachable\)/);
    const stale = evaluateStaleness({
      ...base,
      live: { ok: false, error: 'unreachable' },
      repo: { ok: true, generatedAt: hoursAgo(10) },
    });
    assert.equal(stale.stale, true);
  });

  it('never alerts on sample (seed) data', () => {
    const r = evaluateStaleness({
      ...base,
      live: { ok: true, generatedAt: hoursAgo(500) },
      repo: { ok: true, generatedAt: hoursAgo(500), isSeed: true },
    });
    assert.equal(r.stale, false);
  });
});
