/**
 * Batch-side enforcement of publisher content policies (src/lib/publisherPolicy.ts).
 * Pure functions, so every rule is covered by scripts/lib/policy/contentPolicy.test.ts.
 */
import type { ViralClusterStaticRecord } from '../../../src/lib/types.ts';
import {
  hasDerivableCoverage,
  policyForDomain,
  type PolicyRegistries,
} from '../../../src/lib/publisherPolicy.ts';

const lookup = (domain: string, r: PolicyRegistries = {}) =>
  policyForDomain(domain, r.policies, r.removed);

/**
 * Right after fetching (RSS and GDELT alike): drop removed publishers and blank the snippet
 * of publishers that do not allow description text. The remaining fields are the four
 * permitted ones (publisher, headline, date, URL) plus routing metadata.
 */
export function applyIngestionPolicy<T extends { publisherDomain: string; snippet: string }>(
  articles: readonly T[],
  registries?: PolicyRegistries,
): T[] {
  return articles
    .filter((a) => {
      const p = lookup(a.publisherDomain, registries);
      return p.mode !== 'removed' && p.internalMatching;
    })
    .map((a) => (lookup(a.publisherDomain, registries).useDescription ? a : { ...a, snippet: '' }));
}

export interface PolicyCleanup {
  /** Stored stories with removed publishers' sources taken out. */
  kept: ViralClusterStaticRecord[];
  /** Stories left without publishable coverage (to retire → 301 to their country page). */
  unpublishable: ViralClusterStaticRecord[];
  /** Number of stored sources deleted. */
  removedSources: number;
}

/**
 * Apply removals and the exclusive-source rule to stored stories: sources from removed
 * publishers are deleted, and a story whose remaining coverage has no publishable publisher
 * (e.g. only a headline-only source) is withdrawn.
 */
export function cleanStoredStories(
  stories: readonly ViralClusterStaticRecord[],
  registries?: PolicyRegistries,
): PolicyCleanup {
  const kept: ViralClusterStaticRecord[] = [];
  const unpublishable: ViralClusterStaticRecord[] = [];
  let removedSources = 0;
  for (const story of stories) {
    const sources = story.sources.filter(
      (s) => lookup(s.publisherDomain, registries).mode !== 'removed',
    );
    removedSources += story.sources.length - sources.length;
    const cleaned = sources.length === story.sources.length ? story : { ...story, sources };
    if (sources.length > 0 && hasDerivableCoverage(sources, registries)) kept.push(cleaned);
    else unpublishable.push(cleaned);
  }
  return { kept, unpublishable, removedSources };
}
