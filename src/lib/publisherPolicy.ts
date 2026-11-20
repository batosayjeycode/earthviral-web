/**
 * Publisher-level content policies (EarthViral_Staging_Environment_PLAN.md Phase 4).
 *
 * Every article — from an RSS feed or from GDELT — is governed by the policy of its
 * publisher's domain. Most publishers use STANDARD_POLICY. A publisher that licensed only
 * its headlines (Joho no Todai) uses HEADLINE_ONLY_POLICY, enforced at every stage:
 *
 *   ingestion   description / content / image fields are never read (fetchRss.ts) and the
 *               snippet is blanked for any channel (applyIngestionPolicy)
 *   AI + text   its articles are removed from summary input before any AI payload or
 *               non-AI fallback text is built (derivableArticles); the payload builders
 *               throw if one slips through (assertDerivable)
 *   grouping    allowed: non-AI TF-IDF clustering and publisher counting
 *   publishing  a story needs ≥ 1 derivable publisher (hasDerivableCoverage); the restricted
 *               headline is shown only as an attributed source link next to other publishers
 *               (displayableSources) and kept out of search, structured data and feeds
 *
 * Removal requests: add the domain to REMOVED_PUBLISHERS (and delete its RSS source). Its
 * sources disappear from the next build, the next batch drops them from stored data, and
 * `npm run remove:publisher -- <domain>` purges stored data immediately.
 *
 * This module is plain TypeScript (no Astro imports): the batch scripts and the site share it.
 */

export type PolicyMode = 'standard' | 'headline_only' | 'removed';

export interface ContentPolicy {
  mode: PolicyMode;
  /** Read RSS description / content / summary text (used only as LLM context). */
  useDescription: boolean;
  /** Include in any AI-provider request (summaries, translation, classification). */
  sendToAiProvider: boolean;
  /** Use in EarthViral-written text, including non-AI fallback summaries and headlines. */
  useInGeneratedText: boolean;
  /** Non-AI story matching (TF-IDF clustering) and coverage (publisher) counting. */
  internalMatching: boolean;
  /** Where the original headline may appear on the site. */
  displayHeadline: 'always' | 'with-other-publishers' | 'never';
  /** Publish a story whose only coverage comes from this publisher. */
  publishIfExclusiveSource: boolean;
  /** Include headline / URL in downstream outputs: search index, structured data, feeds. */
  downstreamRedistribution: boolean;
}

export const STANDARD_POLICY: ContentPolicy = Object.freeze({
  mode: 'standard',
  useDescription: true,
  sendToAiProvider: true,
  useInGeneratedText: true,
  internalMatching: true,
  displayHeadline: 'always',
  publishIfExclusiveSource: true,
  downstreamRedistribution: true,
});

/**
 * Only publisher name, original headline, publication date and article URL are used; no
 * article bodies are ever fetched (EarthViral never fetches article pages for any source).
 */
export const HEADLINE_ONLY_POLICY: ContentPolicy = Object.freeze({
  mode: 'headline_only',
  useDescription: false,
  sendToAiProvider: false,
  useInGeneratedText: false,
  internalMatching: true,
  displayHeadline: 'with-other-publishers',
  publishIfExclusiveSource: false,
  downstreamRedistribution: false,
});

/** Applied to publishers in REMOVED_PUBLISHERS: dropped everywhere. */
export const REMOVED_POLICY: ContentPolicy = Object.freeze({
  mode: 'removed',
  useDescription: false,
  sendToAiProvider: false,
  useInGeneratedText: false,
  internalMatching: false,
  displayHeadline: 'never',
  publishIfExclusiveSource: false,
  downstreamRedistribution: false,
});

export interface PublisherPolicyEntry {
  /** Registrable domain; subdomains (en.example.com) are covered too. */
  publisherDomain: string;
  publisherName: string;
  policy: ContentPolicy;
  /** Where the agreed terms are recorded (auditable record of policy changes). */
  terms: string;
}

/** Publishers with a non-standard policy. Changes here need engineering review. */
export const PUBLISHER_POLICIES: readonly PublisherPolicyEntry[] = [
  {
    publisherDomain: 'joho-todai.com',
    publisherName: 'Joho no Todai',
    policy: HEADLINE_ONLY_POLICY,
    terms:
      'Headline-only review terms agreed by email; see EarthViral_Staging_Environment_PLAN.md §1 and §7.',
  },
];

export interface RemovedPublisher {
  publisherDomain: string;
  /** ISO date the removal request was actioned. */
  removedAt: string;
  reason: string;
}

/** Publishers whose content must be removed from active systems and public displays. */
export const REMOVED_PUBLISHERS: readonly RemovedPublisher[] = [];

const normalize = (domain: string) =>
  domain
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');

const matches = (domain: string, entry: string) => domain === entry || domain.endsWith(`.${entry}`);

