/**
 * Homepage map island (plan §5). MapLibre is imported lazily after hydration so the
 * island's initial bundle stays tiny; the static silhouette covers first paint.
 *
 * Talks to the Country Intelligence Drawer through window events (see ./events.ts).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FeatureCollection, Geometry } from 'geojson';
import type { LngLatLike, Map as MLMap, Marker as MLMarker, StyleSpecification } from 'maplibre-gl';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { IntensityTier } from '../../lib/taxonomy.ts';
import { TIER_META, flagEmoji } from '../../lib/taxonomy.ts';
import type { MapPulse } from '../../lib/types.ts';
import { INITIAL_CENTER, globeZoomForHeight, mercatorZoomForWidth } from './mapConfig.ts';
import {
  COUNTRY_DESELECT_EVENT,
  COUNTRY_SELECT_EVENT,
  DESKTOP_QUERY,
  DRAWER_CLOSE_EVENT,
  DRAWER_WIDTH_PX,
  type CountrySelectDetail,
} from './events.ts';
import './map.css';

type PulseCountry = MapPulse['countries'][number];
type ProjectionMode = 'globe' | 'mercator';

interface Props {
  pulseUrl: string;
  topoUrl: string;
}

interface TooltipState {
  /** Country with batch data, or null for a quiet country (name only). */
  country: PulseCountry | null;
  name: string;
  lngLat: [number, number];
  x: number;
  y: number;
  pinned: boolean;
}

const COLORS = {
  ocean: '#070D19',
  land: '#0F172A',
  quiet: '#0B101E',
  border: '#1E293B',
  hover: '#1A2742',
  cyan: '#00F0FF',
  surge: '#A855F7',
};

const TIER_FILL: Record<IntensityTier, string> = {
  quiet: COLORS.quiet,
  active: '#0C2333',
  high: '#0B2A4A',
  surge: '#24124A',
};

const SPIN_DEG_PER_SEC = 2;
const SPIN_RESUME_MS = 10_000;

function buildStyle(
  countries: FeatureCollection<Geometry>,
  projection: ProjectionMode,
): StyleSpecification {
  return {
    version: 8,
    projection: { type: projection },
    sources: {
      countries: { type: 'geojson', data: countries, attribution: 'Natural Earth' },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': COLORS.ocean } },
      {
        id: 'countries-fill',
        type: 'fill',
        source: 'countries',
        paint: {
          'fill-color': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            COLORS.hover,
            [
              'match',
              ['get', 'tier'],
              'surge',
              TIER_FILL.surge,
              'high',
              TIER_FILL.high,
              'active',
              TIER_FILL.active,
              'quiet',
              TIER_FILL.quiet,
              COLORS.land,
            ],
          ],
        },
      },
      {
        id: 'surge-glow',
        type: 'line',
        source: 'countries',
        filter: ['==', ['get', 'tier'], 'surge'],
        paint: {
          'line-color': COLORS.surge,
          'line-width': 4,
          'line-blur': 4,
          'line-opacity': 0.55,
        },
      },
      {
        id: 'countries-border',
        type: 'line',
        source: 'countries',
        paint: { 'line-color': COLORS.border, 'line-width': 0.6 },
      },
      {
        id: 'countries-selected',
        type: 'line',
        source: 'countries',
        paint: {
          'line-color': COLORS.cyan,
          'line-width': 1.6,
          'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
        },
      },
    ],
  };
}

const ANTARCTICA_ISO = '010';

/**
 * Natural Earth rings that cross the antimeridian (Fiji, Chukotka) jump from +180° to −180°,
 * which the globe renders as a line wrapped around the planet. Shift longitudes so each ring
 * is continuous (e.g. 177° … 181°); MapLibre wraps out-of-range longitudes correctly.
 */
function unwrapAntimeridian(geometry: Geometry) {
  const unwrapRing = (ring: number[][]) => {
    for (let i = 1; i < ring.length; i++) {
      const prev = ring[i - 1]![0]!;
      const point = ring[i]!;
      while (point[0]! - prev > 180) point[0]! -= 360;
      while (point[0]! - prev < -180) point[0]! += 360;
    }
  };
  if (geometry.type === 'Polygon') geometry.coordinates.forEach(unwrapRing);
  else if (geometry.type === 'MultiPolygon')
    geometry.coordinates.forEach((poly) => poly.forEach(unwrapRing));
}

