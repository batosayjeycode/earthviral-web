/**
 * SEO and integrity checks against the production build in dist/.
 * Run `npm run build` first, then `npm test` (or `npm run test:dist`).
 *
 * Data-dependent: the page set comes from whatever batch is committed, so assertions are
 * structural (every story page has NewsArticle data, sitemaps list exactly the indexable
 * pages, …) rather than fixed route lists.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://earthviral.com';
const dist = fileURLToPath(new URL('../dist', import.meta.url));

assert.ok(existsSync(dist), 'dist/ is missing: run `npm run build` first');

const batchMeta = JSON.parse(
  readFileSync(new URL('../src/data/generated/batch-meta.json', import.meta.url), 'utf8'),
);
const isSeed = batchMeta.isSeed === true;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** URL path for a built HTML file: dist/about/index.html -> /about/ */
function urlPath(file) {
  const rel = relative(dist, file).replaceAll('\\', '/');
  if (rel === 'index.html') return '/';
  if (rel === '404.html') return '/404/';
  return `/${rel.replace(/index\.html$/, '')}`;
}

const pages = walk(dist)
  .filter((f) => f.endsWith('.html') && !f.includes(`${join(dist, 'pagefind')}`))
  .map((file) => ({ file, path: urlPath(file), html: readFileSync(file, 'utf8') }));

const isNoindex = (html) => /<meta name="robots" content="noindex/.test(html);
const indexable = pages.filter((p) => !isNoindex(p.html));
const stories = pages.filter((p) => p.path.startsWith('/news/'));
const hubs = pages.filter((p) => /^\/(country|category|region|topic)\//.test(p.path));

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const meta = (html, key) => {
  const tag = html.match(new RegExp(`<meta (?:name|property)="${key}" content="[^"]*"[^>]*>`))?.[0];
  return tag && attr(tag, 'content');
};
const decode = (s) =>
  s
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
const jsonLd = (html) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
    JSON.parse(m[1]),
  );
