# PLAN_EARTH_VIRAL.md — EarthViral.com (Static-First SEO & AI Batch Architecture)

**Document Version:** 2.0.0 (Static-First Edition)  
**Target Filename:** `PLAN_EARTH_VIRAL.md`  
**Status:** Architecture & Product Specification (Ready for Implementation)  
**Deployment Model:** 100% Static Pre-Rendered Site (`SSG`) on Cloudflare Pages CDN  
**Data Refresh Cycle:** Every 3 Hours (Triggered manually via CLI or GitHub Actions `workflow_dispatch` / Cron)  
**Runtime Database Dependency:** **NONE** (Zero runtime DB, zero cold starts, 100% static JSON + pre-rendered HTML)  
**Primary Launch Market:** Indonesia (`ID`), scaling globally

---

## 1. Product Overview

### 1.1 Vision Statement

**EarthViral.com** is a global viral news intelligence and trend discovery platform. It combines an interactive 3D/2D dark-mode world map with deeply indexed, lightning-fast static news intelligence pages. Every 3 hours, an AI-driven batch pipeline ingests global and Indonesian news signals, clusters viral topics, calculates Viral Activity Scores (VAS), generates structured static JSON data files, and compiles thousands of SEO-optimized static HTML pages with rich internal linking.

### 1.2 Why Static-First + 3-Hour AI Batch Architecture Wins

- **Maximum SEO & Crawl Budget Efficiency:** Googlebot and Bingbot receive pre-rendered, static HTML directly from Cloudflare's edge in `< 20ms` Time to First Byte (TTFB).
- **Zero Runtime Failures or Database Costs:** No SQLite/Postgres queries at request time, no API rate limits when traffic spikes from a viral story, and `$0/month` hosting on Cloudflare Pages.
- **High-Precision AI Curation:** Running AI ingestion as a scheduled/manual 3-hour batch job allows deeper LLM reasoning (clustering, entity extraction, cross-linking related stories, and bilingual context summaries) without hurting user page-load times.

---

## 2. Product Requirements (PRD)

### 2.1 Functional Requirements

| ID        | Feature Area                   | Requirement Description                                                                                                                                                                                                                         | Priority |
| :-------- | :----------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------- |
| **FR-01** | **Interactive World Map**      | Render an interactive map (3D WebGL Globe with 2D Mercator toggle) hydrated from a static precomputed `map-pulse.json` file.                                                                                                                    | P0 (MVP) |
| **FR-02** | **Country Viral Indicators**   | Display tiered visual markers (pulsing nodes, signal rings, heatmap glow) scaled by each country's Viral Activity Score (0–100).                                                                                                                | P0 (MVP) |
| **FR-03** | **Map Hover Tooltip**          | On desktop hover (or mobile single-tap), show Country Flag, Name, Viral Score badge, Trending Intensity tier, and #1 Top Topic.                                                                                                                 | P0 (MVP) |
| **FR-04** | **Country News Drawer**        | Clicking a country highlights it and loads its static `/data/countries/[code].json` payload into a smooth slide-over drawer.                                                                                                                    | P0 (MVP) |
| **FR-05** | **Global Telemetry Bar**       | Display snapshot metrics from the latest 3-hour batch: Active Trending Countries, Total Viral Topics, Global Index, and Snapshot Timestamp.                                                                                                     | P0 (MVP) |
| **FR-06** | **9 Core News Categories**     | Support filtering and dedicated static SEO pages across: _Politics & Government, Crime & Law, Economy & Business, Technology & AI, Sports, Entertainment & Celebrity, Social Issues, Disasters & World Events, Lifestyle & Culture_.            | P0 (MVP) |
| **FR-07** | **Static Story & Topic Pages** | Every viral topic cluster gets its own pre-rendered static HTML page (`/news/[country]/[slug]`) with AI synthesis, timeline, related story links, and original publisher attribution.                                                           | P0 (MVP) |
| **FR-08** | **3-Hour AI Generator CLI**    | A standalone Node.js/TypeScript CLI script (`npm run generate:viral`) triggered manually (or via GitHub Action) every 3 hours to fetch feeds, run AI clustering/summarization, write static JSON files, and rebuild the static site + sitemaps. | P0 (MVP) |
| **FR-09** | **Static Client Search**       | Instant client-side search (`Cmd/Ctrl + K`) powered by a pre-built static search index (`Pagefind` or ` Fuse.js` over `/data/search-index.json`).                                                                                               | P1 (MVP) |

### 2.2 Non-Functional Requirements (Core Web Vitals Targets)

