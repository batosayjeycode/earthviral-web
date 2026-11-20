# EarthViral Staging Environment --- Implementation Plan

**Status:** In progress — repository work implemented on branch `staging` (see §12); Cloudflare setup and reviews pending\
**Purpose:** Establish an isolated staging environment for testing
EarthViral changes safely before production deployment, starting with
the Joho no Todai English RSS publisher integration.\
**Proposed staging URL:** `https://staging.earthviral.com`

---

## 1. Background

EarthViral currently publishes statically generated news content. Its
scheduled ingestion process runs every three hours, reads configured RSS
sources, groups articles covering the same events, and generates AI
summaries using headlines and short descriptions.

Joho no Todai has approved the proposed approach for reviewing its
English RSS feed, subject to the safeguards discussed by email. Their
feed requires a dedicated headline-only policy:

- Use only publisher name, original headline, publication date, and
  direct article URL.
- Do not use descriptions, content, or image fields.
- Do not fetch or store article bodies.
- Exclude the publisher's headlines from all AI summaries,
  translations, and third-party AI provider payloads, including when
  grouped with other publishers.
- Allow internal, non-AI story matching and coverage counting.
- Display its original headlines only as attributed links in source
  lists for stories also covered by other publishers.
- Do not publish stories sourced exclusively from Joho no Todai.
- Do not sublicense or redistribute its content.
- Support removal of the feed and associated headlines from active
  systems and public displays on request.

These requirements introduce source-specific processing rules. Staging
should be used to implement and verify these rules without risking
production data, scheduled jobs, or public pages.

## 2. Objectives

1.  Create `staging.earthviral.com` as a protected, non-production
    environment.
2.  Separate staging deployments, generated data, configuration, and
    credentials from production.
3.  Provide a safe way to test RSS ingestion and publisher-specific
    content policies.
4.  Verify that Joho no Todai content is never sent to an AI provider or
    used to generate derivative content.
5.  Validate the generated pages and source attribution before any
    production release.
6.  Establish a reusable staging workflow for future EarthViral features
    and publisher integrations.

## 3. Non-Goals

- Replacing or redesigning the production website.
- Changing the existing production schedule or production ingestion
  behavior as part of staging setup.
- Creating a public-facing publisher administration portal.
- Enabling an independent staging AI workload by default.
- Publishing Joho no Todai content before the safeguards have passed
  review.

## 4. Environment and URL Strategy

---

Environment URL Purpose Access

---

Production `https://earthviral.com` Public website Public
and live  
generated content

Staging `https://staging.earthviral.com` Integration, Protected
regression, and  
release testing

Admin (future) `https://admin.earthviral.com` Optional source Not in current
and policy scope
management UI
----------------------------------------------------------------------------------------

Use **staging**, not **uat**, for the permanent pre-production
environment. `staging` is suitable for engineering integration and
release verification. A separate UAT environment is unnecessary unless a
later workflow requires dedicated business-user acceptance testing.

### 4.1 Staging safeguards

- Protect staging with Cloudflare Access or an equivalent
  authentication layer.
- Configure `noindex` and prevent staging URLs from appearing in
  production sitemaps.
- Do not rely on `robots.txt` alone for privacy; authentication must
  protect non-public content.
- Keep staging visibly identifiable to prevent confusion with
  production.
- Do not expose secrets or internal debug information in client-side
  bundles.

## 5. Target Architecture

```text
                         GitHub Repository
                                |
                    Pull request / branch
                                |
                 +--------------+--------------+
                 |                             |
             Production                     Staging
             main branch                 staging branch
                 |                             |
        Production deployment          Staging deployment
                 |                             |
        earthviral.com                staging.earthviral.com
                 |                             |
        Production data                Staging data
                 |                             |
        Production schedule            Manual test runs
```

The two environments must be isolated. A staging deployment must never
write to production generated-data directories, production storage, or
production services.

### 5.1 Separation requirements