const graphTypes = (html) => jsonLd(html).flatMap((d) => d['@graph'].map((n) => n['@type']));
const fileForPath = (p) => {
  const clean = decodeURI(p.split(/[?#]/)[0]);
  return clean.endsWith('/') ? join(dist, clean, 'index.html') : join(dist, clean);
};
const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decode(m[1]));
const pngSize = (file) => {
  const b = readFileSync(file);
  assert.equal(b.toString('ascii', 1, 4), 'PNG', `${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

describe('build output', () => {
  test('core routes are built', () => {
    const paths = new Set(pages.map((p) => p.path));
    for (const p of ['/', '/404/', '/about/', '/contact/', '/privacy/', '/terms/', '/search/']) {
      assert.ok(paths.has(p), `missing ${p}`);
    }
    assert.ok(stories.length > 0, 'no story pages');
    assert.ok(hubs.length > 0, 'no hub pages');
  });

  test('Pagefind index and client data are present', () => {
    assert.ok(existsSync(join(dist, 'pagefind', 'pagefind.js')), 'pagefind.js');
    assert.ok(existsSync(join(dist, 'data', 'map-pulse.json')), 'map-pulse.json');
    assert.ok(existsSync(join(dist, 'geo', 'countries-110m.topo.json')), 'TopoJSON');
    const pulse = JSON.parse(readFileSync(join(dist, 'data', 'map-pulse.json'), 'utf8'));
    for (const c of pulse.countries) {
      assert.ok(
        existsSync(join(dist, 'data', 'countries', `${c.code.toLowerCase()}.json`)),
        `drawer payload for ${c.code}`,
      );
    }
  });
});

describe('pages', () => {
  for (const page of pages) {
    describe(page.path, () => {
      test('has lang, one h1 and no skipped heading levels inside <main>', () => {
        assert.match(page.html, /<html lang="en"/);
        const main = page.html.match(/<main[\s\S]*<\/main>/)?.[0];
        assert.ok(main, '<main> landmark');
        const levels = [...main.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
        assert.equal(levels.filter((l) => l === 1).length, 1, 'exactly one h1');
        assert.equal(levels[0], 1, 'h1 comes first');
        for (let i = 1; i < levels.length; i++) {
          assert.ok(
            levels[i] <= levels[i - 1] + 1,
            `heading jumps from h${levels[i - 1]} to h${levels[i]}`,
          );
        }
      });

      test('has a title and a description of sensible length', () => {
        const title = page.html.match(/<title>([^<]+)<\/title>/)?.[1];
        assert.ok(title, 'title');
        const description = meta(page.html, 'description');
        assert.ok(description, 'description');
        const len = decode(description).length;
        assert.ok(len >= 25 && len <= 170, `description length ${len}`);
      });

      test('internal links and anchors resolve', () => {
        for (const [, href] of page.html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
          if (/^(https?:|mailto:)/.test(href)) continue;
          const [path, hash] = href.split('#');
          if (path === '') {
            assert.match(page.html, new RegExp(`id="${hash}"`), `missing anchor ${href}`);
            continue;
          }
          assert.ok(path.startsWith('/'), `relative link ${href}`);
          if (!/\.[a-z0-9]+$/.test(path)) {
            assert.ok(path.endsWith('/'), `missing trailing slash: ${href}`);
          }
          const file = fileForPath(path);
          assert.ok(existsSync(file), `broken link ${href} on ${page.path}`);
          if (hash) {
            assert.match(
              readFileSync(file, 'utf8'),
              new RegExp(`id="${hash}"`),
              `missing #${hash}`,
            );
          }
        }
      });

      test('referenced local assets exist', () => {
        for (const [, src] of page.html.matchAll(/\s(?:src|href)="(\/[^"#?]+\.[a-z0-9]+)"/g)) {
          assert.ok(existsSync(join(dist, decodeURI(src))), `missing asset ${src}`);
        }
      });

      test('outbound links open safely', () => {
        for (const [tag] of page.html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
          assert.match(
            attr(tag, 'rel') ?? '',
            /noopener/,
            `target=_blank without noopener: ${tag}`,
          );
        }
      });
    });
  }
});

describe('canonical and social metadata', () => {
  const titles = new Map();
  const descriptions = new Map();

  for (const page of indexable) {
    test(`${page.path} canonical, Open Graph and Twitter`, () => {
      const canonical = page.html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
      assert.equal(canonical, `${ORIGIN}${page.path}`);
      assert.equal(meta(page.html, 'og:url'), canonical);
      assert.ok(meta(page.html, 'og:title'));
      assert.ok(meta(page.html, 'og:description'));
      assert.equal(meta(page.html, 'twitter:card'), 'summary_large_image');
      const image = meta(page.html, 'og:image');
      assert.ok(image?.startsWith(`${ORIGIN}/`), 'og:image must be absolute');
      const file = join(dist, new URL(image).pathname);
      assert.ok(existsSync(file), `og:image file exists: ${image}`);
      assert.deepEqual(pngSize(file), { width: 1200, height: 630 });

      const title = page.html.match(/<title>([^<]+)<\/title>/)[1];
      assert.ok(!titles.has(title), `duplicate title with ${titles.get(title)}: ${title}`);
      titles.set(title, page.path);
      const description = meta(page.html, 'description');
      assert.ok(
        !descriptions.has(description),
        `duplicate description with ${descriptions.get(description)}`,
      );
      descriptions.set(description, page.path);
    });
  }

  test('story pages use their own social card', () => {
    for (const page of stories) {
      assert.match(meta(page.html, 'og:image'), /\/og\/[a-z]{2}-\d{8}-[a-z0-9-]+\.png$/, page.path);
      assert.equal(meta(page.html, 'og:type'), 'article', page.path);
    }
  });

  test('404 and search are noindex without a canonical', () => {
    for (const path of ['/404/', '/search/']) {
      const page = pages.find((p) => p.path === path);
      assert.ok(isNoindex(page.html), `${path} noindex`);
      assert.doesNotMatch(page.html, /rel="canonical"/, `${path} canonical`);
    }
  });

  test('sample-data builds are noindex everywhere', { skip: !isSeed }, () => {
    for (const page of pages) assert.ok(isNoindex(page.html), page.path);
  });
});