- **Time to First Byte (TTFB):** `< 35ms` globally via Cloudflare Pages static CDN.
- **Largest Contentful Paint (LCP):** `< 1.0s` on Desktop, `< 1.4s` on Mobile 4G (all text and hero shell are pre-rendered in static HTML; WebGL canvas hydrates asynchronously).
- **Cumulative Layout Shift (CLS):** `0.00` (strict aspect-ratio reservations for map containers, badges, and ad slots).
- **Interaction to Next Paint (INP):** `< 80ms` (off-main-thread WebGL rendering and zero heavy runtime hydration on article pages).

---

## 3. User Experience (UX) Flows

### 3.1 Flow 1: Organic Search Entry (Primary SEO Traffic Driver)

1. **Search Discovery:** A user searches Google for _"Kenapa Timnas Indonesia viral hari ini"_ or _"Japan AI regulation viral news"_.
2. **Instant Static Landing:** User lands on `/news/id/timnas-indonesia-world-cup-qualifier-surge/` (pre-rendered static HTML).
3. **Rich Context Consumption:** Page loads instantly (`< 0.5s`). User reads the Executive AI Summary, Why It's Viral breakdown, Verified Source Links (Kompas, Detik, Antara), and sees a mini interactive locator map showing Indonesia's `94/100` viral pulse.
4. **Internal Link Retention:** User clicks a **"Related Viral Topic in Indonesia"** card or clicks **"Explore Full Live World Map"** to jump to the homepage spatial dashboard.

### 3.2 Flow 2: Homepage Spatial Map Exploration

1. **Entry:** User lands on `/`. The pre-rendered HTML shell displays the Global Telemetry Bar (`Snapshot: Nov 6, 2026 • 00:00 WIB | Next Update: 03:00 WIB`) and hydrates the interactive 3D/2D world map from `/data/map-pulse.json` (`~12KB` gzipped).
2. **Country Selection:** Clicking Indonesia smoothly rotates the globe, highlights the border in electric cyan (`#00F0FF`), and fetches `/data/countries/id.json` (`< 20KB`) to populate the slide-over **Country Intelligence Drawer**.
3. **Deep Dive:** User can filter the drawer by the 9 categories, click out to original sources, or click **"Full Country Report ↗"** to visit the static `/country/indonesia/` hub page.

---

## 4. Homepage Wireframe & Layout Architecture

### 4.1 Desktop Viewport (`>= 1024px`)

```text
+--------------------------------------------------------------------------------------------------+
| [🌐 EarthViral]   Explore Map   Trending   Categories ▾    [🔍 Search (⌘K)]  [🇮🇩 Indonesia ▾]   | <- Fixed Glass Header
+--------------------------------------------------------------------------------------------------+
| ⚡ SNAPSHOT: 48 Active Countries | 312 Viral Topics | Global Index: 78/100 | Updated 28m ago (3h)| <- Static Batch Telemetry
+--------------------------------------------------------------------------------------------------+
|                                                                |                                 |
|   +------------------------+                                   |  🇮🇩 INDONESIA          [✕ Close]|
|   | VIEW MODE              |                                   |  Viral Activity Score: 94/100   |
|   | [🌍 3D Globe | 🗺️ 2D]  |         INTERACTIVE               |  [Full Indonesia SEO Page ↗]    |
|   +------------------------+          WORLD MAP                |  -----------------------------  |
|                                      CENTERPIECE               |  TOP VIRAL CLUSTERS             |
|                                   (80vh Height Min)            |  [#1 Timnas (96)] [#2 IKN (89)] |
|          ( * )  <-- Pulsing                                    |  -----------------------------  |
|         Country     Beacons &                                  |  [All][Politics][Tech][Sports]  |
|          Nodes      Arcs                                       |  +---------------------------+  |
|                                  +--------------------+        |  | [Politics]        🔥 96   |  |
|                                  | 🇮🇩 Indonesia (94)  |        |  | Headline (Links to SEO pg)|  |
|                                  | Top: Timnas Garuda |        |  | • AI Context bullet 1     |  |
|                                  +--------------------+        |  | • AI Context bullet 2     |  |
|                                                                |  | Source: Kompas (Link) [↗] |  |
|   +--------------------------------------------------------+   |  +---------------------------+  |
|   | INTENSITY LEGEND:  ⚪ Low (1-39) 🔵 Med 🟣 High ⚡ Surge|   |                                 |
+--------------------------------------------------------------------------------------------------+
|  [STATIC HTML BELOW THE FOLD — FULLY PRE-RENDERED FOR SEARCH ENGINE CRAWLERS]                    |
|                                                                                                  |
|  🔥 GLOBAL TRENDING TOPICS (Pre-rendered HTML Bento Grid with <a href="/news/..."> links)        |
|  📰 LATEST VIRAL NEWS (Pre-rendered HTML Cards + Client-side instant category/country filter)    |
|  🌏 TRENDING BY REGION (Pre-rendered HTML Hub Links for Asia, Europe, N. America, etc.)          |
|  FOOTER: Sitemap HTML Links | Top Countries | All 9 Categories | About | Methodology | Privacy   |
+--------------------------------------------------------------------------------------------------+
```