---

Component Production Staging

---

Git branch `main` `staging` or dedicated
staging branch

Deployment target Production Pages Separate staging Pages
project project or isolated
deployment target

Generated data Production dataset Staging-only dataset

RSS configuration Production sources Test/staging source
configuration

Publisher policies Production policies Test/staging policy
configuration

Scheduled batch Existing production Disabled by default;
schedule manual trigger

Secrets Production-only secrets Separate
least-privilege staging
secrets

AI provider Existing production Disabled by default;
configuration mock or controlled test
configuration

Sitemaps Production sitemap No production sitemap
inclusion

Access Public Protected
-----------------------------------------------------------------------

Prefer a separate Cloudflare Pages project for staging if that provides
clearer isolation and independent environment variables. A Pages Preview
Deployment can be used for short-lived branch previews, but it should
not replace a stable staging URL when scheduled ingestion and end-to-end
integration testing are required.

## 6. Implementation Phases

### Phase 1 --- Repository and deployment assessment

- [x] Review the current repository structure, build scripts,
      deployment configuration, and GitHub Actions workflows.
- [x] Identify how production static files and generated data are
      produced and deployed.
- [x] Identify all production secrets, storage locations, and external
      services used by the batch process.
- [x] Identify scheduled workflows and all paths that can commit or
      publish generated data.
- [x] Document the current production deployment and rollback process.
- [x] Confirm the hosting arrangement supports a separate staging
      deployment.

**Deliverable:** A verified map of the existing production deployment
and batch workflow. Do not change production behavior during this
assessment.

### Phase 2 --- Create staging environment

- [ ] Create a separate Cloudflare Pages project or equivalent
      isolated staging deployment target.
- [ ] Configure `staging.earthviral.com` in Cloudflare DNS.
- [ ] Configure the custom domain and verify HTTPS.
- [ ] Configure Cloudflare Access or equivalent authentication.
- [x] Add `noindex` behavior and ensure staging is excluded from
      production sitemap generation.
- [x] Configure staging-specific environment variables.
- [x] Ensure staging cannot access production secrets or write to
      production storage.
- [ ] Deploy the current application to staging and verify the site
      loads correctly.

**Acceptance criteria:**

- `https://staging.earthviral.com` loads over HTTPS.
- Unauthenticated visitors cannot access protected staging content.
- Staging is not indexed or referenced by production sitemaps.
- Staging deployment does not modify production.

### Phase 3 --- Separate deployment and data workflows

- [x] Define the branch-to-environment deployment strategy.
- [x] Configure staging deployment on updates to the staging branch or
      approved pull requests.
- [x] Keep production deployment tied to the existing production
      release process.
- [x] Use separate output paths, generated-data directories, or
      storage locations for staging.
- [x] Ensure staging workflows cannot commit to or trigger production
      data updates.
- [x] Disable staging scheduled batch execution by default.
- [x] Add a manual staging batch trigger for controlled testing.
- [x] Review GitHub Actions permissions and use least-privilege
      tokens.
- [x] Add safeguards that fail a staging workflow if it detects
      production credentials or production output targets.

**Acceptance criteria:**

- A staging deployment can be performed without deploying production.
- A staging batch can be run manually without modifying production
  files or services.
- Staging workflow completion cannot unintentionally trigger the
  production batch or publish production data.

### Phase 4 --- Implement publisher-level content policy

Create or extend a source configuration model so that restrictions are
enforced per publisher, rather than relying on a batch-wide fallback.

Illustrative configuration (adapt names and structure to the existing
codebase):

```yaml
source:
  id: joho-no-todai-en
  name: Joho no Todai
  feed_url: https://joho-todai.com/en/rss/
  category: technology_ai
  enabled: false

  content_policy:
    mode: headline_only
    allowed_fields:
      - publisher_name
      - original_headline
      - publication_date
      - original_article_url

    use_description: false
    use_content: false
    use_images: false
    fetch_article_body: false
    store_article_body: false

    ai_summarization: false
    ai_translation: false
    send_to_ai_provider: false
    model_training: false

    internal_story_matching: true
    internal_coverage_counting: true

    display_original_headline: true
    display_only_with_other_publishers: true
    publish_if_exclusive_source: false

    sublicense: false
    downstream_redistribution: false
```