// ── Start mode ──────────────────────────────────────────────────────────────
// MapLibre is ~1.1 MB of JS; on a mid-range phone parsing it blocks the main thread for
// seconds. Fine pointers (desktops) start the map when the browser is idle; touch devices
// and data-saver keep the static globe until the first tap/keypress. Opening at #map starts
// eagerly. Read via useSyncExternalStore so it is derived, not set inside an effect.
type StartMode = 'eager' | 'deferred';
function getStartMode(): StartMode {
  const saveData =
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
    true;
  const fine = window.matchMedia('(pointer: fine)').matches;
  return (fine && !saveData) || window.location.hash === '#map' ? 'eager' : 'deferred';
}
function subscribeStartMode(onChange: () => void) {
  const mq = window.matchMedia('(pointer: fine)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const serverStartMode = (): StartMode => 'eager';

function beaconElement(country: PulseCountry): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'ev-beacon';
  el.dataset.tier = country.intensityTier;
  el.setAttribute(
    'aria-label',
    `${country.name}: viral score ${country.viralScore}, ${TIER_META[country.intensityTier].label}`,
  );
  const rings = country.intensityTier === 'surge' ? 2 : country.intensityTier === 'high' ? 1 : 0;
  let html = '';
  for (let i = 0; i < rings; i++)
    html += `<span class="ev-beacon__ring" style="--ring-delay:${i * 0.9}s"></span>`;
  html += '<span class="ev-beacon__core"></span>';
  if (country.intensityTier === 'surge') {
    html += `<span class="ev-beacon__pill" aria-hidden="true">${flagEmoji(country.code)} ${country.viralScore}</span>`;
  } else if (country.intensityTier === 'high') {
    html += `<span class="ev-beacon__pill ev-beacon__pill--compact" aria-hidden="true">${country.viralScore}</span>`;
  }
  el.innerHTML = html;
  return el;
}

export default function WorldMap({ pulseUrl, topoUrl }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [projection, setProjection] = useState<ProjectionMode>('globe');
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  // idle: not started yet (deferred devices wait for a tap; see the start gate below)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const startMode = useSyncExternalStore(subscribeStartMode, getStartMode, serverStartMode);
  const awaitingTap = status === 'idle' && startMode === 'deferred';
  const [size, setSize] = useState({ width: 0, height: 0 });
  const startRef = useRef<() => void>(() => {});

  // Hero size for tooltip clamping, kept in state so render never reads refs.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // Mutable interaction state shared by MapLibre callbacks (avoids stale closures).
  const live = useRef({
    projection: 'globe' as ProjectionMode,
    visible: true,
    interacting: false,
    selectedId: null as number | null,
    hoverId: null as number | null,
    pinned: false,
    resumeTimer: 0 as ReturnType<typeof setTimeout> | 0,
    reducedMotion: false,
    spin: () => {},
  });

  useEffect(() => {
    const containerEl = containerRef.current;
    const rootEl = rootRef.current;
    if (!containerEl || !rootEl) return;
    const container: HTMLDivElement = containerEl;
    const root: HTMLDivElement = rootEl;

    let disposed = false;
    const markers: MLMarker[] = [];
    const cleanups: Array<() => void> = [];
    const state = live.current;
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    state.reducedMotion = motionQuery.matches;

    async function init() {
      const [maplibre, topo, pulse, topojson, workerUrl] = await Promise.all([
        import('maplibre-gl'),
        fetch(topoUrl).then(
          (r) => r.json() as Promise<Topology<{ countries: GeometryCollection }>>,
        ),
        fetch(pulseUrl).then((r) => r.json() as Promise<MapPulse>),
        import('topojson-client'),
        // MapLibre 6 resolves its worker relative to its own module URL, which breaks once Vite
        // bundles it. Emit the self-contained worker as a static asset and point MapLibre at it.
        import('maplibre-gl/dist/maplibre-gl-worker.mjs?url').then((m) => m.default),
        import('maplibre-gl/dist/maplibre-gl.css'),
      ]);
      if (disposed) return;
      maplibre.setWorkerUrl(workerUrl);

      const pulseByIso = new Map(pulse.countries.map((c) => [c.isoNumeric, c]));
      const countries = topojson.feature(
        topo,
        topo.objects.countries,
      ) as FeatureCollection<Geometry>;
      countries.features.forEach((f, i) => {
        const iso = typeof f.id === 'string' ? f.id : '';
        const data = pulseByIso.get(iso);
        f.id = iso ? Number(iso) : 900_000 + i;
        f.properties = { ...f.properties, iso, tier: data?.intensityTier ?? 'none' };
      });
      countries.features.forEach((f) => {
        if (f.properties?.iso !== ANTARCTICA_ISO) unwrapAntimeridian(f.geometry);
      });
      const featureByIso = new Map(countries.features.map((f) => [f.properties?.iso as string, f]));

      const height = container.clientHeight;
      const map = new maplibre.Map({
        container,
        style: buildStyle(countries, 'globe'),
        center: INITIAL_CENTER,
        zoom: globeZoomForHeight(height),
        minZoom: 0,
        maxZoom: 6,
        attributionControl: { compact: true },
        cooperativeGestures: window.matchMedia('(pointer: coarse)').matches,
        renderWorldCopies: false,
      });
      mapRef.current = map;

      // ── Tooltip helpers ───────────────────────────────────────────────────
      const showTooltip = (
        country: PulseCountry | null,
        name: string,
        lngLat: [number, number],
        pinned: boolean,
      ) => {
        const p = map.project(lngLat);
        state.pinned = pinned;
        setTooltip({ country, name, lngLat, x: p.x, y: p.y, pinned });
      };
      const hideTooltip = () => {
        if (state.pinned) return;
        setTooltip(null);
      };

      const setFeatureFlag = (id: number | null, key: 'hover' | 'selected', value: boolean) => {
        if (id !== null) map.setFeatureState({ source: 'countries', id }, { [key]: value });
      };

      const select = (iso: string, fallbackName: string, at: [number, number]) => {
        const data = pulseByIso.get(iso) ?? null;
        const feature = featureByIso.get(iso);
        const id = (feature?.id as number | undefined) ?? null;
        setFeatureFlag(state.selectedId, 'selected', false);
        state.selectedId = id;
        setFeatureFlag(id, 'selected', true);

        const target: [number, number] = data?.centroid ?? at;
        const zoom = Math.max(
          map.getZoom(),
          state.projection === 'globe' ? globeZoomForHeight(container.clientHeight) + 0.4 : 2.5,
        );
        // Countries with data open the Country Intelligence Drawer; on desktop it covers the
        // right edge, so offset the camera to keep the country centred in the visible area.
        const drawerOpens = data !== null;
        const padding =
          drawerOpens && window.matchMedia(DESKTOP_QUERY).matches
            ? { right: DRAWER_WIDTH_PX }
            : undefined;
        stopSpin();
        if (state.reducedMotion) map.jumpTo({ center: target, zoom, padding });
        else map.flyTo({ center: target, zoom, padding, speed: 0.9, curve: 1.3, essential: false });

        if (data) {
          state.pinned = false;
          setTooltip(null);
          window.dispatchEvent(
            new CustomEvent<CountrySelectDetail>(COUNTRY_SELECT_EVENT, {
              detail: { code: data.code, slug: data.slug, name: data.name },
            }),
          );
        } else {
          showTooltip(null, fallbackName, target, true);
        }
      };

      // Back to the overview after a selection. `select` flies in with drawer padding, and
      // MapLibre keeps padding on the camera after the move, so it must be cleared explicitly
      // or the globe stays shifted left (and zoomed in) once the drawer has closed.
      const resetView = () => {
        const globe = state.projection === 'globe';
        const zoom = globe
          ? globeZoomForHeight(container.clientHeight)
          : mercatorZoomForWidth(container.clientWidth);
        // Globe: keep the longitude the user was looking at. Map: same framing as switchProjection.
        const center: [number, number] = globe
          ? [map.getCenter().lng, INITIAL_CENTER[1]]
          : [INITIAL_CENTER[0], 15];
        const padding = { top: 0, right: 0, bottom: 0, left: 0 };
        if (state.reducedMotion) map.jumpTo({ center, zoom, padding });
        else map.easeTo({ center, zoom, padding, duration: 800, essential: false });
      };

      const clearSelection = (notify = true) => {
        const hadSelection = state.selectedId !== null;
        if (notify && hadSelection) window.dispatchEvent(new CustomEvent(COUNTRY_DESELECT_EVENT));
        setFeatureFlag(state.selectedId, 'selected', false);
        state.selectedId = null;
        state.pinned = false;
        setTooltip(null);
        if (hadSelection) {
          stopSpin();
          resetView();
        }
        scheduleSpin();
      };

      // ── Auto-rotation (globe only, honours reduced motion + visibility) ───
      const canSpin = () =>
        state.projection === 'globe' &&
        !state.reducedMotion &&
        state.visible &&
        !document.hidden &&
        !state.interacting &&
        state.selectedId === null;

      const spin = () => {
        if (!canSpin()) return;
        const center = map.getCenter();
        center.lng -= SPIN_DEG_PER_SEC * 2;
        map.easeTo({ center, duration: 2000, easing: (t) => t });
      };
      state.spin = spin;

      function stopSpin() {
        if (state.resumeTimer) clearTimeout(state.resumeTimer);
        state.resumeTimer = 0;
        map.stop();
      }
      function scheduleSpin() {
        if (state.resumeTimer) clearTimeout(state.resumeTimer);
        state.resumeTimer = setTimeout(() => {
          state.interacting = false;
          spin();
        }, SPIN_RESUME_MS);
      }

      map.on('moveend', spin);
      const onInteractStart = () => {
        state.interacting = true;
        stopSpin();
      };
      map.on('mousedown', onInteractStart);
      map.on('touchstart', onInteractStart);
      map.on('wheel', onInteractStart);
      map.on('dragend', scheduleSpin);
      map.on('touchend', scheduleSpin);
      map.on('mouseup', scheduleSpin);

      // Keep a pinned tooltip glued to its country while the camera moves.
      map.on('move', () => {
        setTooltip((t) => {
          if (!t) return t;
          const p = map.project(t.lngLat);
          return { ...t, x: p.x, y: p.y };
        });
      });

      // ── Country polygons: hover + click ───────────────────────────────────
      map.on('mousemove', 'countries-fill', (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const id = f.id as number;
        if (state.hoverId !== id) {
          setFeatureFlag(state.hoverId, 'hover', false);
          state.hoverId = id;
          setFeatureFlag(id, 'hover', true);
        }
        map.getCanvas().style.cursor = 'pointer';
        if (state.pinned) return;
        const iso = f.properties?.iso as string;
        const name = (f.properties?.name as string) ?? 'Unknown';
        const data = pulseByIso.get(iso) ?? null;
        setTooltip({
          country: data,
          name: data?.name ?? name,
          lngLat: [e.lngLat.lng, e.lngLat.lat],
          x: e.point.x,
          y: e.point.y,
          pinned: false,
        });
      });
      map.on('mouseleave', 'countries-fill', () => {
        setFeatureFlag(state.hoverId, 'hover', false);
        state.hoverId = null;
        map.getCanvas().style.cursor = '';
        hideTooltip();
      });
      map.on('click', (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ['countries-fill'] })[0];
        if (!f) {
          clearSelection();
          return;
        }
        select(f.properties?.iso as string, (f.properties?.name as string) ?? 'Unknown', [
          e.lngLat.lng,
          e.lngLat.lat,
        ]);
      });

      // ── Beacons (HTML markers; CSS-animated, paused off-screen) ──────────
      for (const country of pulse.countries) {
        if (country.intensityTier === 'quiet') continue;
        const el = beaconElement(country);
        const at = country.centroid as LngLatLike;
        el.addEventListener(
          'mouseenter',
          () => !state.pinned && showTooltip(country, country.name, country.centroid, false),
        );
        el.addEventListener('mouseleave', hideTooltip);
        el.addEventListener(
          'focus',
          () => !state.pinned && showTooltip(country, country.name, country.centroid, false),
        );
        el.addEventListener('blur', hideTooltip);
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          select(country.isoNumeric, country.name, country.centroid);
        });
        markers.push(
          new maplibre.Marker({ element: el, anchor: 'center' }).setLngLat(at).addTo(map),
        );
      }

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && state.selectedId !== null) clearSelection();
      };
      window.addEventListener('keydown', onKey);
      cleanups.push(() => window.removeEventListener('keydown', onKey));

      // The drawer was closed by the user: drop the highlight without echoing an event back.
      const onDrawerClose = () => {
        if (state.selectedId !== null) clearSelection(false);
      };
      window.addEventListener(DRAWER_CLOSE_EVENT, onDrawerClose);
      cleanups.push(() => window.removeEventListener(DRAWER_CLOSE_EVENT, onDrawerClose));

      map.once('load', () => {
        if (disposed) return;
        setStatus('ready');
        root.closest<HTMLElement>('[data-map-hero]')?.setAttribute('data-map-ready', '');
        spin();
      });
    }

    // ── Pause work when the hero is off-screen or the tab is hidden ───────
    const applyActivity = () => {
      const active = state.visible && !document.hidden;
      root.classList.toggle('ev-paused', !active);
      if (!active) mapRef.current?.stop();
      else state.spin();
    };
    const io = new IntersectionObserver(([entry]) => {
      state.visible = entry?.isIntersecting ?? true;
      applyActivity();
    });
    io.observe(root);
    document.addEventListener('visibilitychange', applyActivity);
    const onMotionChange = (e: MediaQueryListEvent) => {
      state.reducedMotion = e.matches;
      if (e.matches) mapRef.current?.stop();
      else state.spin();
    };
    motionQuery.addEventListener('change', onMotionChange);

    // ── Start gate (see getStartMode) ─────────────────────────────────────
    let started = false;
    const removeTriggers: Array<() => void> = [];
    const start = () => {
      if (started || disposed) return;
      started = true;
      removeTriggers.forEach((fn) => fn());
      setStatus('loading');
      init().catch((err: unknown) => {
        console.error('[EarthViral] map failed to initialise', err);
        if (!disposed) setStatus('error');
      });
    };
    startRef.current = start;

    if (getStartMode() === 'eager') {
      if ('requestIdleCallback' in window) {
        const id = window.requestIdleCallback(start, { timeout: 2500 });
        removeTriggers.push(() => window.cancelIdleCallback(id));
      } else {
        const id = setTimeout(start, 1200);
        removeTriggers.push(() => clearTimeout(id));
      }
    } else {
      const hero = root.closest<HTMLElement>('[data-map-hero]') ?? root;
      const listen = (target: EventTarget, type: string) => {
        target.addEventListener(type, start, { once: true, passive: true });
        removeTriggers.push(() => target.removeEventListener(type, start));
      };
      listen(hero, 'pointerdown');
      listen(window, 'keydown');
      listen(window, 'hashchange');
    }
    cleanups.push(() => removeTriggers.forEach((fn) => fn()));

    return () => {
      disposed = true;
      io.disconnect();
      document.removeEventListener('visibilitychange', applyActivity);
      motionQuery.removeEventListener('change', onMotionChange);
      if (state.resumeTimer) clearTimeout(state.resumeTimer);
      cleanups.forEach((fn) => fn());
      markers.forEach((m) => m.remove());
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [pulseUrl, topoUrl]);

  const switchProjection = useCallback((mode: ProjectionMode) => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container || live.current.projection === mode) return;
    live.current.projection = mode;
    setProjection(mode);
    map.stop();
    map.setProjection({ type: mode });
    const zoom =
      mode === 'globe'
        ? globeZoomForHeight(container.clientHeight)
        : mercatorZoomForWidth(container.clientWidth);
    map.jumpTo({ zoom, center: mode === 'globe' ? map.getCenter() : [INITIAL_CENTER[0], 15] });
    if (mode === 'globe') live.current.spin();
  }, []);

  return (
    <div ref={rootRef} className="ev-map absolute inset-0">
      <div
        ref={containerRef}
        className="transition-opacity duration-700"
        // Inline positioning: maplibre-gl.css sets `.maplibregl-map { position: relative }`,
        // which would override a utility class and collapse the canvas to its 300px default.
        style={{ position: 'absolute', inset: 0, opacity: status === 'ready' ? 1 : 0 }}
        role="region"
        aria-label="Interactive world map of viral news activity"
      />

      {awaitingTap && (
        <button
          type="button"
          onClick={() => startRef.current()}
          className="glass absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-semibold whitespace-nowrap text-cyan sm:bottom-1/2"
        >
          Tap to explore the live map
        </button>
      )}

      {status !== 'error' && !awaitingTap && (
        <div
          role="group"
          aria-label="Map view mode"
          className="glass absolute right-4 bottom-12 z-10 flex rounded-lg p-1 text-xs sm:top-6 sm:right-6 sm:bottom-auto"
        >
          {(['globe', 'mercator'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={projection === mode}
              disabled={status !== 'ready'}
              onClick={() => switchProjection(mode)}
              className={`rounded-md px-3 py-1.5 font-medium transition ${
                projection === mode ? 'bg-cyan/15 text-cyan' : 'text-ink-muted hover:text-white'
              }`}
            >
              {mode === 'globe' ? '3D Globe' : '2D Map'}
            </button>
          ))}
        </div>
      )}

      {status === 'error' && (
        <p className="glass absolute top-4 right-4 z-10 rounded-lg px-3 py-2 text-xs text-ink-muted sm:top-6 sm:right-6">
          Interactive map unavailable on this device — browse the stories below.
        </p>
      )}

      {tooltip && (
        <MapTooltip
          tooltip={tooltip}
          bounds={size}
          onClose={() => {
            live.current.pinned = false;
            setTooltip(null);
          }}
        />
      )}
    </div>
  );
}