describe('structured data', () => {
  test('every JSON-LD block is valid JSON with a schema.org @graph', () => {
    for (const page of pages) {
      for (const doc of jsonLd(page.html)) {
        assert.equal(doc['@context'], 'https://schema.org', page.path);
        assert.ok(Array.isArray(doc['@graph']) && doc['@graph'].length > 0, page.path);
      }
    }
  });

  test('homepage has WebSite (with SearchAction), Organization and ItemList', () => {
    const home = pages.find((p) => p.path === '/');
    assert.deepEqual(graphTypes(home.html).sort(), ['ItemList', 'Organization', 'WebSite']);
    const site = jsonLd(home.html)[0]['@graph'].find((n) => n['@type'] === 'WebSite');
    assert.match(site.potentialAction.target.urlTemplate, /\/search\/\?q=\{search_term_string\}$/);
    const org = jsonLd(home.html)[0]['@graph'].find((n) => n['@type'] === 'Organization');
    assert.ok(existsSync(join(dist, new URL(org.logo.url).pathname)), 'logo exists');
  });

  test('story pages have NewsArticle + BreadcrumbList with real targets', () => {
    for (const page of stories) {
      assert.deepEqual(graphTypes(page.html).sort(), ['BreadcrumbList', 'NewsArticle'], page.path);
      const graph = jsonLd(page.html)[0]['@graph'];
      const article = graph.find((n) => n['@type'] === 'NewsArticle');
      assert.ok(article.headline.length <= 110, `${page.path} headline > 110 chars`);
      assert.ok(article.isBasedOn.length > 0, `${page.path} cites its sources`);
      assert.ok(Date.parse(article.dateModified) >= Date.parse(article.datePublished), page.path);
      for (const img of article.image) {
        assert.ok(existsSync(join(dist, new URL(img).pathname)), `${page.path} image ${img}`);
      }
      const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList').itemListElement;
      crumbs.forEach((item, i) => {
        assert.equal(item.position, i + 1);
        if (item.item) assert.ok(existsSync(fileForPath(new URL(item.item).pathname)), item.item);
      });
    }
  });

  test('hub pages have CollectionPage, BreadcrumbList and ItemList pointing at real stories', () => {
    for (const page of hubs) {
      assert.deepEqual(
        graphTypes(page.html).sort(),
        ['BreadcrumbList', 'CollectionPage', 'ItemList'],
        page.path,
      );
      const list = jsonLd(page.html)[0]['@graph'].find((n) => n['@type'] === 'ItemList');
      for (const item of list.itemListElement) {
        assert.ok(
          existsSync(fileForPath(new URL(item.url).pathname)),
          `${page.path} → ${item.url}`,
        );
      }
    }
  });
});