The configuration is illustrative, not a required schema. Follow
existing project conventions and avoid introducing duplicate
configuration systems.

Implementation requirements:

- [x] Parse only the four permitted RSS fields for this source.
- [x] Do not retain RSS descriptions, full content, image URLs,
      enclosures, or other unapproved fields.
- [x] Do not fetch original article pages or article bodies.
- [x] Enforce AI exclusion before constructing any AI-provider request
      payload.
- [x] Ensure Joho no Todai headlines are excluded even when an event
      group also contains articles from other publishers.
- [x] Keep internal story matching and coverage counting non-AI.
- [x] Ensure no generated summary, translation, paraphrase, or
      derivative text is based on Joho no Todai headlines.
- [x] Display the original headline only as an attributed source link
      when the same story is covered by at least one other eligible
      publisher.
- [x] Suppress stories whose only eligible coverage is from Joho no
      Todai.
- [x] Ensure EarthViral RSS feeds, sitemaps, and other downstream
      outputs do not redistribute the publisher's headlines or RSS
      content.
- [x] Implement removal of the feed and associated headlines from
      active systems and public displays.
- [x] Document how logs, caches, backups, and historical generated
      files are handled when a removal request is received.

**Important:** Do not assume that hiding a headline in the frontend is
sufficient. The restrictions must be enforced throughout ingestion,
persistence, grouping, AI payload construction, generation, and
publication.

### Phase 5 --- Staging test data and integration testing

Use staging-only data and controlled fixtures wherever possible. Do not
use production database connections or production write paths for tests.

- [x] Add RSS fixtures representing permitted and disallowed fields.
- [x] Test that only the four permitted fields are extracted.
- [x] Test that description, content, and image fields are ignored and
      not persisted.
- [x] Test that no article-body HTTP request is made.
- [x] Test that Joho no Todai headlines never appear in AI-provider
      request payloads.
- [x] Test mixed-source event groups containing Joho no Todai and
      other publishers.
- [x] Test that other publishers can still be processed according to
      their own policies.
- [x] Test that Joho no Todai original headlines appear only in
      attributed source links.
- [x] Test that Joho no Todai-only stories are excluded from
      publication.
- [x] Test that no Joho no Todai headline is included in EarthViral
      RSS feeds or sitemaps.
- [x] Test source removal and verify removal from active staging data
      and public displays.
- [x] Test that staging output cannot be deployed to production
      accidentally.
- [x] Run existing build, unit, integration, and regression tests.

### Phase 6 --- Review and production release

- [ ] Review implementation against every condition accepted by Joho
      no Todai.
- [ ] Review test evidence, including AI payload exclusion and
      network/fetch behavior.
- [ ] Verify staging output and source attribution manually.
- [ ] Confirm removal behavior and operational ownership.
- [ ] Obtain engineering approval for production release.
- [ ] Enable the source in production only after all safeguards are
      verified.
- [ ] Keep the production source disabled if any requirement is not
      met.
- [ ] Monitor the first production ingestion and verify output.
- [x] Record the publisher policy and agreed conditions in project
      documentation.

## 7. Joho no Todai Acceptance Checklist

The integration must not be considered complete until every item below
passes.

---

Requirement Verification

---

Only publisher name, original Parser unit tests and stored-data
headline, publication date, and inspection
direct URL are used

Description/content/image fields RSS fixture tests and stored-data
are ignored inspection

No article-body fetching Network/request test

No AI summary or translation Pipeline tests

No headline sent to a third-party AI payload inspection and automated
AI provider test

