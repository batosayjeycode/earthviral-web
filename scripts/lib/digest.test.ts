/** Daily digest grouping: WIB day boundaries, the minimum-size rule and ranking. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MIN_DIGEST_STORIES,
  buildDigestDays,
  formatDayLong,
  wibDay,
} from '../../src/lib/digest.ts';
import type { ViralClusterStaticRecord } from '../../src/lib/types.ts';

let seq = 0;
const story = (firstDetectedAt: string, viralScore: number, countryCode = 'ID') =>
  ({
    id: `s${++seq}`,
    countryCode,
    viralScore,
    firstDetectedAt,
    lastUpdatedBatchAt: firstDetectedAt,
    sources: [],
  }) as unknown as ViralClusterStaticRecord;

describe('daily digest', () => {
  test('days follow WIB (UTC+7)', () => {
    assert.equal(wibDay('2026-11-22T16:59:59Z'), '2026-11-22');
    assert.equal(wibDay('2026-11-22T17:00:00Z'), '2026-11-23');
    assert.equal(formatDayLong('2026-11-03'), 'November 3, 2026');
  });

  test('groups by day, newest first, skips thin days and ranks by score', () => {
    const full = Array.from({ length: MIN_DIGEST_STORIES }, (_, i) =>
      story('2026-11-21T03:00:00Z', 40 + i, i % 2 ? 'ID' : 'MY'),
    );
    const newer = Array.from({ length: MIN_DIGEST_STORIES }, () =>
      story('2026-11-22T03:00:00Z', 50),
    );
    const thin = [story('2026-11-20T03:00:00Z', 99)];
    const days = buildDigestDays([...full, ...thin, ...newer]);

    assert.deepEqual(
      days.map((d) => d.day),
      ['2026-11-22', '2026-11-21'],
    );
    const [, older] = days;
    assert.ok(older);
    assert.equal(older.path, '/digest/2026-11-21/');
    assert.equal(older.stories[0]?.viralScore, 40 + MIN_DIGEST_STORIES - 1);
    assert.equal(older.countryCount, 2);
  });

  test('a day that drops out redirects to /digest/ until it comes back', async () => {
    const { mergeRetired, retiredDigestDays } = await import('./builders/writeStaticJson.ts');
    const day = (iso: string) => Array.from({ length: MIN_DIGEST_STORIES }, () => story(iso, 50));
    const kept = day('2026-11-22T03:00:00Z');
    const dropping = day('2026-11-21T03:00:00Z');
    const at = '2026-11-24T00:00:00Z';

    // One story fewer leaves the 21st under the minimum; the 22nd stays live.
    const retired = retiredDigestDays([...kept, ...dropping], [...kept, ...dropping.slice(1)], at);
    assert.deepEqual(retired, [
      { path: '/digest/2026-11-21/', redirectTo: '/digest/', retiredAt: at },
    ]);

    const now = new Date(at);
    assert.equal(mergeRetired([], retired, new Set(), now).length, 1);
    // Live again (e.g. a merge moved stories back): the redirect must not shadow the page.
    assert.equal(mergeRetired(retired, [], new Set(['/digest/2026-11-21/']), now).length, 0);
  });
});
