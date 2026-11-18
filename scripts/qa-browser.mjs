/**
 * Browser QA against the production build (run `npm run build` first):
 * accessibility (axe, WCAG 2.1 AA + best practices), responsive overflow, console errors,
 * Cmd+K search, the country drawer, the deferred map on touch devices, the no-JS fallback,
 * 404 status, layout shift / LCP, and (opt-in) external link status.
 * Screenshots go to qa-report/.
 *
 * Usage: npm run qa                 (all checks except external links)
 *        npm run qa -- --external   (also check one outbound link per publisher domain)
 */
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';
import { serveDist } from './lib/static-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const PORT = 4329;
const BASE = `http://localhost:${PORT}`;
const external = process.argv.includes('--external');
const outDir = join(root, 'qa-report');
await mkdir(outDir, { recursive: true });

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/ is missing: run `npm run build` first.');
  process.exit(1);
}

// Data-dependent pages: pick the first built story, country hub and non-empty category.
const firstDir = async (dir) =>
  (await readdir(join(dist, dir), { withFileTypes: true })).find((e) => e.isDirectory())?.name;
const storyCountry = await firstDir('news');
const STORY = `/news/${storyCountry}/${await firstDir(`news/${storyCountry}`)}/`;
const COUNTRY = `/country/${await firstDir('country')}/`;
const categories = (await readdir(join(dist, 'category'))).sort();
let CATEGORY = `/category/${categories[0]}/`;
for (const c of categories) {
  const html = await readFile(join(dist, 'category', c, 'index.html'), 'utf8');
  if (!/<meta name="robots" content="noindex/.test(html)) {
    CATEGORY = `/category/${c}/`;
    break;
  }
}

const PAGES = [
  '/',
  STORY,
  COUNTRY,
  `${COUNTRY}archive/`,
  CATEGORY,
  '/about/',
  '/search/',
  '/contact/',
  '/privacy/',
  '/terms/',
];
const VIEWPORTS = [
  { name: 'mobile', width: 360, height: 780 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
};
const pass = (msg) => console.log(`  ✓ ${msg}`);
const slugOf = (path) => (path === '/' ? 'home' : path.replaceAll('/', '-').replace(/^-|-$/g, ''));

// ---------- Server (mimics Cloudflare Pages routing) ----------
const server = await serveDist(dist, PORT);
// SwiftShader gives headless Chromium a software WebGL context for the MapLibre globe.
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });

