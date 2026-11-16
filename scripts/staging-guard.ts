/**
 * Staging safety guard (EarthViral_Staging_Environment_PLAN.md Phase 3). The staging
 * workflow (.github/workflows/staging.yml) runs it before doing anything and again before
 * deploying; any problem fails the run.
 *
 *   node scripts/staging-guard.ts                 # environment + workflow checks
 *   node scripts/staging-guard.ts --verify-dist   # also check dist/ is a staging build
 *
 * Checks:
 *   - SITE_ENV is "staging" and the deploy target is the staging Pages project
 *   - the run is not on the production branch
 *   - no production credential (by its production variable name) is in the environment
 *   - staging.yml references only STAGING_* secrets, never pushes, has no schedule and
 *     deploys only to the staging project
 *   - (--verify-dist) dist/ is noindex everywhere, uses the staging origin, and never the
 *     production origin as canonical
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENTS } from '../src/lib/environment.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROD = ENVIRONMENTS.production;
const STAGING = ENVIRONMENTS.staging;

/** Production credential names. Staging uses separately named STAGING_* secrets. */
export const PRODUCTION_SECRET_NAMES = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'INDEXNOW_KEY',
  'PUBLIC_ADSENSE_CLIENT',
] as const;

export function checkEnvironment(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  if (env.SITE_ENV !== 'staging')
    problems.push(`SITE_ENV must be "staging" (got "${env.SITE_ENV ?? ''}")`);
  if (env.PAGES_PROJECT !== STAGING.pagesProject)
    problems.push(
      `PAGES_PROJECT must be "${STAGING.pagesProject}" (got "${env.PAGES_PROJECT ?? ''}")`,
    );
  if (env.PAGES_PROJECT === PROD.pagesProject)
    problems.push(`PAGES_PROJECT is the production project "${PROD.pagesProject}"`);
  if (env.GITHUB_REF && env.GITHUB_REF !== `refs/heads/${STAGING.branch}`)
    problems.push(`staging runs only on refs/heads/${STAGING.branch} (got ${env.GITHUB_REF})`);
  for (const name of PRODUCTION_SECRET_NAMES)
    if (env[name]?.trim()) problems.push(`production credential ${name} is set in the environment`);
  return problems;
}

export function checkWorkflow(yml: string): string[] {
  const problems: string[] = [];
  const secrets = [...yml.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
  for (const name of secrets)
    if (!name.startsWith('STAGING_'))
      problems.push(`staging.yml uses secret ${name}; staging may use only STAGING_* secrets`);
  if (/^\s*schedule:/m.test(yml)) problems.push('staging.yml must not have a schedule trigger');
  if (/git\s+push/.test(yml)) problems.push('staging.yml must not push to the repository');
  if (!/^\s*contents:\s*read\s*$/m.test(yml)) problems.push('staging.yml must use contents: read');
  const deploys = [...yml.matchAll(/--project-name=(\S+)/g)].map((m) => m[1]!);
  if (deploys.length === 0) problems.push('staging.yml has no Pages deploy command');
  for (const target of deploys)
    if (target !== STAGING.pagesProject)
      problems.push(`staging.yml deploys to "${target}", not ${STAGING.pagesProject}`);
  if (/--branch=(?!staging\b)/.test(yml))
    problems.push('staging.yml deploys a branch other than staging');
  return problems;
}

export function checkDist(dist: string): string[] {
  const problems: string[] = [];
  const read = (p: string) =>
    existsSync(join(dist, p)) ? readFileSync(join(dist, p), 'utf8') : null;
  const index = read('index.html');
  if (!index) return [`${dist}/index.html is missing — build first`];
  if (!/<meta name="robots" content="noindex, nofollow"/.test(index))
    problems.push('index.html is not noindex, nofollow');
  if (!index.includes('data-environment-banner="staging"')) problems.push('staging banner missing');
  if (index.includes(`<link rel="canonical" href="${PROD.url}`))
    problems.push('canonical URL points at production');
  if (!index.includes(`${STAGING.url}/`)) problems.push(`staging origin ${STAGING.url} not used`);
  if (!/X-Robots-Tag: noindex/.test(read('_headers') ?? ''))
    problems.push('_headers lacks the site-wide X-Robots-Tag: noindex rule');
  if (!/Disallow: \//.test(read('robots.txt') ?? ''))
    problems.push('robots.txt does not disallow /');
  if ((read('robots.txt') ?? '').includes('Sitemap:')) problems.push('robots.txt lists a sitemap');
  return problems;
}

function main() {
  const problems = [
    ...checkEnvironment(process.env),
    ...checkWorkflow(readFileSync(join(ROOT, '.github/workflows/staging.yml'), 'utf8')),
    ...(process.argv.includes('--verify-dist') ? checkDist(join(ROOT, 'dist')) : []),
  ];
  if (problems.length > 0) {
    console.error('✖ Staging guard failed:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `✔ Staging guard passed (${STAGING.url} → Pages project ${STAGING.pagesProject}${process.argv.includes('--verify-dist') ? ', dist verified' : ''})`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
