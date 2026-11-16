/**
 * Staging / production isolation tests (EarthViral_Staging_Environment_PLAN.md Phase 3).
 * Static checks of the workflow files plus the runtime guard. Run: `npm test`.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { ENVIRONMENTS, resolveSiteEnvironment } from '../../src/lib/environment.ts';
import { SCHEDULE } from '../../workers/scheduler/index.js';
import { checkEnvironment, checkWorkflow } from '../staging-guard.ts';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

describe('environments', () => {
  it('SITE_ENV defaults to production and rejects unknown values', () => {
    assert.equal(resolveSiteEnvironment(undefined), 'production');
    assert.equal(resolveSiteEnvironment(''), 'production');
    assert.equal(resolveSiteEnvironment('staging'), 'staging');
    assert.throws(() => resolveSiteEnvironment('prod'));
  });

  it('staging and production never share a URL, Pages project or branch', () => {
    const { production: p, staging: s } = ENVIRONMENTS;
    assert.notEqual(p.url, s.url);
    assert.notEqual(p.pagesProject, s.pagesProject);
    assert.notEqual(p.branch, s.branch);
    assert.equal(p.url, 'https://earthviral.com'); // production URL preserved
  });
});

describe('staging guard', () => {
  const ok = {
    SITE_ENV: 'staging',
    PAGES_PROJECT: 'earthviral-staging',
    GITHUB_REF: 'refs/heads/staging',
  };

  it('passes for a correct staging environment', () => {
    assert.deepEqual(checkEnvironment(ok), []);
  });

  it('fails on production targets, the main branch and production credentials', () => {
    assert.ok(checkEnvironment({ ...ok, SITE_ENV: undefined }).length > 0);
    assert.ok(checkEnvironment({ ...ok, PAGES_PROJECT: 'earthviral-web' }).length > 0);
    assert.ok(checkEnvironment({ ...ok, GITHUB_REF: 'refs/heads/main' }).length > 0);
    for (const name of ['CLOUDFLARE_API_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'INDEXNOW_KEY'])
      assert.ok(checkEnvironment({ ...ok, [name]: 'x' }).length > 0, name);
  });

  it('accepts the committed staging.yml', async () => {
    assert.deepEqual(checkWorkflow(await read('.github/workflows/staging.yml')), []);
  });

  it('rejects a staging workflow that could reach production', async () => {
    const yml = await read('.github/workflows/staging.yml');
    assert.ok(
      checkWorkflow(
        yml.replace('secrets.STAGING_CLOUDFLARE_API_TOKEN', 'secrets.CLOUDFLARE_API_TOKEN'),
      ).length > 0,
    );
    assert.ok(
      checkWorkflow(
        yml.replace('--project-name=earthviral-staging', '--project-name=earthviral-web'),
      ).length > 0,
    );
    assert.ok(checkWorkflow(yml.replace('contents: read', 'contents: write')).length > 0);
    assert.ok(checkWorkflow(`${yml}\n      - run: git push origin HEAD:main\n`).length > 0);
    assert.ok(
      checkWorkflow(yml.replace('on:\n', "on:\n  schedule:\n    - cron: '0 * * * *'\n")).length > 0,
    );
  });
});

describe('production workflows are unaffected by staging', () => {
  it('only main deploys to the production Pages project', async () => {
    const ci = await read('.github/workflows/ci.yml');
    assert.match(ci, /--project-name=earthviral-web --branch=main/);
    assert.match(ci, /github\.ref == 'refs\/heads\/main'/);
    assert.doesNotMatch(ci, /earthviral-staging|STAGING_/);
  });

  it('a staging run cannot trigger the production deploy or batch', async () => {
    const ci = await read('.github/workflows/ci.yml');
    // CI's workflow_run listens to the production batch only, and only on main.
    assert.match(ci, /workflows: \['Update viral batch'\]/);
    assert.match(ci, /workflow_run\.head_branch == 'main'/);
    const staging = await read('.github/workflows/staging.yml');
    assert.match(staging, /^name: Staging$/m);
    assert.doesNotMatch(staging, /workflow_run|repository_dispatch|gh workflow run|dispatches/);
    const batch = await read('.github/workflows/update-viral-batch.yml');
    assert.match(batch, /if: github\.ref == 'refs\/heads\/main'/);
    assert.doesNotMatch(batch, /SITE_ENV|STAGING_/);
  });

  it('the scheduler worker never dispatches staging', async () => {
    assert.ok(!Object.values(SCHEDULE).includes('staging.yml'));
    assert.match(await read('workers/scheduler/wrangler.toml'), /GITHUB_REF = "main"/);
  });
});
