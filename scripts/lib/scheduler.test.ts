/** Tests for the Cloudflare Worker scheduler (workers/scheduler). Run: `npm test`. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { VAS } from '../../src/lib/scoring.ts';
import { SCHEDULE, dispatchWorkflow, workflowForCron } from '../../workers/scheduler/index.js';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
const cronOf = (yml: string) => /cron: '([^']+)'/.exec(yml)?.[1];

describe('scheduler worker', () => {
  it('wrangler.toml crons match the worker map and the workflow files', async () => {
    const toml = await read('workers/scheduler/wrangler.toml');
    const crons = [...toml.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
    assert.deepEqual(crons.sort(), Object.keys(SCHEDULE).sort());
    assert.equal(cronOf(await read('.github/workflows/update-viral-batch.yml')), '17 2-23/3 * * *');
    assert.equal(cronOf(await read('.github/workflows/staleness-watchdog.yml')), '41 * * * *');
    assert.equal(workflowForCron('17 2-23/3 * * *'), 'update-viral-batch.yml');
    assert.equal(workflowForCron('41 * * * *'), 'staleness-watchdog.yml');
    assert.equal(workflowForCron('0 * * * *'), null);
  });

  it("the batch cron minute matches the site's Next Update setting", () => {
    const batchCron = Object.entries(SCHEDULE).find(
      ([, wf]) => wf === 'update-viral-batch.yml',
    )?.[0];
    assert.equal(Number(batchCron?.split(' ')[0]), VAS.batchCronMinute);
  });

  it('dispatches via the GitHub API with the token and ref', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const status = await dispatchWorkflow(
      'update-viral-batch.yml',
      { GITHUB_TOKEN: 'tok', GITHUB_REPO: 'o/r', GITHUB_REF: 'main' },
      fake,
    );
    assert.equal(status, 204);
    assert.equal(
      calls[0]!.url,
      'https://api.github.com/repos/o/r/actions/workflows/update-viral-batch.yml/dispatches',
    );
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer tok');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { ref: 'main' });
  });

  it('throws with the GitHub error on a failed dispatch', async () => {
    const fake = (async () =>
      new Response('{"message":"Resource not accessible by personal access token"}', {
        status: 403,
      })) as unknown as typeof fetch;
    await assert.rejects(
      dispatchWorkflow('staleness-watchdog.yml', { GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' }, fake),
      /HTTP 403 .*not accessible/,
    );
  });
});
