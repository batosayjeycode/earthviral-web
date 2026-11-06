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
      await page.addInitScript(() => {
        window.__cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__cls += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
      });
      await page.goto(BASE + STORY);
      if (!(await page.locator('[data-stale-note]').isVisible())) fail('note not shown when stale');
      const next = await page.locator('time[data-next-update]').textContent();
      if (next !== 'Overdue') fail(`Next Update should read "Overdue", got "${next}"`);
      const cls = await page.evaluate(() => window.__cls);
      if (cls > 0) fail(`showing the note caused layout shift (CLS ${cls.toFixed(3)})`);
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