---

## 5. Interactive Map Behavior & Animation Specifications

### 5.1 Dual-Mode Rendering (`MapLibre GL JS` Globe + 2D Mercator)

- **SSR / Static First Paint:** The homepage includes a lightweight inline SVG dark world map silhouette in the static HTML so Largest Contentful Paint (LCP) fires immediately before JavaScript finishes downloading.
- **Client Hydration:** `MapLibre GL JS` mounts asynchronously in an `IntersectionObserver` / `requestIdleCallback` hook and loads `/geo/countries-110m.topo.json` + `/data/map-pulse.json`.

### 5.2 Tiered Country Viral Indicators

- **Tier 0 (`0–24` Quiet):** Matte navy fill (`#0B101E`), subtle border (`#1E293B`), no pulsing marker.
- **Tier 1 (`25–59` Active):** Solid cyan centroid dot (`6px`, `#06B6D4`) with slow opacity breath (`4s`).
- **Tier 2 (`60–84` High):** Electric blue glowing core (`8px`, `#00F0FF`) + single expanding sonar ring (`2.8s`) + compact score badge.
- **Tier 3 (`85–100` Viral Surge):** Dual-core purple/cyan beacon (`12px`, `#A855F7` / `#00F0FF`) + radial polygon glow + dual sonar wave (`1.8s`) + country flag/score pill (`🇮🇩 94`).

### 5.3 Performance & Reduced Motion

- Strictly honors `@media (prefers-reduced-motion: reduce)` by disabling globe auto-rotation, sonar pulses, and animated camera flights.
- Pauses WebGL `requestAnimationFrame` loop automatically when the user scrolls past the map hero or switches browser tabs (`document.hidden`).

---

## 6. UI/UX Design System ("Orbital Intelligence" Dark Theme)

- **Backgrounds:** Void Black-Navy (`#050811`), Ocean Deep (`#070D19`), Land Base (`#0F172A`), Glassmorphic Panels (`rgba(15, 23, 42, 0.78)` with `backdrop-filter: blur(16px)`).
- **Accents:** Electric Cyan (`#00F0FF`), Signal Blue (`#3B82F6`), Viral Surge Purple (`#8B5CF6`), Verified Emerald (`#10B981`).
- **Typography:**
  - Headings: `'Space Grotesk'` (`600`, `700`)
  - Body & Summaries: `'Plus Jakarta Sans'` (`400`, `500`, `600`) — optimized for both English and Bahasa Indonesia readability.
  - Scores & Telemetry: `'JetBrains Mono'` (`tabular-nums`).

---

## 7. Static-First Technical Architecture

### 7.1 Technology Stack Evaluation

| Layer                                  | Recommended Choice                                                                                                   | Why This Fits Static + 3-Hour Manual Trigger Best                                                                                                                                                                                                           |
| :------------------------------------- | :------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Static Site Framework**              | **Astro 7 (`output: 'static'` SSG + React Islands via `@astrojs/react`)**                                            | Generates 100% pure static HTML, CSS, and JS files into `/dist`. Zero server runtime required. Every country, category, and story page is pre-rendered HTML for Googlebot, and pages ship zero JS by default — only the map, drawer, and search modal hydrate as islands (`client:visible` / `client:idle`). Generated JSON is loaded through Content Layer collections (`src/content.config.ts`) for type-safe, schema-validated builds. |
| **Static Data Storage**                | **Git-Committed / Artifact JSON Files (`/src/data/generated/*.json` & `/public/data/*.json`)**                       | Eliminates database hosting and runtime latency. A 30-day rolling window of curated viral clusters fits comfortably in structured JSON files (`< 15MB` total), while static client endpoints in `/public/data/` are served via Cloudflare CDN.              |
| **3-Hour AI Pipeline Runner**          | **TypeScript CLI Script (`tsx scripts/generate-viral-batch.ts`)**                                                    | Can be triggered manually from your terminal (`npm run update:viral`) or via a 1-click **GitHub Actions `workflow_dispatch`** button (or `0 */3 * * *` cron schedule) that commits the new static JSON files and triggers a Cloudflare Pages static deploy. |
| **AI Discovery, Clustering & Summary** | **Gemini 2.5 Flash API** (with Google Search Grounding optional) or **OpenAI `gpt-4o-mini` / Cloudflare Workers AI** | Since AI runs only once every 3 hours during the batch script (not per user visit), a single batch run summarizing ~150 global clusters costs `< $0.03` per run (`~$0.24/day`) while producing high-quality, structured SEO content.                        |
| **Map Rendering**                      | **MapLibre GL JS v4+** + **Natural Earth TopoJSON**                                                                  | 100% open-source, loads static TopoJSON + static `/data/map-pulse.json` directly from the CDN. Zero tile API bills.                                                                                                                                         |
| **Static Search Engine**               | **Pagefind** (runs post-build on static HTML)                                                                        | Automatically indexes all generated static HTML pages at build time into tiny static WASM/JSON chunks so `Cmd+K` search works offline/statically with zero backend.                                                                                         |
| **Hosting & CDN**                      | **Cloudflare Pages (Static Assets Mode)**                                                                            | Unlimited free bandwidth and requests for static files, automatic Brotli compression, HTTP/3, and instant global cache invalidation on every 3-hour build.                                                                                                  |

