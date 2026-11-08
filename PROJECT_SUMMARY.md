# EarthViral — Project Summary

_Last updated: 8 November 2026, 12:45 UTC_

EarthViral (**https://earthviral.com**) is a global viral-news map. Every 3 hours a batch job reads public news feeds, groups articles about the same event, scores how much attention each story gets, writes neutral AI summaries that link to every original publisher, and rebuilds the whole site as static pages on Cloudflare.

---

## 1. Current status

| Area                   | Status                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live site              | ✅ `https://earthviral.com`, served by Cloudflare Pages (`www` and `*.pages.dev` 301-redirect here)                                                |
| Automatic news updates | ✅ Every 3 h at **xx:17 UTC** (00:17, 03:17 … WIB), started by the Cloudflare Worker scheduler; 8 consecutive successful runs as of the last check |
| AI summaries           | ✅ Gemini `gemini-3.1-flash-lite`; latest batch: 26 calls, **0 failures**                                                                          |
| Data                   | Latest `batch-202611081117`: **158 viral topics, 30 active countries**, global index 81                                                            |
| Staleness watchdog     | ✅ Hourly at **xx:41 UTC**; no `stale-data` issue ever opened                                                                                      |
| CI/CD                  | ✅ Every batch → check → QA → deploy → IndexNow; all runs green                                                                                    |
| SEO                    | ✅ Sitemaps submitted to Google Search Console; IndexNow key live; site indexable                                                                  |
| Email                  | ✅ `halo@earthviral.com` (Google Workspace secondary domain, routed to `halo@kukirim.com`)                                                         |

---

## 2. What was built

### Tech stack

| Layer          | Choice                                                                              |
| -------------- | ----------------------------------------------------------------------------------- |
| Site           | Astro 7 (static output), React 19 islands, Tailwind CSS v4, TypeScript (strict)     |
| Map            | MapLibre GL JS 6 + Natural Earth TopoJSON (`world-atlas`)                           |
| Data           | JSON files validated by Astro content collections (Zod)                             |
| Batch pipeline | Plain Node 22 TypeScript (type stripping, no build step)                            |
| AI summaries   | Gemini (`gemini-3.1-flash-lite`, default) or OpenAI (`gpt-5-mini`), non-AI fallback |
| Search         | Pagefind (static index, runs in the browser)                                        |
| Social images  | satori + resvg at build time                                                        |
| Hosting        | Cloudflare Pages (direct upload via Wrangler from CI)                               |
| Scheduling     | Cloudflare Worker cron → GitHub Actions `workflow_dispatch`                         |

Fonts (Space Grotesk, Plus Jakarta Sans, JetBrains Mono) are all SIL OFL-1.1 and self-hosted, in line with Sociolla's font licensing policy.

### Phase 1: foundation and world map

- The "Orbital Intelligence" dark theme, plus a header, telemetry bar and footer.
- A 3D globe / 2D map with tiered country beacons (Active, High, Viral Surge), hover tooltips and fly-to.
- A static SVG globe drawn at build time, so the first paint is instant.
- Respects `prefers-reduced-motion`, and pauses animation when the map is off-screen.
- A sample-data generator (`npm run seed`). Sample builds are marked `noindex` and show a "Sample data" badge.

### Phase 2: country drawer and static SEO pages

- **Country Intelligence Drawer:** a side panel on desktop and a bottom sheet on mobile, loading the country's data on demand.
- **Static pages:** stories `/news/[cc]/[slug]/`, countries, country + category, categories, regions and topics.
- **Internal linking:** breadcrumbs, "Trending now in …", "More viral in …", topic tags, a source timeline, and links on country and topic names inside summaries.

### Phase 3: AI batch pipeline (`npm run update:viral`)

- **Sources:** 31 RSS feeds (Indonesian, global wires and national outlets), Google Trends geo feeds, and optional GDELT (usually rate-limited).
- **Country attribution** across 41 tracked countries, in English and Bahasa Indonesia.
- **Story grouping:** articles are grouped by TF-IDF headline similarity, with a second pass that merges fragments of the same event. Tuned on a real batch of 1,083 articles.
- **Viral Activity Score (0–100):** `0.55 × coverage + 0.45 × velocity + 0.15 × search bonus`.
- **AI summaries:** structured JSON, validated with Zod. Over-long fields are repaired, failures are categorised, and a failed call falls back to a non-AI summary.
- **Stable URLs:** new coverage joins existing stories, so a story's URL never changes.
- **Retention:** stories leave the live map after 48 hours without new coverage and are removed after 30 days.

### Phase 4: technical SEO and launch polish

- **Structured data:** JSON-LD for `WebSite`, `Organization`, `ItemList`, `CollectionPage`, `BreadcrumbList` and `NewsArticle`.
- **Social images:** a 1200×630 card per story, plus a raster logo.
- **Crawl files:** sitemaps (core, Google News for the last 48 h, monthly stories), `robots.txt`, RSS and `ads.txt`.
- **Search:** Pagefind with a ⌘K dialog and a `/search/` page.
- **Ads:** CLS-safe ad slots, off until AdSense is configured.
- **Pages:** About & Methodology (driven by the real scoring constants), Privacy, Terms and Contact.
- **IndexNow:** `npm run indexnow` pings after each deploy.
- **Performance:** Lighthouse (mobile) scored 98–100 Performance, 100 Accessibility, 100 Best Practices and 100 SEO, with CLS 0.

### Later additions

- **Per-country cap:** each country keeps its **top 10 stories** (configurable). Removed and expired stories get a **301 to their country page** through a generated `public/_redirects`, kept for 90 days.
- **AI reliability:**
  - failure reasons are categorised (`rate-limit`, `schema`, `timeout`, …) and recorded in `batch-meta.json`
  - AI calls run 2 at a time
  - `retryDelay` / `Retry-After` hints are honoured
- **Re-summarising:** `--resummarize-fallback` re-summarises stories that still have non-AI text. It's also available as a checkbox on the manual workflow form.
- **Staleness watchdog:** an hourly workflow that opens or closes a `stale-data` GitHub issue when data is more than 9 h old. The site shows a **"Data delayed"** badge in the same situation.
- **Feeds:** Tempo's blocked section feed was replaced with its main feed, and Capital FM and KBC were added for Kenya.

---

## 3. Automation and CI/CD

```text
Cloudflare Worker (cron)
 ├─ 17 2-23/3 * * * ─► GitHub: Update viral batch ─► commits data to main
 │                                                     │
 │                                  CI (workflow_run) ◄┘
 │                                   check → QA → deploy (Wrangler) → IndexNow ping
 └─ 41 * * * *  ────► GitHub: Staleness watchdog ─► opens/closes "stale-data" issue
```

| Workflow                 | Trigger                                                      | Does                                                                                                            |
| ------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `update-viral-batch.yml` | Worker dispatch (xx:17), GitHub schedule as a backup, manual | Unit tests → batch → build check → commit data. A scheduled run skips itself if a batch ran within 2 h          |
| `ci.yml`                 | push to `main`, pull request, after each batch               | Format, lint, type check, build, 3,000+ unit and `dist/` tests → Playwright/axe QA → Wrangler deploy → IndexNow |
| `staleness-watchdog.yml` | Worker dispatch (xx:41), GitHub schedule as a backup, manual | Checks data age on the live site and in the repository; manages the `stale-data` issue                          |
| `workers/scheduler`      | Cloudflare cron triggers                                     | Calls GitHub's "run workflow" API with a fine-grained token                                                     |

**Why a Worker:** GitHub's own cron never fired for this repository. That stayed true after a cron change and after disabling and re-enabling the workflows. Since the Worker went live (7 Nov, 12:41 UTC), every slot has run. GitHub's scheduler has since started firing irregularly; its runs act as a backup, and the 2-hour guard keeps them from producing duplicate batches.

---

## 4. Infrastructure

| Item           | Setting                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Registrar      | Hostinger (nameservers moved to Cloudflare: `dilbert` / `lana.ns.cloudflare.com`)                                |
| DNS            | Cloudflare. Web: CNAME `@` and `www` → `earthviral-web.pages.dev` (proxied)                                      |
| Redirects      | `www.earthviral.com` → `earthviral.com` (Redirect Rule, 301), `http` → `https`, `*.pages.dev` → `earthviral.com` |
| Mail           | Google Workspace (secondary domain of `kukirim.com`): MX `smtp.google.com`, SPF, DKIM, DMARC (`p=none`)          |
| Pages project  | `earthviral-web` (Direct Upload, deployed by CI)                                                                 |
| Worker         | `earthviral-scheduler` (cron triggers only, secret `GITHUB_TOKEN`)                                               |
| Search Console | Domain property `earthviral.com`; `sitemap-index.xml` submitted                                                  |

### Configuration reference

| Name                                            | Kind                       | Purpose                                                               |
| ----------------------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| `GEMINI_API_KEY` / `OPENAI_API_KEY`             | GitHub secret              | AI summaries (Gemini is used first if both are set)                   |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub secret              | CI deploy to Pages                                                    |
| `INDEXNOW_KEY`                                  | GitHub secret              | Publishes `/<key>.txt` and authenticates IndexNow pings               |
| `PUBLIC_CONTACT_EMAIL`                          | GitHub variable            | `halo@earthviral.com` on the Contact and legal pages                  |
| `GEMINI_MODEL`, `OPENAI_MODEL`                  | GitHub variable (optional) | Override the default models                                           |
| `MAX_STORIES_PER_COUNTRY`                       | GitHub variable (optional) | Stories kept per country (default 10; 0 = no cap)                     |
| `AI_CONCURRENCY`                                | GitHub variable (optional) | Parallel AI calls (default 2)                                         |
| `SITE_URL`, `STALE_AFTER_HOURS`                 | GitHub variable (optional) | Watchdog target and threshold (default 9 h)                           |
| `PUBLIC_ADSENSE_*`                              | GitHub variable (optional) | Turns on ad slots and `ads.txt` (not set yet)                         |
| `GITHUB_TOKEN`                                  | Cloudflare Worker secret   | Fine-grained token, this repository only, **Actions: Read and write** |

---

## 5. Pull requests

| PR  | Title                                                            | Why                                                                                        |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| #1  | EarthViral v1: static site, AI batch pipeline, SEO and CI/CD     | First release: phases 1–4 plus the later additions (cap, failure reasons, watchdog, feeds) |
| #2  | Treat empty `GEMINI_MODEL` / `OPENAI_MODEL` as unset             | GitHub passes unset variables as `""`, so every Gemini call returned 404                   |
| #3  | Repair over-long fields in AI replies instead of discarding them | One over-long topic tag caused a whole summary to be rejected                              |
| #4  | Move cron schedules off the top of the hour                      | An attempt to re-register GitHub's schedules (didn't work on its own)                      |
| #5  | Cloudflare Worker scheduler for the batch and watchdog           | Reliable timer that doesn't depend on GitHub's cron                                        |

---

## 6. Problems found and fixed (lessons)

| Problem                                       | Cause                                                 | Fix                                                               |
| --------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| Map collapsed to 300 px                       | `maplibre-gl.css` sets `position: relative`           | Inline positioning on the map container                           |
| MapLibre worker failed to load                | v6 resolves its worker relative to the bundle         | Emit the worker as an asset and call `setWorkerUrl`               |
| Line wrapped around the globe                 | Fiji ring crosses the antimeridian                    | Unwrap longitudes per ring                                        |
| Homepage mobile Performance 55                | MapLibre (1.1 MB) blocked the main thread             | Touch devices load the map on the first tap; fonts preloaded      |
| OG cards clipped                              | satori lays out the root as content-box               | Size the frame content box to the canvas minus padding            |
| OG build took 90 s                            | resvg scanned system fonts on every card              | `loadSystemFonts: false` (about 20 ms per card)                   |
| Scores never reached "Viral Surge"            | A fixed 20% search weight was usually 0               | Search became a bonus on top of coverage and velocity             |
| Clusters fragmented (903 from 1,083 articles) | Threshold too strict for short headlines              | Join threshold 0.2 plus a merge pass at 0.35, tuned on real data  |
| AI failure reasons lost                       | Only the first line of the Zod error (`[`) was logged | Categorised failures recorded in `batch-meta.json`                |
| CI QA "CLS 0.001"                             | Font swap and a post-paint script on CI runners       | Deterministic layout check; telemetry script inlined before paint |
| `earthviral.com` showed the parking page      | Imported Hostinger `A` record; stale local DNS cache  | Replace with Pages CNAMEs; verify via Cloudflare's nameservers    |
| GitHub cron never fired                       | Unexplained platform behaviour on a new repository    | Cloudflare Worker scheduler plus a 2-hour duplicate guard         |

---

## 7. Open items and recommendations

- [ ] **Legal review:** the Privacy and Terms drafts don't name a governing law.
- [ ] **AdSense:** needs publisher and slot IDs, plus a Google-certified consent banner for EEA and UK visitors.
- [ ] **Token expiry:** note the expiry date of the Worker's fine-grained GitHub token (GitHub emails a reminder). The scheduler stops when it expires, and the watchdog stops with it.
- [ ] **Independent monitoring (optional):** a free uptime monitor on `https://earthviral.com/`, so an outage is noticed even if the Worker stops.
- [ ] **Bing Webmaster Tools (optional):** import from Search Console, and check IndexNow submissions there.
- [ ] **Thin topic pages:** if Search Console reports many "Crawled – currently not indexed" topic pages, make topics with fewer than 2 stories `noindex` and leave them out of the sitemap.
- [ ] **Dependency:** a moderate `npm audit` finding in `fflate`, used only at build time by satori.
- [ ] **Bilingual summaries:** summaries are English only; Indonesian would need schema fields.

---

## 8. Runbook

| Task                                        | How                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Refresh the news now                        | GitHub → Actions → **Update viral batch** → Run workflow (provider `auto`)                          |
| Fix stories with non-AI text                | Same, with **Re-summarise stories that still have non-AI text** ticked                              |
| Test the pipeline without changing the site | Same, with **Dry run** ticked (still uses AI calls)                                                 |
| Change stories per country                  | Repository variable `MAX_STORIES_PER_COUNTRY`                                                       |
| Check the scheduler                         | Cloudflare → Workers & Pages → `earthviral-scheduler` → Logs (`Dispatched … on main`)               |
| Data looks stale                            | Open the `stale-data` issue's checklist: batch runs, CI deploy, AI quota, Worker logs, token expiry |
| Work locally                                | `npm install` → `npm run update:viral` (or `npm run seed`) → `npm run build && npm run preview`     |
| Full local check                            | `npm run check` (format, lint, type check, build, tests) and `npm run qa` (browser QA)              |
| Ship a change                               | Commit on `uat` → push → pull request to `main` → CI green → merge (deploys automatically)          |
