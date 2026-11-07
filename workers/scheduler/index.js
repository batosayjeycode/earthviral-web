/**
 * EarthViral scheduler (Cloudflare Worker, cron triggers only — no public HTTP endpoint).
 *
 * GitHub's `schedule` trigger never fired for this repository, so this Worker starts the
 * workflows through the "create a workflow dispatch event" API instead — the same thing as
 * clicking "Run workflow". The workflows' own `schedule` triggers stay as a backup; the
 * batch workflow skips a scheduled run if a batch already ran in the last 2 hours.
 *
 * Secrets: GITHUB_TOKEN — fine-grained PAT limited to this repository with
 * "Actions: Read and write". Vars (wrangler.toml): GITHUB_REPO, GITHUB_REF.
 */

/** Cron expression (as in wrangler.toml) → workflow file to dispatch. */
export const SCHEDULE = {
  '17 2-23/3 * * *': 'update-viral-batch.yml',
  '41 * * * *': 'staleness-watchdog.yml',
};

/** @param {string} cron */
export function workflowForCron(cron) {
  return SCHEDULE[cron] ?? null;
}

/**
 * @param {string} workflow
 * @param {{ GITHUB_TOKEN: string, GITHUB_REPO: string, GITHUB_REF?: string }} env
 * @param {typeof fetch} [fetchImpl]
 */
export async function dispatchWorkflow(workflow, env, fetchImpl = fetch) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'earthviral-scheduler',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || 'main' }),
  });
  // 204 No Content on success; anything else is logged (visible in Workers → Logs).
  if (res.status !== 204) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`GitHub dispatch of ${workflow} failed: HTTP ${res.status} ${body}`);
  }
  return res.status;
}

export default {
  /** @param {{ cron: string }} event @param {any} env */
  async scheduled(event, env) {
    const workflow = workflowForCron(event.cron);
    if (!workflow) {
      console.error(`No workflow configured for cron "${event.cron}"`);
      return;
    }
    if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN secret is not set');
    await dispatchWorkflow(workflow, env);
    console.log(`Dispatched ${workflow} on ${env.GITHUB_REF || 'main'} (cron ${event.cron})`);
  },
};