### 7.2 Static Batch & Deployment Pipeline Diagram

```text
+---------------------------------------------------------------------------------------+
|              MANUAL OR 3-HOUR SCHEDULED TRIGGER (CLI / GitHub Action)                 |
|                        `$ npm run generate:viral`                                     |
+---------------------------------------------------------------------------------------+
                                          |
                                          v
+---------------------------------------------------------------------------------------+
|  STEP 1: MULTI-SOURCE SIGNAL COLLECTION (Node.js Batch Script)                        |
|  • Fetches curated RSS feeds (Kompas, Detik, Antara, Tempo, Reuters, BBC, NHK, etc.)  |
|  • Fetches Geo-specific Google Trends Public RSS (?geo=ID, US, JP, GB, SG, MY, AU...) |
|  • Fetches GDELT 2.0 Top Global Event Clusters                                        |
+---------------------------------------------------------------------------------------+
                                          |
                                          v
+---------------------------------------------------------------------------------------+
|  STEP 2: AI INTELLIGENCE, SCORING & INTERNAL LINKING ENGINE                           |
|  • Deduplicates URLs & clusters articles covering the same event                      |
|  • Computes Viral Activity Score (VAS 0-100) from Coverage + Velocity + Trend Signals |
|  • Prompts LLM (Structured JSON Output) to generate for each cluster:                 |
|      1. SEO Slug & Click-Worthy Factual Headline                                      |
|      2. Executive AI Summary (2-3 sentences) + "Why It's Viral" context               |
|      3. Category classification (1 of 9 canonical categories) & Entity Tags           |
|  • Computes semantic similarity between clusters to inject `relatedClusterSlugs[]`    |
+---------------------------------------------------------------------------------------+
                                          |
                                          v
+---------------------------------------------------------------------------------------+
|  STEP 3: STATIC FILE GENERATION (Writes to Repository / Build Directory)              |
|  • Writes `/public/data/map-pulse.json` (Lightweight 12KB payload for homepage map)   |
|  • Writes `/public/data/countries/[code].json` (Per-country drawer payload)           |
|  • Writes `/src/data/clusters/[yyyy-mm]/[slug].json` (Full story data + internal links)|
|  • Updates `/src/data/index-manifest.json` (Master index for static route generation) |
+---------------------------------------------------------------------------------------+
                                          |
                                          v
+---------------------------------------------------------------------------------------+
|  STEP 4: STATIC SITE BUILD (`npm run build` → `astro build`)                          |
|  • Pre-renders static HTML for `/`, `/country/[slug]/`, `/category/[slug]/`,          |
|    `/news/[country]/[slug]/`, and `/topic/[tag]/`                                     |
|  • Generates `/sitemap-index.xml`, `/sitemap-news.xml` (<news:news>), `/rss.xml`      |
|  • Runs `npx pagefind --site dist` to build static search index                       |
+---------------------------------------------------------------------------------------+
                                          |
                                          v
+---------------------------------------------------------------------------------------+
|  STEP 5: CLOUDFLARE PAGES CDN DEPLOYMENT                                              |
|  • 100% Static HTML + JSON served from 300+ Edge PoPs (0ms DB latency)                |
+---------------------------------------------------------------------------------------+
```

---

## 8. Static Data Schemas & File Organization

Instead of a runtime database, the batch generator outputs deterministic, version-controlled JSON files.

### 8.1 Static Data Directory Layout

```text
public/
└── data/
    ├── map-pulse.json                 # Loaded by the interactive world map (12KB gzipped)
    ├── global-trending.json           # Top 30 global clusters for client filter tabs
    └── countries/
        ├── id.json                    # Loaded on-demand when user clicks Indonesia on map
        ├── us.json                    # Loaded on-demand when user clicks USA
        ├── jp.json
        └── ...                        # One lightweight JSON per active country

src/
└── data/
    └── generated/
        ├── batch-meta.json            # Batch ID, generatedAt, nextUpdateAt, global totals
        ├── countries-master.json      # Used at build time to pre-render /country/[slug]/
        ├── categories-master.json     # Used at build time to pre-render /category/[slug]/
        └── clusters/                  # Used at build time to pre-render /news/[country]/[slug]/
            ├── id/
            │   └── 2026-11-06-timnas-indonesia-qualifier.json
            ├── us/
            │   └── 2026-11-06-ai-chip-export-policy.json
            └── ...
```