try {
  // ---------- Per page × viewport ----------
  for (const vp of VIEWPORTS) {
    console.log(`\n[${vp.name} ${vp.width}×${vp.height}]`);
    const context = await browser.newContext({ viewport: vp, reducedMotion: 'reduce' });
    for (const path of PAGES) {
      const page = await context.newPage();
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));

      const res = await page.goto(BASE + path, { waitUntil: 'networkidle' });
      if (res?.status() !== 200) fail(`${path} returned ${res?.status()}`);
      if (path === '/') {
        // Desktop-class pointers load the live map when idle; wait so it is part of the audit.
        await page
          .waitForSelector('[data-map-hero][data-map-ready]', { timeout: 15_000 })
          .catch(() => fail(`${vp.name}: live map did not become ready`));
      }

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      if (overflow > 0) fail(`${path} overflows horizontally by ${overflow}px`);

      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        // MapLibre's canvas and attribution control are third-party UI inside the map region.
        .exclude('.maplibregl-canvas-container')
        .exclude('.maplibregl-control-container')
        .analyze();
      for (const v of axe.violations) {
        fail(`${path} axe ${v.impact} ${v.id}: ${v.help} (${v.nodes.length} nodes)`);
        for (const n of v.nodes.slice(0, 3)) console.log(`      ${n.target.join(' ')}`);
      }

      if (errors.length) fail(`${path} console/network errors: ${errors.join(' | ')}`);
      if (!overflow && !axe.violations.length && !errors.length) {
        pass(`${path}: no overflow, 0 axe violations, no console errors`);
      }

      await page.screenshot({
        path: join(outDir, `${vp.name}-${slugOf(path)}.png`),
        fullPage: path !== '/',
      });
      await page.close();
    }
    await context.close();
  }

  // ---------- Search (⌘K / Ctrl+K) ----------
  console.log('\n[search]');
  {
    const before = failures.length;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(BASE + STORY, { waitUntil: 'networkidle' });
    // Use a word from the story headline so the index is guaranteed to match.
    const h1 = (await page.locator('main h1').textContent()) ?? '';
    const word = h1.split(/\s+/).find((w) => /^[A-Za-z]{5,}$/.test(w)) ?? 'viral';
    await page.keyboard.press('Control+k');
    const dialog = page.locator('dialog.ev-search');
    if (!(await dialog.evaluate((d) => d.open))) fail('Ctrl+K did not open the search dialog');
    await page.keyboard.type(word);
    const option = page.getByRole('option').first();
    await option.waitFor({ timeout: 10_000 }).catch(() => fail(`no results for "${word}"`));
    await page.screenshot({ path: join(outDir, 'search-results.png') });
    await page.keyboard.press('Escape');
    if (await dialog.evaluate((d) => d.open)) fail('Escape did not close the search dialog');
    const res = await page.goto(`${BASE}/search/?q=${encodeURIComponent(word)}`);
    if (res?.status() !== 200) fail('/search/ page failed');
    await page
      .getByRole('option')
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => fail('/search/?q= did not show results'));
    if (failures.length === before)
      pass(`dialog opens, finds "${word}", closes; /search/?q= works`);
    await context.close();
  }

  // ---------- Country drawer ----------
  console.log('\n[country drawer]');
  {
    const before = failures.length;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-map-hero][data-map-ready]', { timeout: 15_000 });
    const beacon = page.locator('.ev-beacon').first();
    const label = await beacon.getAttribute('aria-label');
    await beacon.focus();
    await page.keyboard.press('Enter');
    const drawer = page.locator('aside.ev-drawer[data-open]');
    await drawer.waitFor({ timeout: 5_000 }).catch(() => fail('drawer did not open'));
    await drawer
      .locator('article')
      .first()
      .waitFor({ timeout: 5_000 })
      .catch(() => fail('drawer shows no stories'));
    const focused = await page.evaluate(() => document.activeElement?.id);
    if (focused !== 'ev-drawer-title')
      fail(`focus should move to the drawer title, got "${focused}"`);
    await page.screenshot({ path: join(outDir, 'drawer-open.png') });
    await page.keyboard.press('Escape');
    if (await page.locator('aside.ev-drawer[data-open]').count()) fail('Escape did not close');
    if (failures.length === before) pass(`opens from keyboard (${label}), lists stories, closes`);
    await context.close();
  }

  // ---------- Header edition: geo detection, manual pick, cache, fallbacks ----------
  console.log('\n[geo edition]');
  {
    const before = failures.length;
    const countries = JSON.parse(
      await readFile(new URL('../src/data/generated/countries-master.json', import.meta.url)),
    );
    const flagOf = (code) =>
      String.fromCodePoint(...[...code].map((ch) => 0x1f1a5 + ch.charCodeAt(0)));
    const slugOf = Object.fromEntries(countries.map((c) => [c.code, c.slug]));
    const edition = (page) =>
      page.locator('[data-edition]').evaluate((a) => ({
        code: a.dataset.current,
        href: a.getAttribute('href'),
        flag: a.querySelector('[data-edition-flag]')?.textContent?.trim(),
        name: a.querySelector('[data-edition-name]')?.textContent?.trim(),
      }));
    const expectEdition = (got, code, label) => {
      const want = { code, href: `/country/${slugOf[code]}/`, flag: flagOf(code) };
      if (got.code !== want.code || got.href !== want.href || got.flag !== want.flag)
        fail(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    };
    /** A fresh visitor (own browser storage) whose IP geolocates to `country`. */
    const visitor = async (country, setup) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: country ? { 'CF-IPCountry': country } : {},
      });
      const page = await context.newPage();
      const calls = { n: 0 };
      page.on('request', (r) => new URL(r.url()).pathname === '/api/geo' && calls.n++);
      if (setup) await setup(page, context);
      return { context, page, calls };
    };
    const go = (page, path) => page.goto(BASE + path, { waitUntil: 'networkidle' });

    // 1. Every tracked country maps to its own edition (separate visitors, in parallel).
    const wrong = [];
    for (let k = 0; k < countries.length; k += 8) {
      await Promise.all(
        countries.slice(k, k + 8).map(async ({ code }) => {
          const v = await visitor(code);
          await go(v.page, '/privacy/');
          const got = await edition(v.page);
          if (
            got.code !== code ||
            got.href !== `/country/${slugOf[code]}/` ||
            got.flag !== flagOf(code)
          )
            wrong.push(`${code}→${JSON.stringify(got)}`);
          await v.context.close();
        }),
      );
    }
    if (wrong.length) fail(`geo mapping wrong for: ${wrong.join(', ')}`);

    // 3. One /api/geo call per visitor per day; an expired entry is refreshed.
    {
      const v = await visitor('US');
      await go(v.page, '/about/');
      expectEdition(await edition(v.page), 'US', 'US visitor');
      await go(v.page, '/privacy/');
      await v.page.reload({ waitUntil: 'networkidle' });
      if (v.calls.n !== 1) fail(`expected 1 /api/geo call across 3 loads, got ${v.calls.n}`);
      const age = await v.page.evaluate(() => Date.now() - JSON.parse(localStorage['ev-geo']).at);
      if (!(age >= 0 && age < 60_000)) fail(`geo cache timestamp off by ${age} ms`);
      // Age the entry past one day: the next page asks again.
      await v.page.evaluate(() => {
        localStorage['ev-geo'] = JSON.stringify({ country: 'US', at: Date.now() - 86_400_001 });
      });
      await go(v.page, '/terms/');
      if (v.calls.n !== 2)
        fail(`expired geo cache should trigger a new call (calls: ${v.calls.n})`);
      await v.context.close();
    }
    // A fresh cached answer is used as-is (no call), so storage is the per-visitor source.
    {
      const v = await visitor('US', (page) =>
        page.addInitScript(() => {
          if (!localStorage['ev-geo'])
            localStorage['ev-geo'] = JSON.stringify({ country: 'JP', at: Date.now() - 3_600_000 });
        }),
      );
      await go(v.page, '/about/');
      expectEdition(await edition(v.page), 'JP', 'cached JP for a US IP');
      if (v.calls.n) fail(`fresh cache should skip /api/geo (calls: ${v.calls.n})`);
      await v.context.close();
    }

    // 2. A manual pick overrides geo, survives reloads and other pages, and can be undone.
    {
      const v = await visitor('US');
      await go(v.page, '/about/');
      await v.page.locator('[data-edition-toggle]').click();
      if ((await v.page.locator('[data-edition-list] [data-code]').count()) !== countries.length)
        fail('edition menu should list every tracked country');
      await Promise.all([
        v.page.waitForURL('**/country/japan/'),
        v.page.locator('[data-edition-list] [data-code="JP"]').click(),
      ]);
      await v.page.waitForLoadState('networkidle');
      expectEdition(await edition(v.page), 'JP', 'after picking Japan');
      await v.page.reload({ waitUntil: 'networkidle' });
      expectEdition(await edition(v.page), 'JP', 'manual pick after reload');
      await go(v.page, '/privacy/');
      expectEdition(await edition(v.page), 'JP', 'manual pick on another page');
      if (v.calls.n !== 1) fail(`manual pick should not re-query geo (calls: ${v.calls.n})`);
      await v.page.locator('[data-edition-toggle]').click();
      await v.page.locator('[data-edition-auto]').click();
      expectEdition(await edition(v.page), 'US', '"Use my location"');
      await v.page.reload({ waitUntil: 'networkidle' });
      expectEdition(await edition(v.page), 'US', '"Use my location" after reload');
      if (await v.page.locator('[data-edition-auto]').isVisible())
        fail('"Use my location" should hide once there is no manual pick');
      // Keyboard: Escape closes the menu and returns focus to its button.
      await v.page.locator('[data-edition-toggle]').click();
      await v.page.keyboard.press('Escape');
      if (await v.page.locator('[data-edition-menu]').isVisible()) fail('Escape did not close');
      await v.context.close();
    }

    // No flash: a saved edition (manual pick, or a detected country cached < 1 day) is in
    // place from the very first painted frame, and doesn't depend on the module script.
    for (const [label, key, value, want] of [
      ['manual pick', 'ev-edition', 'JP', 'JP'],
      ['cached geo', 'ev-geo', null, 'GB'],
    ]) {
      const v = await visitor('US', async (page) => {
        await page.addInitScript(
          ([key, value]) => {
            if (!sessionStorage.qaSeeded) {
              sessionStorage.qaSeeded = '1';
              localStorage[key] =
                value ?? JSON.stringify({ country: 'GB', at: Date.now() - 3_600_000 });
            }
            // Edition shown in every animation frame (each frame is what gets painted).
            window.__frames = [];
            const tick = () => {
              const a = document.querySelector('[data-edition]');
              if (a) {
                const shown = `${a.dataset.current}:${a.textContent.trim().replace(/\s+/g, ' ')}`;
                if (window.__frames.at(-1) !== shown) window.__frames.push(shown);
              }
              if (document.readyState !== 'complete' || window.__frames.length === 0)
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          },
          [key, value],
        );
      });
      await go(v.page, '/about/');
      const frames = await v.page.evaluate(() => window.__frames);
      if (frames.length !== 1 || !frames[0].startsWith(`${want}:`))
        fail(`${label}: header changed after first paint: ${JSON.stringify(frames)}`);
      // Same page with every bundled module blocked: the inline restore alone must do it.
      await v.page.route('**/_astro/*.js', (route) => route.abort());
      await v.page.reload({ waitUntil: 'load' });
      expectEdition(await edition(v.page), want, `${label} without module JS`);
      if (!(await v.page.locator('[data-edition-toggle]').isVisible()))
        fail(`${label}: menu button should be revealed by the inline script`);
      await v.context.close();
    }

    // 4. Unsupported or unknown locations and API failures fall back to Indonesia, and a
    //    failure is not cached (the next page retries). Blocking /api/geo is also what a
    //    crawler that obeys robots.txt (Disallow: /api/) sees.
    for (const country of ['AQ', 'XX', null]) {
      const v = await visitor(country);
      await go(v.page, '/about/');
      expectEdition(await edition(v.page), 'ID', `location ${country ?? 'missing'}`);
      await v.context.close();
    }
    for (const [label, handler] of [
      ['HTTP 500', (route) => route.fulfill({ status: 500, body: 'error' })],
      ['network error', (route) => route.abort()],
      ['invalid JSON', (route) => route.fulfill({ status: 200, body: '<html>' })],
    ]) {
      const v = await visitor('US', (page) => page.route('**/api/geo', handler));
      await go(v.page, '/about/');
      expectEdition(await edition(v.page), 'ID', label);
      if (await v.page.evaluate(() => localStorage['ev-geo'] !== undefined))
        fail(`${label}: a failed lookup must not be cached`);
      await go(v.page, '/privacy/');
      if (v.calls.n !== 2) fail(`${label}: the next page should retry (calls: ${v.calls.n})`);
      await v.context.close();
    }

    // 6. Without JS (as in the raw HTML crawlers index) the header is the Indonesia link only.
    {
      const context = await browser.newContext({ javaScriptEnabled: false });
      const page = await context.newPage();
      await page.goto(BASE + '/about/');
      expectEdition(await edition(page), 'ID', 'no-JS');
      if (await page.locator('[data-edition-toggle]').isVisible())
        fail('no-JS: the edition menu button should stay hidden');
      await context.close();
    }

    if (failures.length === before)
      pass(
        `all ${countries.length} countries map to their edition; manual pick persists and ` +
          'overrides geo; 1 call per day; failures/unknown → Indonesia, not cached',
      );
  }

  // ---------- Deferred map on touch devices ----------
  console.log('\n[touch: deferred map]');
  {
    const before = failures.length;
    const context = await browser.newContext({
      viewport: { width: 360, height: 780 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const tap = page.getByRole('button', { name: 'Tap to explore the live map' });
    if (!(await tap.isVisible())) fail('"Tap to explore" button not shown on touch devices');
    const loadedEarly = await page.evaluate(() =>
      performance.getEntriesByType('resource').some((r) => /maplibre-gl\.[^/]+\.js$/.test(r.name)),
    );
    if (loadedEarly) fail('MapLibre downloaded before any interaction on a touch device');
    await tap.tap();
    await page
      .waitForSelector('[data-map-hero][data-map-ready]', { timeout: 20_000 })
      .catch(() => fail('map did not load after tapping'));
    await page.screenshot({ path: join(outDir, 'mobile-map-after-tap.png') });
    if (failures.length === before) pass('static globe first, MapLibre loads only after a tap');
    await context.close();
  }

  // ---------- "Data delayed" note ----------
  console.log('\n[data delayed note]');
  {
    const before = failures.length;
    const meta = JSON.parse(
      await readFile(join(root, 'src', 'data', 'generated', 'batch-meta.json'), 'utf8'),
    );
    if (meta.isSeed) {
      pass('skipped (sample data never shows the note)');
    } else {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      // Fresh: right after the batch, the note stays hidden.
      await page.clock.setFixedTime(new Date(Date.parse(meta.generatedAt) + 60 * 60_000));
      await page.goto(BASE + STORY);
      if (await page.locator('[data-stale-note]').isVisible()) fail('note shown for fresh data');
      // Stale: 10 hours later, the note appears and "Next Update" reads "Overdue".
      await page.clock.setFixedTime(new Date(Date.parse(meta.generatedAt) + 10 * 3_600_000));
      await page.goto(BASE + STORY);
      if (!(await page.locator('[data-stale-note]').isVisible())) fail('note not shown when stale');
      const next = await page.locator('time[data-next-update]').textContent();
      if (next !== 'Overdue') fail(`Next Update should read "Overdue", got "${next}"`);
      // The note must not move anything: compare every other item in the bar, and the bar's
      // height, with the note shown vs hidden. (Page-wide CLS isn't used here: on CI it also
      // picks up unrelated sub-pixel shifts such as web-font swaps.)
      const moved = await page.evaluate(() => {
        const bar = document.querySelector('[data-stale-after-hours]');
        const note = bar.querySelector('[data-stale-note]');
        const snapshot = () =>
          JSON.stringify([
            bar.getBoundingClientRect().height,
            ...[...bar.children]
              .filter((el) => el !== note)
              .map((el) => {
                const r = el.getBoundingClientRect();
                return [r.left, r.top, r.width, r.height];
              }),
          ]);
        const shown = snapshot();
        note.hidden = true;
        const hidden = snapshot();
        note.hidden = false;
        return shown !== hidden;
      });
      if (moved) fail('showing the note moved other items in the telemetry bar');
      await page.screenshot({ path: join(outDir, 'data-delayed-note.png') });
      if (failures.length === before)
        pass('hidden when fresh; shown + "Overdue" when stale; no layout shift');
      await context.close();
    }
  }

  // ---------- No-JS fallback ----------
  console.log('\n[no JavaScript]');
  {
    const before = failures.length;
    const context = await browser.newContext({
      viewport: { width: 360, height: 780 },
      javaScriptEnabled: false,
    });
    const page = await context.newPage();
    await page.goto(BASE + '/');
    if (!(await page.locator('h1').isVisible())) fail('hero H1 not rendered without JS');
    if (!(await page.locator('svg.ev-silhouette').isVisible())) fail('static globe missing');
    if ((await page.locator('#trending article').count()) === 0) fail('no trending stories');
    const searchHref = await page.locator('[data-search-trigger]').getAttribute('href');
    if (searchHref !== '/search/')
      fail(`search trigger should link to /search/, got ${searchHref}`);
    await page.goto(BASE + STORY);
    if ((await page.locator('#sources-heading').count()) === 0) fail('story sources missing');
    await page.screenshot({ path: join(outDir, 'mobile-no-js-story.png'), fullPage: true });
    if (failures.length === before) pass('homepage, stories and search link work without JS');
    await context.close();
  }

  // ---------- 404 ----------
  console.log('\n[404]');
  {
    const page = await browser.newPage();
    const res = await page.goto(BASE + '/definitely-not-a-page/');
    if (res?.status() !== 404) fail(`unknown path returned ${res?.status()}, expected 404`);
    else pass('unknown path returns 404 with the custom page');
    const redirect = await fetch(BASE + '/about', { redirect: 'manual' });
    if (redirect.status !== 308 || redirect.headers.get('location') !== '/about/') {
      fail('/about should redirect to /about/');
    } else pass('/about redirects to the canonical /about/');
    await page.close();
  }

  // ---------- Layout shift & LCP (throttled mobile) ----------
  console.log('\n[web vitals, simulated slow 4G / 4x CPU, touch device]');
  for (const path of ['/', STORY]) {
    const context = await browser.newContext({
      viewport: { width: 360, height: 780 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.addInitScript(() => {
      window.__cls = 0;
      window.__lcp = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        window.__lcp = entries[entries.length - 1].startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
    const { cls, lcp } = await page.evaluate(() => ({ cls: window.__cls, lcp: window.__lcp }));
    const msg = `${path}: CLS ${cls.toFixed(3)}, LCP ${Math.round(lcp)} ms`;
    if (cls > 0.1) fail(`${msg} (CLS above 0.1)`);
    else if (lcp > 2500) fail(`${msg} (LCP above 2.5 s)`);
    else pass(msg);
    await context.close();
  }

  // ---------- External links (opt-in: news sites often block automated requests) ----------
  if (external) {
    console.log('\n[external links — one per domain]');
    const htmlFiles = [];
    const walk = async (dir) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (p.endsWith('.html')) htmlFiles.push(p);
      }
    };
    await walk(dist);
    const byDomain = new Map();
    for (const f of htmlFiles) {
      const html = await readFile(f, 'utf8');
      for (const [, href] of html.matchAll(/<a\b[^>]*\shref="(https?:[^"]+)"/g)) {
        const host = new URL(href).host;
        if (!byDomain.has(host)) byDomain.set(host, href.replaceAll('&amp;', '&'));
      }
    }
    for (const url of byDomain.values()) {
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: { 'user-agent': 'EarthViralBot/1.0 (+https://earthviral.com/about/)' },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status >= 400) fail(`${url} → ${res.status}`);
        else pass(`${url} → ${res.status}`);
      } catch (e) {
        fail(`${url} → ${e.message}`);
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\nScreenshots: ${outDir}`);
if (failures.length) {
  console.log(`\n${failures.length} problem(s) found.`);
  process.exit(1);
}
console.log('\nAll browser QA checks passed.');