/**
 * Policy for a publisher domain. Lookups take explicit registries (defaulting to the ones
 * above) so tests can exercise removal without editing the live configuration.
 */
export function policyForDomain(
  domain: string,
  policies: readonly PublisherPolicyEntry[] = PUBLISHER_POLICIES,
  removed: readonly RemovedPublisher[] = REMOVED_PUBLISHERS,
): ContentPolicy {
  const d = normalize(domain);
  if (removed.some((r) => matches(d, normalize(r.publisherDomain)))) return REMOVED_POLICY;
  return policies.find((p) => matches(d, normalize(p.publisherDomain)))?.policy ?? STANDARD_POLICY;
}

export interface PolicyRegistries {
  policies?: readonly PublisherPolicyEntry[];
  removed?: readonly RemovedPublisher[];
}

const lookup = (domain: string, r: PolicyRegistries = {}) =>
  policyForDomain(domain, r.policies, r.removed);

/** Articles whose content may go to an AI provider and into EarthViral-written text. */
export function derivableArticles<T extends { publisherDomain: string }>(
  articles: readonly T[],
  registries?: PolicyRegistries,
): T[] {
  return articles.filter((a) => {
    const p = lookup(a.publisherDomain, registries);
    return p.sendToAiProvider && p.useInGeneratedText;
  });
}

/**
 * A story may be published only when at least one publisher that allows exclusive
 * publication covers it (so a story is never sourced only from a headline-only publisher).
 */
export function hasDerivableCoverage(
  articles: readonly { publisherDomain: string }[],
  registries?: PolicyRegistries,
): boolean {
  return articles.some((a) => {
    const p = lookup(a.publisherDomain, registries);
    return p.publishIfExclusiveSource && p.useInGeneratedText;
  });
}

export class ContentPolicyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentPolicyViolation';
  }
}

/**
 * Fail-closed guard for AI payloads and generated text: throws if any article comes from a
 * publisher that does not allow it. Called by the payload builders themselves, so a bug
 * upstream cannot leak restricted headlines to a provider.
 */
export function assertDerivable(
  articles: readonly { publisherDomain: string }[],
  context: string,
  registries?: PolicyRegistries,
): void {
  const blocked = articles.filter((a) => {
    const p = lookup(a.publisherDomain, registries);
    return !p.sendToAiProvider || !p.useInGeneratedText;
  });
  if (blocked.length > 0) {
    const domains = [...new Set(blocked.map((a) => a.publisherDomain))].join(', ');
    throw new ContentPolicyViolation(
      `${context}: content from ${domains} must not be used (publisher content policy)`,
    );
  }
}

export interface PolicySource {
  publisherDomain: string;
}

/**
 * Sources that may be shown on a story page: removed publishers are dropped, and a
 * "with-other-publishers" source is shown only beside at least one standard source.
 */
export function displayableSources<T extends PolicySource>(
  sources: readonly T[],
  registries?: PolicyRegistries,
): T[] {
  const kept = sources.filter((s) => lookup(s.publisherDomain, registries).mode !== 'removed');
  const hasOther = kept.some(
    (s) => lookup(s.publisherDomain, registries).displayHeadline === 'always',
  );
  return kept.filter((s) => {
    const shown = lookup(s.publisherDomain, registries).displayHeadline;
    return shown === 'always' || (shown === 'with-other-publishers' && hasOther);
  });
}

/** Sources whose headline / URL may go into downstream outputs (search, JSON-LD, feeds). */
export function redistributableSources<T extends PolicySource>(
  sources: readonly T[],
  registries?: PolicyRegistries,
): T[] {
  return sources.filter((s) => lookup(s.publisherDomain, registries).downstreamRedistribution);
}

export const isRestricted = (domain: string, registries?: PolicyRegistries) =>
  lookup(domain, registries).mode !== 'standard';

/**
 * Exception to the AI opt-out sourcing rule (scripts/lib/fetchers/rssSources.ts): a publisher
 * with a recorded agreement whose policy keeps its content out of every AI use. The rule exists
 * to respect "no AI use" signals; such a source is never sent to an AI provider nor used in
 * generated text, so its robots.txt AI blocks don't disqualify it. Returns the agreed terms, or
 * null when the rule applies normally. Removed publishers are never exempt.
 */
export function aiOptOutExemption(
  domain: string,
  policies: readonly PublisherPolicyEntry[] = PUBLISHER_POLICIES,
  removed: readonly RemovedPublisher[] = REMOVED_PUBLISHERS,
): string | null {
  const d = normalize(domain);
  if (removed.some((r) => matches(d, normalize(r.publisherDomain)))) return null;
  const entry = policies.find((p) => matches(d, normalize(p.publisherDomain)));
  return entry &&
    entry.terms.trim() &&
    !entry.policy.sendToAiProvider &&
    !entry.policy.useInGeneratedText
    ? entry.terms
    : null;
}