### 8.2 Schema: `src/data/generated/clusters/[country]/[slug].json`

Every viral story cluster generated during the 3-hour batch conforms to this strict TypeScript interface, designed specifically to power **rich SEO pages and internal linking**:

```typescript
export interface ViralClusterStaticRecord {
  id: string; // Deterministic ID (e.g., "id-20261106-timnas-garuda")
  slug: string; // SEO slug: "timnas-indonesia-world-cup-qualifier-surge"
  canonicalPath: string; // "/news/id/timnas-indonesia-world-cup-qualifier-surge/"
  countryCode: string; // "ID"
  countryName: string; // "Indonesia"
  countrySlug: string; // "indonesia"
  region:
    | "Asia"
    | "Europe"
    | "North America"
    | "South America"
    | "Africa"
    | "Oceania";
  categorySlug:
    | "politics-government"
    | "crime-law"
    | "economy-business"
    | "technology-ai"
    | "sports"
    | "entertainment-celebrity"
    | "social-issues"
    | "disasters-world-events"
    | "lifestyle-culture";
  categoryName: string; // "Sports"

  // Content & AI Synthesis
  headline: string; // H1 Headline (55-70 chars)
  seoTitle: string; // <title> tag (under 60 chars)
  metaDescription: string; // <meta name="description"> (140-158 chars)
  aiSummaryBullets: string[]; // 3 concise executive summary bullet points
  aiContextParagraph: string; // 120-180 word synthesis explaining background & why it's trending
  whyItIsViral: string; // 1-2 sentence explanation of the trend velocity trigger

  // Honest Viral Telemetry
  viralScore: number; // 0 - 100 (Composite VAS)
  intensityTier: "quiet" | "active" | "high" | "surge";
  signalBreakdown: {
    verifiedPublisherCount: number; // e.g., 8 independent news outlets
    coverageVelocityScore: number; // 0 - 100
    publicSearchSignalScore: number; // 0 - 100 (from Google Trends RSS match)
    confidenceLabel: "Verified Multi-Source" | "Emerging Coverage";
  };

  // Timestamps
  firstDetectedAt: string; // ISO-8601
  lastUpdatedBatchAt: string; // ISO-8601 (The 3-hour batch timestamp)

  // Original Publisher Attribution (Fair-Use & Outbound Links)
  sources: Array<{
    publisherName: string; // "Kompas"
    publisherDomain: string; // "kompas.com"
    articleTitle: string; // Original headline
    articleUrl: string; // Direct outbound link
    publishedAt: string; // ISO-8601
  }>;

  // Automated Internal Linking Graph (Computed during batch build)
  entityTags: Array<{
    name: string; // "Timnas Indonesia"
    slug: string; // "timnas-indonesia"
  }>;
  relatedInCountrySlugs: string[]; // 3 related viral clusters in the same country
  relatedInCategorySlugs: string[]; // 3 related viral clusters in the same category globally
}
```

---

## 9. Comprehensive SEO Architecture (Maximizing Organic Traffic)

### 9.1 SEO-Friendly URL Hierarchy (Trailing Slash Enforced for Static Hosting)

Every URL is clean, human-readable, keyword-rich, and maps 1:1 to a pre-rendered `index.html` file on disk:

| Page Type              | URL Pattern                                | Example URL                                                                  | Target Search Intent                                         |
| :--------------------- | :----------------------------------------- | :--------------------------------------------------------------------------- | :----------------------------------------------------------- |
| **Homepage**           | `/`                                        | `https://earthviral.com/`                                                    | Global viral news map, trending world news today             |
| **Country Hub**        | `/country/[country-slug]/`                 | `https://earthviral.com/country/indonesia/`                                  | "Viral news in Indonesia today", "Trending topics Indonesia" |
| **Category Hub**       | `/category/[category-slug]/`               | `https://earthviral.com/category/technology-ai/`                             | "Viral AI and technology news worldwide"                     |
| **Country + Category** | `/country/[country-slug]/[category-slug]/` | `https://earthviral.com/country/indonesia/politics-government/`              | "Berita politik viral Indonesia hari ini"                    |
| **Region Hub**         | `/region/[region-slug]/`                   | `https://earthviral.com/region/asia/`                                        | "Trending viral news in Asia"                                |
| **Viral Story Page**   | `/news/[country-code]/[cluster-slug]/`     | `https://earthviral.com/news/id/timnas-indonesia-world-cup-qualifier-surge/` | Long-tail breaking & trending topic queries                  |
| **Entity / Tag Hub**   | `/topic/[tag-slug]/`                       | `https://earthviral.com/topic/artificial-intelligence/`                      | Evergreen topic cluster aggregation                          |

### 9.2 Pre-Rendered HTML & Crawlability Guarantees