No AI use when grouped with other Mixed-source grouping test
publishers

Internal story matching and Code-path review and tests
coverage counting are non-AI

Original headline appears only as Generated-page review
attributed source link

Joho no Todai-only stories are not Exclusive-source fixture test
published

No RSS/sitemap redistribution Generated RSS and sitemap
inspection

Removal request can be fulfilled Removal test and documented
procedure
-----------------------------------------------------------------------

## 8. Security and Operational Requirements

- Use separate staging and production credentials.
- Never copy production secrets into staging.
- Use mock AI clients or a controlled test provider for staging tests;
  do not send Joho no Todai content to any AI service.
- Restrict staging batch execution to authorized maintainers.
- Use least-privilege GitHub Actions permissions.
- Keep staging authentication enabled, including for generated
  previews where practical.
- Ensure staging data and logs do not retain fields outside the agreed
  publisher scope.
- Add clear environment guards to prevent staging scripts from writing
  to production.
- Keep an auditable record of publisher policy changes and source
  enable/disable actions.

## 9. Rollback Plan

If staging or the publisher integration fails validation:

1.  Keep the Joho no Todai source disabled.
2.  Stop the staging batch or disable the staging workflow.
3.  Revert the staging code or configuration to the last known-good
    version.
4.  Confirm production deployment, generated data, and scheduled
    workflows remain unchanged.
5.  Fix the issue and repeat the relevant tests before proceeding.

If a production release causes a policy violation:

1.  Disable the Joho no Todai source immediately.
2.  Stop further ingestion and publication for that source.
3.  Remove affected headlines from active systems and public displays.
4.  Inspect AI-provider payload logs and generated outputs to determine
    whether any restricted content was transmitted or used.
5.  Follow the publisher's removal request and communicate
    transparently.
6.  Do not re-enable the source until the issue is fixed and verified.

## 10. Definition of Done

The staging initiative is complete when:

- [ ] `staging.earthviral.com` is deployed, protected, and accessible
      to authorized reviewers.
- [ ] Staging and production have isolated deployments, data, secrets,
      and workflows.
- [ ] Staging batch execution is manual and cannot affect production.
- [x] Publisher-level content policies are implemented and documented.
- [x] All Joho no Todai acceptance tests pass.
- [ ] The generated staging output follows the agreed display and
      attribution rules.
- [x] Removal behavior has been tested and documented.
- [x] Production release and rollback procedures are documented.
- [ ] Engineering review approves the implementation.

## 11. Suggested Implementation Order

Prioritize work in this order to reduce risk:

1.  Assess the existing deployment and ingestion architecture.
2.  Create the protected staging environment.
3.  Isolate staging deployment, data, secrets, and workflows.
4.  Implement publisher-level policy enforcement.
5.  Add automated tests proving AI exclusion and field restrictions.
6.  Validate source display, exclusive-source suppression, and removal.
7.  Review all acceptance criteria.
8.  Release to production through the normal deployment process.

---

## Implementation Constraints

- Start with repository and configuration inspection.
- Do not modify production data, production secrets, production
  schedules, or live publisher configuration during initial
  implementation.
- Do not run production ingestion or exports as part of testing.
- Prefer local tests, fixtures, mocks, and staging-only resources.
- Do not enable Joho no Todai in production until all safeguards are
  verified.
- Preserve existing production URLs and deployment behavior.
- Avoid unrelated refactoring.
- Update this plan with actual repository paths, workflow names,
  environment variable names, and implementation decisions after
  inspection.

---

## 12. As-built implementation (branch `staging`)

This section records what the inspection found and what was implemented. Items that need
Cloudflare or GitHub settings access (they cannot be done from the repository) are listed in
§12.4 and stay unchecked above until done.

### 12.1 Phase 1 assessment — existing production