const TOOLTIP_HALF_WIDTH = 128;
const TOOLTIP_FLIP_Y = 180;

function MapTooltip({
  tooltip,
  bounds,
  onClose,
}: {
  tooltip: TooltipState;
  bounds: { width: number; height: number };
  onClose: () => void;
}) {
  const { country, name, y, pinned } = tooltip;
  // Keep the card inside the hero: clamp horizontally, flip below the point near the top edge.
  const x = Math.min(
    Math.max(tooltip.x, TOOLTIP_HALF_WIDTH + 8),
    Math.max(TOOLTIP_HALF_WIDTH + 8, bounds.width - TOOLTIP_HALF_WIDTH - 8),
  );
  const below = y < TOOLTIP_FLIP_Y;
  return (
    <div
      role={pinned ? 'dialog' : 'tooltip'}
      aria-label={pinned ? `${name} viral summary` : undefined}
      className={`glass ev-tooltip absolute z-20 w-64 rounded-xl p-3 text-sm shadow-2xl ${pinned ? 'pointer-events-auto' : 'pointer-events-none'}`}
      data-placement={below ? 'below' : 'above'}
      style={{ left: x, top: y }}
    >
      <div className="flex items-center gap-2">
        {country && (
          <span aria-hidden="true" className="text-lg leading-none">
            {flagEmoji(country.code)}
          </span>
        )}
        <p className="font-display font-semibold text-white">{name}</p>
        {country && (
          <span className="tier-badge ml-auto" data-tier={country.intensityTier}>
            {country.viralScore}
          </span>
        )}
        {pinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`${country ? '' : 'ml-auto '}rounded p-0.5 text-ink-faint hover:text-white`}
          >
            ✕
          </button>
        )}
      </div>
      {country ? (
        <>
          <p className="mt-1 text-xs text-ink-muted">
            {TIER_META[country.intensityTier].label} · {country.topicCount} viral{' '}
            {country.topicCount === 1 ? 'topic' : 'topics'}
          </p>
          {country.topTopic && (
            <p className="mt-2 text-xs leading-snug text-ink">
              <span className="text-ink-faint">Top: </span>
              {pinned ? (
                <a
                  className="underline decoration-cyan/40 hover:text-cyan"
                  href={country.topTopic.canonicalPath}
                >
                  {country.topTopic.headline}
                </a>
              ) : (
                country.topTopic.headline
              )}
            </p>
          )}
          {pinned && (
            <a
              className="mt-3 inline-block text-xs font-semibold text-cyan hover:underline"
              href={`/country/${country.slug}/`}
            >
              Full country report ↗
            </a>
          )}
        </>
      ) : (
        <p className="mt-1 text-xs text-ink-muted">No viral clusters detected in this batch.</p>
      )}
    </div>
  );
}