- **Zero Client-Only Content for SEO Text:** Even on the Homepage (`/`), all sections below the interactive map (**Global Trending Topics**, **Latest Viral News**, **Trending by Region**) are rendered as standard HTML `<article>` and `<a href="...">` tags during `npm run build`.
- **No Orphan Pages:** Every generated `/news/[country]/[slug]/` page is reachable within **3 clicks** from the homepage (`Homepage -> Country Hub -> Story Page` or `Homepage -> Category Hub -> Story Page`).
- **Pagination & Archive Strategy:** When older clusters cool down after 48 hours, they remain permanently live at their `/news/[country]/[slug]/` URL (preserving backlinks and long-tail organic rankings) and are indexed via monthly archive sitemaps, while dropping off the homepage live map.

### 9.3 Metadata, Canonical URLs & Schema.org (`JSON-LD`) Specifications

Every static page automatically injects complete `<head>` metadata at build time:

1. **Standard & Open Graph Tags:**

   - `<title>` dynamically formatted: `[Headline] — Viral in [Country] (Score: [VAS]/100) | EarthViral`
   - `<link rel="canonical" href="https://earthviral.com/..." />` (strictly self-referencing canonicals with consistent trailing slash).
   - Open Graph (`og:title`, `og:description`, `og:type="article"`, `article:published_time`, `article:modified_time`, `article:section`) + static build-time generated Open Graph PNG card (`/og/[cluster-id].png`).

2. **Schema.org Structured Data (`JSON-LD` Graph):**
   - **On Homepage (`/`):** `WebSite` + `Organization` + `ItemList` (Top 10 Global Viral Topics).
   - **On Country & Category Hubs:** `CollectionPage` + `BreadcrumbList` + `ItemList`.
   - **On Viral Story Pages (`/news/[country]/[slug]/`):**
     ```json
     {
       "@context": "[https://schema.org](https://schema.org)",
       "@graph": [
         {
           "@type": "NewsArticle",
           "headline": "...",
           "description": "...",
           "datePublished": "2026-11-05T18:00:00Z",
           "dateModified": "2026-11-06T00:00:00Z",
           "author": {
             "@type": "Organization",
             "name": "EarthViral Intelligence Desk",
             "url": "[https://earthviral.com/about/](https://earthviral.com/about/)"
           },
           "publisher": {
             "@type": "Organization",
             "name": "EarthViral",
             "logo": {
               "@type": "ImageObject",
               "url": "[https://earthviral.com/logo.png](https://earthviral.com/logo.png)"
             }
           },
           "contentLocation": {
             "@type": "Country",
             "name": "Indonesia"
           },
           "isBasedOn": [
             "[https://kompas.com/](https://kompas.com/)...",
             "[https://detik.com/](https://detik.com/)..."
           ],
           "mainEntityOfPage": "[https://earthviral.com/news/id/](https://earthviral.com/news/id/)..."
         },
         {
           "@type": "BreadcrumbList",
           "itemListElement": [
             {
               "@type": "ListItem",
               "position": 1,
               "name": "Home",
               "item": "[https://earthviral.com/](https://earthviral.com/)"
             },
             {
               "@type": "ListItem",
               "position": 2,
               "name": "Indonesia",
               "item": "[https://earthviral.com/country/indonesia/](https://earthviral.com/country/indonesia/)"
             },
             {
               "@type": "ListItem",
               "position": 3,
               "name": "Sports",
               "item": "[https://earthviral.com/country/indonesia/sports/](https://earthviral.com/country/indonesia/sports/)"
             },
             { "@type": "ListItem", "position": 4, "name": "Story Headline" }
           ]
         }
       ]
     }
     ```

### 9.4 Automated XML Sitemaps & Google News Sitemap

During Step 4 of every 3-hour static build, a dedicated script (`scripts/generate-sitemaps.ts`) writes the following files to `/public/`:

1. `/sitemap-index.xml` — Pointers to all child sitemaps with exact `<lastmod>` timestamps from the current 3-hour batch.
2. `/sitemap-core.xml` — Homepage, 6 Regional Hubs, 9 Category Hubs, and active Country Hubs (`priority="0.9"`, `changefreq="hourly"`).
3. `/sitemap-news.xml` — **Google News Specific Sitemap** (`xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"`) containing all viral clusters published within the last **48 hours**, complete with `<news:publication>`, `<news:publication_date>`, and `<news:title>`.
4. `/sitemap-stories-[yyyy-mm].xml` — Monthly partitioned sitemaps for all historical viral story pages so sitemap files never exceed 50,000 URLs.
5. **Automated IndexNow / Search Ping:** At the end of the 3-hour batch deployment, the script sends an HTTP POST to the **IndexNow API** (Bing/Yandex/Naver) with the list of newly generated or updated `/news/...` URLs for immediate indexing.

### 9.5 Automated Internal Linking Matrix (The "Spiderweb" Architecture)