describe('sitemaps, robots and feeds', () => {
  const index = readFileSync(join(dist, 'sitemap-index.xml'), 'utf8');
  const children = locs(index);
  const all = new Set(
    children.flatMap((url) => locs(readFileSync(join(dist, new URL(url).pathname), 'utf8'))),
  );

  test('sitemap index lists core, news and monthly story sitemaps that exist', () => {
    assert.ok(children.includes(`${ORIGIN}/sitemap-core.xml`));
    assert.ok(children.includes(`${ORIGIN}/sitemap-news.xml`));
    assert.ok(children.some((u) => /\/sitemap-stories-\d{4}-\d{2}\.xml$/.test(u)));
    for (const url of children) assert.ok(existsSync(join(dist, new URL(url).pathname)), url);
  });

  test('sitemaps list exactly the indexable pages', { skip: isSeed }, () => {
    assert.deepEqual([...all].sort(), indexable.map((p) => `${ORIGIN}${p.path}`).sort());
  });

  test('sitemap URLs are canonical (https, apex, trailing slash)', () => {
    for (const loc of all) assert.match(loc, /^https:\/\/earthviral\.com\/([a-z0-9-]+\/)*$/);
  });

  test('Google News sitemap only lists stories from the last 48 hours', () => {
    const xml = readFileSync(join(dist, 'sitemap-news.xml'), 'utf8');
    const cutoff = Date.parse(batchMeta.generatedAt) - 48 * 3_600_000;
    for (const [, date] of xml.matchAll(/<news:publication_date>([^<]+)</g)) {
      assert.ok(Date.parse(date) >= cutoff, `stale news entry ${date}`);
    }
    for (const loc of locs(xml)) assert.match(loc, /\/news\/[a-z]{2}\//);
  });

  test('robots.txt matches the data mode', () => {
    const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
    if (isSeed) {
      assert.match(robots, /^Disallow: \/$/m);
    } else {
      assert.doesNotMatch(robots, /^Disallow:\s*\/\s*$/m);
      assert.match(robots, /^Sitemap: https:\/\/earthviral\.com\/sitemap-index\.xml$/m);
    }
  });

  test('RSS items link to built story pages', () => {
    const rss = readFileSync(join(dist, 'rss.xml'), 'utf8');
    const links = [...rss.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map((m) => m[1]);
    assert.ok(links.length > 0, 'RSS has items');
    for (const link of links) assert.ok(existsSync(fileForPath(new URL(link).pathname)), link);
  });

  test('ads.txt exists', () => {
    assert.ok(existsSync(join(dist, 'ads.txt')));
  });
});

describe('hosting configuration', () => {
  const headers = readFileSync(join(dist, '_headers'), 'utf8');

  test('*.pages.dev deployments are noindex', () => {
    assert.match(headers, /https:\/\/:project\.pages\.dev\/\*\s+X-Robots-Tag: noindex/);
    assert.match(headers, /https:\/\/:version\.:project\.pages\.dev\/\*\s+X-Robots-Tag: noindex/);
  });

  test('generated redirects point at real country pages and never shadow a live page', () => {
    const file = join(dist, '_redirects');
    if (!existsSync(file)) return; // only written by the batch pipeline
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const [from, to, status] = line.trim().split(/\s+/);
      assert.equal(status, '301', line);
      assert.match(from, /^\/news\/[a-z]{2}\/[a-z0-9-]+\/$/, line);
      assert.ok(!existsSync(fileForPath(from)), `redirect shadows a live page: ${from}`);
      assert.match(to, /^\/country\/[a-z-]+\/$/, line);
      assert.ok(existsSync(fileForPath(to)), `redirect target missing: ${to}`);
    }
  });

  test('batch data is never cached as immutable', () => {
    assert.match(headers, /\/data\/\*\s+Cache-Control: public, max-age=300, must-revalidate/);
  });
});

describe('content honesty', () => {
  const text = pages.map((p) => p.html.replace(/<[^>]+>/g, ' ')).join(' ');

  test('no placeholder or fake-proof copy', () => {
    for (const phrase of [
      /coming soon/i,
      /lorem ipsum/i,
      /trusted by/i,
      /\d[\d,.]*\+?\s+(users|readers|subscribers)/i,
      /testimonial/i,
      /\bTODO\b/,
    ]) {
      assert.doesNotMatch(text, phrase);
    }
  });

  test(
    'real builds ship the hidden "data delayed" note (revealed client-side)',
    { skip: isSeed },
    () => {
      const home = pages.find((p) => p.path === '/');
      assert.match(home.html, /<div[^>]*data-stale-note[^>]*hidden/);
      assert.match(home.html, /data-stale-after-hours="\d+"/);
    },
  );

  test('real builds contain no sample stories', { skip: isSeed }, () => {
    assert.doesNotMatch(text, /\[Sample\]|Sample story:/);
  });
});