| Item               | Finding                                                                                                                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosting            | Static Astro 7 site, Cloudflare Pages project **`earthviral-web`**, custom domain `earthviral.com`.                                                                                                                                                                                                   |
| Deploy             | `.github/workflows/ci.yml` → job `deploy`: `wrangler pages deploy dist --project-name=earthviral-web --branch=main`, on push to `main` or after a successful **Update viral batch** run (`workflow_run`). Then IndexNow ping.                                                                         |
| Batch              | `.github/workflows/update-viral-batch.yml` ("Update viral batch"): checks out `main`, runs `scripts/generate-viral-batch.ts`, builds, commits `src/data/generated`, `public/data`, `public/_redirects` and **pushes to `main`** (`contents: write`).                                                  |
| Schedules          | `workers/scheduler` Cloudflare Worker (`earthviral-scheduler`) dispatches `update-viral-batch.yml` (cron `17 2-23/3 * * *`) and `staleness-watchdog.yml` (`41 * * * *`) on `ref: main`; GitHub `schedule` triggers are a backup.                                                                      |
| Generated data     | `src/data/generated/**` (cluster JSON, batch-meta, masters, retired-stories), `public/data/**` (map-pulse, global-trending, per-country JSON), `public/_redirects`. Written only by `scripts/lib/builders/writeStaticJson.ts`.                                                                        |
| Production secrets | Repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `INDEXNOW_KEY`; Worker secret `GITHUB_TOKEN`. Vars: `GEMINI_MODEL`, `OPENAI_MODEL`, `MAX_STORIES_PER_COUNTRY`, `MAX_STORED_STORIES`, `AI_CONCURRENCY`, `PUBLIC_*`, `SITE_URL`, `STALE_AFTER_HOURS`. |
| External services  | RSS feeds (`scripts/lib/fetchers/rssSources.ts`), GDELT DOC API, Google Trends RSS, Gemini / OpenAI APIs, IndexNow, Cloudflare Pages. EarthViral never fetches article pages for any source.                                                                                                          |
| Rollback           | Cloudflare Pages → `earthviral-web` → Deployments → "Rollback to this deployment"; or revert the commit on `main` (CI redeploys). Bad data: revert the `chore(data)` commit.                                                                                                                          |
| Staging support    | Cloudflare Pages allows a second project with its own variables, custom domain and Access policy — chosen over Preview deployments (§5.1).                                                                                                                                                            |

### 12.2 Implementation decisions

**Environment selection** — `SITE_ENV` (`src/lib/environment.ts`): unset/`production` →
`https://earthviral.com` + Pages `earthviral-web` + branch `main`; `staging` →
`https://staging.earthviral.com` + Pages `earthviral-staging` + branch `staging`. URLs and
project names are derived, never free-form; unknown values fail the build.

**Staging build** (`SITE_ENV=staging`, `npm run build:staging`): `astro.config.mjs` `site`
is the staging URL; every page `noindex, nofollow`; visible STAGING banner
(`src/layouts/BaseLayout.astro`); `robots.txt` disallows all with no sitemap; site-wide
`X-Robots-Tag: noindex, nofollow` appended to `dist/_headers` (integration in
`astro.config.mjs`); AdSense and IndexNow forced off (`src/lib/site.ts`). Production
sitemaps/RSS use the production origin only; a production build was diffed against the
pre-change build and is byte-identical apart from the stylesheet hash.

**Staging workflow** — `.github/workflows/staging.yml` ("Staging"):
push to `staging` → guard, unit tests, staging build, `test:dist` in staging mode,
`staging-guard --verify-dist`, deploy to `earthviral-staging --branch=staging`. Manual
"Run workflow" adds an optional staging batch (`run_batch`, `provider` default `none`).
No schedule. `permissions: contents: read`, `persist-credentials: false`; batch output is
never committed — it exists only in that run and the 7-day artifact `staging-data-<run id>`
(staging-only dataset). Uses the GitHub Environment `staging` and **only `STAGING_*`
secrets**: `STAGING_CLOUDFLARE_API_TOKEN`, `STAGING_CLOUDFLARE_ACCOUNT_ID`, optional
`STAGING_GEMINI_API_KEY` / `STAGING_OPENAI_API_KEY`.