To maximize PageRank distribution and time-on-site, the 3-hour batch generator computes an internal link graph for every page before HTML compilation:

1. **Breadcrumb Hierarchy Links:** Every story links up to its Country Hub, Country+Category Hub, and Global Category Hub.
2. **Same-Country Viral Sidebar ("Trending Now in Indonesia"):** Links to the top 5 highest-scoring active clusters in the same country.
3. **Same-Category Global Grid ("More Viral in Technology & AI"):** Links to 3–4 high-scoring clusters in the same category across other countries.
4. **Entity Tag Pills:** Each story extracts 2–4 recurring entities (e.g., `#TimnasIndonesia`, `#BankIndonesia`, `#OpenAI`) that link to static `/topic/[tag-slug]/` aggregation pages.
5. **Contextual In-Summary Links:** When an AI summary mentions another country or a tracked entity tag, the build renderer automatically wraps the first occurrence in an internal `<a href="/country/...">` or `<a href="/topic/...">` link.

---

## 10. Proposed Repository Structure (Static-First)

```text
earthviral/
├── PLAN_EARTH_VIRAL.md                    # This implementation blueprint
├── package.json
├── tsconfig.json
├── astro.config.mjs                       # Astro 7: `output: 'static'`, `trailingSlash: 'always'`, `build.format: 'directory'`, React + Tailwind v4 (Vite plugin)
├── .github/
│   └── workflows/
│       └── update-viral-batch.yml         # 3-hour cron + manual `workflow_dispatch` trigger
├── scripts/                               # OFFLINE 3-HOUR BATCH GENERATOR PIPELINE
│   ├── generate-viral-batch.ts            # Main CLI entry point (`npm run update:viral`)
│   ├── lib/
│   │   ├── fetchers/
│   │   │   ├── rssSources.ts              # Curated Indonesian & Global RSS feeds list
│   │   │   ├── fetchRss.ts                # Parallel RSS/Atom parser
│   │   │   └── fetchGoogleTrends.ts       # Public Geo Google Trends RSS fetcher
│   │   ├── intelligence/
│   │   │   ├── deduplicateAndCluster.ts   # Title shingle + cosine similarity grouping
│   │   │   ├── computeViralScore.ts       # VAS 0-100 formula implementation
│   │   │   ├── generateAiSummaries.ts     # Batch LLM calls for summary, SEO meta & tags
│   │   │   └── buildInternalLinks.ts      # Computes relatedInCountry & relatedInCategory
│   │   └── builders/
│   │       ├── writeStaticJson.ts         # Writes /public/data/* and /src/data/generated/*
│   │       ├── generateSitemaps.ts        # Writes sitemap-index.xml & sitemap-news.xml
│   │       └── generateOgImages.ts        # Pre-renders static social cards at build time
├── public/
│   ├── geo/
│   │   ├── countries-110m.topo.json
│   │   ├── countries-50m.topo.json
│   │   └── centroids.json
│   ├── data/                              # Generated static JSON for client map & drawers
│   │   ├── map-pulse.json
│   │   └── countries/
│   │       └── [code].json
│   ├── sitemap-index.xml                  # Generated at build time
│   ├── sitemap-news.xml                   # Generated at build time
│   └── robots.txt
└── src/
    ├── data/
    │   └── generated/                     # Generated static data consumed by Astro Content Layer
    │       ├── batch-meta.json
    │       ├── countries-master.json
    │       └── clusters/
    ├── content.config.ts                  # Content collections (`glob()` / `file()` loaders + Zod schemas) over src/data/generated
    ├── layouts/
    │   └── BaseLayout.astro               # Root HTML, global schema, header, footer, telemetry bar
    ├── pages/
    │   ├── index.astro                    # Homepage (Map Hero island + Pre-rendered SEO Grids)
    │   ├── country/
    │   │   └── [countrySlug]/
    │   │       ├── index.astro            # Static Country Hub (`getStaticPaths`)
    │   │       └── [categorySlug].astro   # Static Country + Category Hub
    │   ├── category/
    │   │   └── [categorySlug].astro       # Static Global Category Hub
    │   ├── region/
    │   │   └── [regionSlug].astro         # Static Regional Hub (Asia, Europe, etc.)
    │   ├── news/
    │   │   └── [countryCode]/
    │   │       └── [clusterSlug].astro    # Static Viral Story Page (Rich SEO + Schema + Links, zero JS)
    │   ├── topic/
    │   │   └── [tagSlug].astro            # Static Entity Tag Page
    │   ├── rss.xml.ts                     # Static RSS endpoint (`@astrojs/rss`)
    │   ├── about.astro                    # Mission + Transparent Scoring Methodology
    │   ├── contact.astro
    │   ├── privacy.astro
    │   └── terms.astro
    └── components/
        ├── map/                           # React island: Interactive WebGL Globe / 2D Map + Markers (`client:visible`)
        ├── drawer/                        # React island: Slide-over Country Intelligence Panel (`client:idle`)
        ├── search/                        # React island: Pagefind `Cmd+K` modal (`client:idle`)
        ├── news/                          # .astro: NewsCard, RelatedStories, SourceAttributionList
        └── seo/                           # .astro: JsonLdSchema, Breadcrumbs, InternalLinkPills
```

