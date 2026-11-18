/**
 * Header edition (country button): resolution order, the one-day geo cache, the /api/geo
 * Pages Function, and the mapping for every tracked country.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { onRequestGet } from '../../functions/api/geo.ts';
import {
  DEFAULT_EDITION,
  GEO_TTL_MS,
  readGeoCache,
  resolveEdition,
  writeGeoCache,
  type Editions,
} from '../../src/lib/edition.ts';
import { flagEmoji } from '../../src/lib/taxonomy.ts';

const countries = JSON.parse(
  readFileSync(new URL('../../src/data/generated/countries-master.json', import.meta.url), 'utf8'),
) as { code: string; slug: string; name: string }[];
// Built exactly like Header.astro does.
const editions: Editions = Object.fromEntries(countries.map((c) => [c.code, [c.slug, c.name]]));

const geo = (init: { cf?: string; header?: string }) => {
  const request = new Request('https://earthviral.com/api/geo', {
    headers: init.header ? { 'CF-IPCountry': init.header } : {},
  }) as Request & { cf?: { country?: string } };
  if (init.cf) request.cf = { country: init.cf };
  return onRequestGet({ request });
};

describe('edition resolution', () => {
  test('manual pick beats detected country, which beats Indonesia', () => {
    assert.equal(resolveEdition(editions, 'JP', 'US'), 'JP');
    assert.equal(resolveEdition(editions, null, 'US'), 'US');
    assert.equal(resolveEdition(editions, null, null), DEFAULT_EDITION);
    assert.equal(resolveEdition(editions, undefined, undefined), DEFAULT_EDITION);
  });

  test('countries without a page fall through to the next source', () => {
    assert.equal(resolveEdition(editions, 'AQ', 'US'), 'US'); // stale/unknown manual pick
    assert.equal(resolveEdition(editions, null, 'AQ'), DEFAULT_EDITION);
    assert.equal(resolveEdition(editions, 'xx', 'zz'), DEFAULT_EDITION);
  });

  test(`every tracked country (${countries.length}) is its own edition with a valid flag`, () => {
    assert.ok(countries.length >= 39);
    assert.ok(editions[DEFAULT_EDITION], 'Indonesia must be an edition');
    for (const c of countries) {
      assert.equal(resolveEdition(editions, null, c.code), c.code, c.code);
      assert.equal(resolveEdition(editions, c.code, null), c.code, c.code);
      assert.match(c.slug, /^[a-z0-9-]+$/, c.code);
      const flag = [...flagEmoji(c.code)].map((ch) => ch.codePointAt(0)!);
      assert.deepEqual(
        flag.map((p) => String.fromCharCode(p - 0x1f1a5)).join(''),
        c.code,
        `${c.code} flag`,
      );
    }
  });
});

describe('geo cache (one day, per visitor localStorage)', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');

  test('round-trips within the day', () => {
    assert.deepEqual(readGeoCache(writeGeoCache('US', now), now), { country: 'US' });
    assert.deepEqual(readGeoCache(writeGeoCache(null, now), now + 1000), { country: null });
    assert.deepEqual(readGeoCache(writeGeoCache('US', now), now + GEO_TTL_MS - 1), {
      country: 'US',
    });
  });

  test('expires after exactly one day', () => {
    assert.equal(readGeoCache(writeGeoCache('US', now), now + GEO_TTL_MS), undefined);
  });

  test('ignores missing, corrupt, future-dated or malformed entries', () => {
    for (const raw of [
      null,
      '',
      'not json',
      'null',
      '"US"',
      '{"country":"US"}',
      `{"country":"US","at":${now + 60_000}}`,
      `{"country":"usa","at":${now}}`,
      `{"country":42,"at":${now}}`,
    ])
      assert.equal(readGeoCache(raw, now), undefined, String(raw));
  });
});

describe('/api/geo Pages Function', () => {
  test("returns Cloudflare's country, preferring request.cf", async () => {
    assert.deepEqual(await geo({ cf: 'US' }).json(), { country: 'US' });
    assert.deepEqual(await geo({ cf: 'JP', header: 'US' }).json(), { country: 'JP' });
    assert.deepEqual(await geo({ header: 'gb' }).json(), { country: 'GB' });
  });

  test('unknown, Tor and malformed locations are null', async () => {
    for (const header of [undefined, 'XX', 'T1', 'USA', '1A'])
      assert.deepEqual(await geo({ header }).json(), { country: null }, String(header));
  });

  test('is never cached by shared caches or the browser, and not indexed', () => {
    const res = geo({ cf: 'US' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('X-Robots-Tag'), 'noindex');
    assert.match(res.headers.get('Content-Type') ?? '', /^application\/json/);
  });
});