**Guards** — `scripts/staging-guard.ts` (`npm run staging:guard`) fails the run if
`SITE_ENV≠staging`, `PAGES_PROJECT≠earthviral-staging`, the ref is not `refs/heads/staging`,
any production credential name is in the environment, `staging.yml` references a
non-`STAGING_*` secret / pushes / has a schedule / lacks `contents: read` / deploys to another
project, or (with `--verify-dist`) `dist/` is not a noindex staging build.
Production workflows got two protective conditions (no behaviour change on `main`):
`update-viral-batch.yml` job runs only on `refs/heads/main`; `ci.yml` `workflow_run` only
for batch runs on `main`. `scripts/lib/staging.test.ts` checks all of this statically.
The staging batch (`SITE_ENV=staging`) makes **no AI calls unless `--provider` is passed
explicitly**.

**Publisher policy model** — `src/lib/publisherPolicy.ts` (shared by batch and site):
`ContentPolicy` with `STANDARD_POLICY`, `HEADLINE_ONLY_POLICY`, `REMOVED_POLICY`;
`PUBLISHER_POLICIES` (Joho no Todai, `joho-todai.com` + subdomains → headline-only) and
`REMOVED_PUBLISHERS`. Policies are keyed by publisher domain so they also apply to GDELT
articles from the same publisher. The RSS source `joho-no-todai-en`
(`https://joho-todai.com/en/rss/`, `homeCountry: null`) has `environments: ['staging']`:
production never fetches it (`activeSources()` in `rssSources.ts`).

| Requirement                                              | Enforcement point                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Only name, headline, date, URL                           | `parseFeed` never reads description/content/summary for the publisher (`fetchRss.ts`); `applyIngestionPolicy` blanks snippets for any channel; stored `sources` hold only publisher, headline, URL, date.                                                                                                          |
| No article bodies                                        | No code path fetches article pages; test asserts only the feed URL is requested.                                                                                                                                                                                                                                   |
| No AI / derivative text, incl. mixed groups              | `scripts/lib/intelligence/summaryInput.ts` (batch) and `scripts/retitle-stories.ts` pass only `derivableArticles`; `geminiRequestBody` / `openAiRequestBody` (via `userPrompt`) and `heuristicSummary` call `assertDerivable` and throw `ContentPolicyViolation`; the summariser rethrows it (batch fails closed). |
| Non-AI matching and counting                             | TF-IDF clustering and `publisherCount` unchanged; restricted articles count in `metrics.publishers`.                                                                                                                                                                                                               |
| No exclusive-source stories                              | New clusters need `hasDerivableCoverage` (batch); stored stories without it are withdrawn (`cleanStoredStories`, 301 to country page); the site never builds them (`getClusters` in `src/lib/data.ts`).                                                                                                            |
| Headline only as attributed link beside other publishers | `displayableSources`; `SourceAttributionList.astro` marks the item `data-source-policy="restricted"` and `data-pagefind-ignore="all"`.                                                                                                                                                                             |
| No redistribution                                        | RSS/sitemaps use EarthViral headlines only; restricted URLs excluded from JSON-LD `isBasedOn` and public JSON `primarySource` (`redistributableSources`); excluded from the Pagefind index.                                                                                                                        |

**Tests** — `scripts/lib/contentPolicy.test.ts` (RSS + Atom fixtures with description,
`content:encoded`, media, enclosure; field extraction; no article fetch; mixed-group AI
payloads for Gemini and OpenAI; fail-closed guards; exclusive-source suppression; display and
redistribution rules; removal), `scripts/lib/staging.test.ts` (isolation),
`tests/dist.test.mjs` (now environment-aware: staging noindex/banner/headers/no ads; production
contains no staging reference; restricted headlines absent from RSS/sitemaps/public JSON/JSON-LD
and only inside attributed source items). An end-to-end staging build with temporary fixture
data (a mixed story with a Joho no Todai source + a Joho-only story) confirmed: the Joho-only
story was not built; the headline appeared only in the restricted source item on the mixed
story; nothing in RSS, sitemaps, JSON or the search index. Fixture data was reverted.

