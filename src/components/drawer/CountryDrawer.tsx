/**
 * Country Intelligence Drawer (plan §3.2 / FR-04). Opens when the map emits
 * `earthviral:country-select`, lazily fetches `/data/countries/[code].json`, and renders
 * a desktop side panel or a mobile bottom sheet. Every headline links to its static
 * SEO story page; every source links out to the original publisher.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CountryPayload } from '../../lib/types.ts';
import { CATEGORIES, TIER_META, flagEmoji } from '../../lib/taxonomy.ts';
import {
  COUNTRY_DESELECT_EVENT,
  COUNTRY_SELECT_EVENT,
  DRAWER_CLOSE_EVENT,
  type CountrySelectDetail,
} from '../map/events.ts';
import './drawer.css';

type LoadState =
  | { status: 'closed' }
  | { status: 'loading'; country: CountrySelectDetail }
  | { status: 'ready'; country: CountrySelectDetail; payload: CountryPayload }
  | { status: 'error'; country: CountrySelectDetail };

const cache = new Map<string, Promise<CountryPayload>>();

function loadCountry(code: string): Promise<CountryPayload> {
  const key = code.toLowerCase();
  let pending = cache.get(key);
  if (!pending) {
    pending = fetch(`/data/countries/${key}.json`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<CountryPayload>;
    });
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}

export default function CountryDrawer() {
  const [state, setState] = useState<LoadState>({ status: 'closed' });
  const [filter, setFilter] = useState<string>('all');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requestRef = useRef(0);

  const open = useCallback((country: CountrySelectDetail) => {
    const request = ++requestRef.current;
    setFilter('all');
    setState({ status: 'loading', country });
    loadCountry(country.code)
      .then((payload) => {
        if (request === requestRef.current) setState({ status: 'ready', country, payload });
      })
      .catch(() => {
        if (request === requestRef.current) setState({ status: 'error', country });
      });
  }, []);

  const close = useCallback((notifyMap: boolean) => {
    requestRef.current++;
    setState({ status: 'closed' });
    if (notifyMap) window.dispatchEvent(new CustomEvent(DRAWER_CLOSE_EVENT));
  }, []);

  useEffect(() => {
    const onSelect = (e: Event) => open((e as CustomEvent<CountrySelectDetail>).detail);
    const onDeselect = () => close(false);
    window.addEventListener(COUNTRY_SELECT_EVENT, onSelect);
    window.addEventListener(COUNTRY_DESELECT_EVENT, onDeselect);
    return () => {
      window.removeEventListener(COUNTRY_SELECT_EVENT, onSelect);
      window.removeEventListener(COUNTRY_DESELECT_EVENT, onDeselect);
    };
  }, [open, close]);

  const isOpen = state.status !== 'closed';

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  // Move focus into the panel when a country opens so keyboard and screen-reader users land on it.
  const openedCode = isOpen ? state.country.code : null;
  useEffect(() => {
    if (openedCode) headingRef.current?.focus({ preventScroll: true });
  }, [openedCode]);

  const payload = state.status === 'ready' ? state.payload : null;
  const categories = useMemo(
    () =>
      payload
        ? CATEGORIES.filter((c) => payload.clusters.some((cl) => cl.categorySlug === c.slug))
        : [],
    [payload],
  );
  const visible = payload
    ? payload.clusters.filter((c) => filter === 'all' || c.categorySlug === filter)
    : [];

  return (
    <aside
      className="ev-drawer glass"
      data-open={isOpen || undefined}
      aria-hidden={!isOpen}
      aria-labelledby="ev-drawer-title"
      inert={!isOpen}
    >
      {isOpen && (
        <div className="flex h-full flex-col">
          <div className="ev-drawer__handle lg:hidden" aria-hidden="true" />
          <header className="border-b border-line px-5 pt-4 pb-4">
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="text-3xl leading-none">
                {flagEmoji(state.country.code)}
              </span>
              <div className="min-w-0 flex-1">
                <h2
                  id="ev-drawer-title"
                  ref={headingRef}
                  tabIndex={-1}
                  className="font-display text-xl font-bold tracking-wide text-white uppercase outline-none"
                >
                  {state.country.name}
                </h2>
                {payload ? (
                  <p className="mt-1 text-sm text-ink-muted">
                    Viral Activity Score{' '}
                    <span className="tier-badge" data-tier={payload.intensityTier}>
                      {payload.viralScore}/100
                    </span>{' '}
                    <span className="text-ink-faint">
                      · {TIER_META[payload.intensityTier].label}
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 h-5 w-40 animate-pulse rounded bg-white/5" />
                )}
              </div>
              <button
                type="button"
                onClick={() => close(true)}
                className="-mr-1 rounded-lg p-1.5 text-ink-faint hover:bg-white/5 hover:text-white"
                aria-label={`Close ${state.country.name} panel`}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  className="size-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path d="m5 5 10 10M15 5 5 15" />
                </svg>
              </button>
            </div>
            <a
              href={`/country/${state.country.slug}/`}
              className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-cyan hover:underline"
            >
              Full {state.country.name} report <span aria-hidden="true">↗</span>
            </a>
          </header>

          <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-6">
            {state.status === 'error' && (
              <p className="mt-6 text-sm text-ink-muted">
                Couldn’t load this country’s stories.{' '}
                <button
                  type="button"
                  className="text-cyan underline"
                  onClick={() => open(state.country)}
                >
                  Try again
                </button>
              </p>
            )}

            {state.status === 'loading' && <DrawerSkeleton />}

            {payload && (
              <>
                <section aria-labelledby="ev-drawer-top" className="mt-4">
                  <h3
                    id="ev-drawer-top"
                    className="text-xs font-semibold tracking-widest text-ink-faint uppercase"
                  >
                    Top viral clusters
                  </h3>
                  <ol className="mt-2 flex flex-wrap gap-2">
                    {payload.clusters.slice(0, 3).map((c, i) => (
                      <li key={c.slug}>
                        <a
                          href={c.canonicalPath}
                          className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-ink hover:border-cyan/40"
                        >
                          <span className="tabular text-ink-faint">#{i + 1}</span>
                          <span className="truncate">{c.headline}</span>
                          <span className="tabular text-cyan">{c.viralScore}</span>
                        </a>
                      </li>
                    ))}
                  </ol>
                </section>

                {categories.length > 1 && (
                  <div
                    role="toolbar"
                    aria-label="Filter stories by category"
                    className="mt-5 flex flex-wrap gap-1.5"
                  >
                    {[{ slug: 'all', shortName: 'All' }, ...categories].map((c) => (
                      <button
                        key={c.slug}
                        type="button"
                        aria-pressed={filter === c.slug}
                        onClick={() => setFilter(c.slug)}
                        className="ev-drawer__chip"
                      >
                        {c.shortName}
                      </button>
                    ))}
                  </div>
                )}

                <ul className="mt-4 grid gap-3">
                  {visible.map((c) => (
                    <li key={c.slug}>
                      <article className="rounded-xl border border-line bg-void/40 p-4">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="rounded-full border border-line px-2 py-0.5 text-ink-muted">
                            {c.categoryName}
                          </span>
                          <span className="tier-badge ml-auto" data-tier={c.intensityTier}>
                            <span aria-hidden="true">🔥</span>
                            {c.viralScore}
                          </span>
                        </div>
                        <h4 className="mt-2 font-display leading-snug font-semibold text-white">
                          <a href={c.canonicalPath} className="hover:text-cyan">
                            {c.headline}
                          </a>
                        </h4>
                        <ul className="mt-2 grid gap-1 text-sm text-ink-muted">
                          {c.aiSummaryBullets.map((b) => (
                            <li key={b} className="flex gap-2">
                              <span
                                className="mt-2 size-1 shrink-0 rounded-full bg-cyan"
                                aria-hidden="true"
                              />
                              {b}
                            </li>
                          ))}
                        </ul>
                        {c.primarySource && (
                          <p className="mt-3 text-xs text-ink-faint">
                            Source:{' '}
                            <a
                              href={c.primarySource.articleUrl}
                              target="_blank"
                              rel="noopener"
                              className="text-ink-muted underline decoration-line hover:text-cyan"
                            >
                              {c.primarySource.publisherName}
                              <span aria-hidden="true"> ↗</span>
                              <span className="sr-only"> (opens in a new tab)</span>
                            </a>
                          </p>
                        )}
                      </article>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

function DrawerSkeleton() {
  return (
    <div className="mt-5 grid gap-3" aria-busy="true" aria-label="Loading stories">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-32 animate-pulse rounded-xl border border-line bg-white/[0.03]" />
      ))}
    </div>
  );
}
