/**
 * Sourcing policy check (see rssSources.ts): which AI companies a robots.txt blocks.
 *
 * A source is an AI opt-out when its robots.txt disallows the whole site ("/") for the
 * agents of two or more AI companies. Blocking one company usually reflects a deal or a
 * dispute with that company rather than a general "no AI use".
 */

/** Known AI agents (lower-case) by company. */
export const AI_AGENTS: Record<string, readonly string[]> = {
  OpenAI: ['gptbot', 'chatgpt-user', 'oai-searchbot'],
  Anthropic: ['claudebot', 'claude-user', 'claude-searchbot', 'claude-web', 'anthropic-ai'],
  Google: ['google-extended', 'gemini-deep-research', 'google-cloudvertexbot'],
  'Common Crawl': ['ccbot'],
  Perplexity: ['perplexitybot', 'perplexity-user'],
  ByteDance: ['bytespider'],
  Cohere: ['cohere-ai', 'cohere-training-data-crawler'],
  Amazon: ['amazonbot'],
  Meta: ['meta-externalagent'],
  Apple: ['applebot-extended'],
  Mistral: ['mistralai-user'],
  DeepSeek: ['deepseekbot'],
};

interface Group {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

/** robots.txt groups: consecutive User-agent lines share the rules that follow them. */
export function parseRobots(txt: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const m = raw
      .replace(/#.*/, '')
      .trim()
      .match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === 'allow' || key === 'disallow') && value)
        current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups;
}

/** Whether the robots.txt disallows the whole site for this agent (an explicit group only). */
export function blocksSite(groups: Group[], agent: string): boolean {
  const own = groups.filter((g) => g.agents.includes(agent));
  return (
    own.length > 0 &&
    own.some((g) => g.rules.some((r) => !r.allow && (r.path === '/' || r.path === '/*'))) &&
    !own.some((g) => g.rules.some((r) => r.allow && (r.path === '/' || r.path === '/*')))
  );
}

/** AI companies at least one of whose agents is blocked from the whole site. */
export function aiCompaniesBlocked(robotsTxt: string): string[] {
  const groups = parseRobots(robotsTxt);
  return Object.entries(AI_AGENTS)
    .filter(([, agents]) => agents.some((a) => blocksSite(groups, a)))
    .map(([company]) => company);
}

/** The policy: an opt-out blocks two or more AI companies. */
export const isAiOptOut = (companies: readonly string[]): boolean => companies.length >= 2;