---

## 11. Phased Implementation Roadmap

### Phase 1 — Static Foundation, Design System & Interactive World Map

1. Initialize Astro 7 (`output: 'static'`, `trailingSlash: 'always'`, `build.format: 'directory'`) + `@astrojs/react` (islands) + Tailwind CSS v4 (`@tailwindcss/vite`) + TypeScript (strict), and define Content Layer collections in `src/content.config.ts`.
2. Implement the **Orbital Intelligence** dark UI theme, responsive Navigation Header, Global Telemetry Bar, and Footer.
3. Create initial static seed files in `/public/data/map-pulse.json` and `/src/data/generated/` (featuring deep Indonesian + Global viral stories).
4. Build the interactive 3D/2D World Map (`MapLibre GL JS` + Natural Earth TopoJSON) with tiered glowing country markers, hover tooltips, smooth camera fly-to, and `prefers-reduced-motion` support.

### Phase 2 — Country Drawer, Static SEO Hubs & Story Pages

1. Build the slide-over **Country Intelligence Drawer** (Desktop side panel / Mobile bottom sheet) that fetches `/data/countries/[code].json` on click.
2. Implement `getStaticPaths` (fed by `getCollection()`) for all static SEO page templates:
   - `/country/[countrySlug]/`
   - `/category/[categorySlug]/`
   - `/country/[countrySlug]/[categorySlug]/`
   - `/region/[regionSlug]/`
   - `/news/[countryCode]/[clusterSlug]/`
   - `/topic/[tagSlug]/`
3. Build the **Automated Internal Linking UI** (Breadcrumbs, Related in Country, Related in Category, Entity Tag pills, and Original Publisher Attribution blocks).

### Phase 3 — The 3-Hour AI Batch Generator CLI (`npm run update:viral`)

1. Build `scripts/generate-viral-batch.ts` to fetch RSS feeds (Indonesian & Global) + public Google Trends geo RSS + GDELT.
2. Implement article deduplication, event clustering, and the **Viral Activity Score (VAS 0–100)** algorithm.
3. Integrate the LLM batch summarizer (Gemini 2.5 Flash / OpenAI) with strict structured JSON output to generate neutral multi-bullet summaries, "Why It's Viral" context, SEO metadata, and entity tags.
4. Implement the internal link graph builder (`relatedInCountrySlugs`, `relatedInCategorySlugs`) and static JSON file writer.
5. Add `.github/workflows/update-viral-batch.yml` supporting both manual 1-click triggers (`workflow_dispatch`) and scheduled 3-hour cron runs (`0 */3 * * *`).

### Phase 4 — Technical SEO, Sitemaps, CWV & Monetization Polish

1. Implement build-time `JSON-LD` (`NewsArticle`, `CollectionPage`, `BreadcrumbList`, `WebSite`) and automated XML Sitemap + Google News Sitemap generation (`scripts/generate-sitemaps.ts`).
2. Integrate **Pagefind** post-build static search indexing for the `Cmd+K` search modal.
3. Add CLS-safe AdSense containers, `ads.txt`, and required legal/methodology pages (`/about/`, `/privacy/`, `/terms/`, `/contact/`).
4. Verify Lighthouse scores (`95–100` Performance, `100` SEO, `0.00` CLS).

---

## 12. Acceptance Criteria

- [ ] **100% Static Execution:** Running `npm run build` (`astro build`) produces a complete static site (`/dist`) with zero runtime database or server dependencies.
- [ ] **Manual / 3-Hour Batch Command:** Running `npm run update:viral` fetches fresh news signals, clusters stories via AI, calculates Viral Scores, writes updated JSON files, and updates the batch timestamp.
- [ ] **View-Source SEO Verification:** Viewing raw page source (`view-source:`) on `/`, `/country/indonesia/`, `/category/technology-ai/`, and `/news/id/[slug]/` shows fully pre-rendered HTML headlines, AI summaries, canonical tags, `JSON-LD` structured data, and internal `<a href>` links before any client JavaScript runs.
- [ ] **Automatic Sitemaps:** Every build outputs valid `/sitemap-index.xml`, `/sitemap-core.xml`, and `/sitemap-news.xml`.
- [ ] **Interactive Map Performance:** Homepage world map loads from static `/data/map-pulse.json`, highlights active countries by intensity tier, shows instant hover tooltips, and opens the country news drawer smoothly on both desktop and mobile.