### 12.3 Removal procedure (publisher request)

1. Add the domain to `REMOVED_PUBLISHERS` in `src/lib/publisherPolicy.ts` (date + reason) and
   delete its entry from `RSS_SOURCES`. From the next build its sources are hidden everywhere
   and its stories without other coverage are not built; the next batch stops ingesting it
   (RSS and GDELT) and deletes its stored sources.
2. Purge stored data immediately: `npm run remove:publisher -- <domain> --dry-run`, then
   without `--dry-run`. It deletes the publisher's stored sources, withdraws stories left
   without publishable coverage (301 → country page) and regenerates `public/data`. Open a PR
   to `main`; CI deploys.
3. Caches and copies: purge the Cloudflare cache for `earthviral.com` (and staging); delete
   older Pages deployments of `earthviral-web` / `earthviral-staging` that still contain the
   headlines; delete `batch-snapshot-*` (14-day) and `staging-data-*` (7-day) Actions artifacts
   that predate the removal, or let them expire.
4. Logs: batch logs print counts and EarthViral headlines only, never source headlines; AI
   payloads never contained the publisher's content. Actions logs expire with repository
   retention settings and can be deleted per run.
5. Git history: past `chore(data)` commits contain the stored headlines. If the publisher
   requires it, rewrite history for `src/data/generated` (coordinate with the team; force
   push) — otherwise record that historical commits are retained but not published.
6. Record the request, date and actions in this document (auditable record).

### 12.4 Remaining manual setup (requires Cloudflare / GitHub admin)

1. Cloudflare Pages: create project **`earthviral-staging`** (direct upload), production branch
   `staging`. Add custom domain `staging.earthviral.com` (creates the DNS record; verify HTTPS).
2. Cloudflare Zero Trust → Access: self-hosted application covering `staging.earthviral.com`,
   `earthviral-staging.pages.dev` and `*.earthviral-staging.pages.dev`, allow only named
   maintainers/reviewers. Also enable the Pages project's preview access policy.
3. Cloudflare API token for staging: "Cloudflare Pages: Edit" only. Pages tokens are
   account-wide, so a staging token could technically deploy to `earthviral-web`; the
   workflow guard prevents that. For hard isolation, host `earthviral-staging` in a separate
   Cloudflare account and use that account's token.
4. GitHub → Settings → Environments → **`staging`**: deployment branches = `staging` only;
   optional required reviewers; secrets `STAGING_CLOUDFLARE_API_TOKEN`,
   `STAGING_CLOUDFLARE_ACCOUNT_ID` (and optional `STAGING_GEMINI_API_KEY` /
   `STAGING_OPENAI_API_KEY`, separate keys from production). Never copy production secrets.
5. Branch protection on `staging` (PRs required) so only reviewed changes deploy.
6. Push `staging`, confirm the Staging workflow deploys, the site loads over HTTPS, an
   unauthenticated request is redirected to Access, then run "Run workflow" with
   `run_batch: true`, `provider: none` and review Joho no Todai attribution on staging.

### 12.5 Release procedure

Feature work: branch → PR into `staging` → Staging deploy → review on staging.earthviral.com
→ PR `staging` → `main` (normal CI, QA and deploy). Staging never commits data, so a
`staging → main` merge carries code only. To enable Joho no Todai in production after
§7 passes review: change its `environments` to `['production', 'staging']` in a reviewed PR,
then monitor the first production batch (`batch-meta.json` `pipeline`, story pages). Rollback:
revert that PR (source disabled), then follow §12.3 if headlines must be removed.
