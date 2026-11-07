/** Shared between the static silhouette and the MapLibre island so the hand-off is seamless. */

/** Globe centre on first paint — frames Southeast Asia (launch market) plus India and Australia. */
export const INITIAL_CENTER: [number, number] = [112, 2];

/** Globe diameter as a fraction of the hero height. */
export const GLOBE_DIAMETER_RATIO = 0.78;

/** MapLibre tile size; world size in px at zoom z is TILE_SIZE * 2^z. */
const TILE_SIZE = 512;

/** Zoom at which the globe's diameter equals `GLOBE_DIAMETER_RATIO * heightPx`. */
export function globeZoomForHeight(heightPx: number): number {
  // Globe radius ≈ worldSize / 2π  →  diameter = TILE_SIZE * 2^z / π, then corrected by the
  // measured MapLibre 6 globe scale (rendered diameter is ~0.815× the theoretical value).
  return Math.log2((GLOBE_DIAMETER_RATIO * heightPx * Math.PI) / TILE_SIZE) + GLOBE_ZOOM_CORRECTION;
}

/** log2(1 / 0.815) — calibrated in Chrome against the static silhouette. */
const GLOBE_ZOOM_CORRECTION = 0.295;

/** Zoom at which the 2D Mercator world spans the container width. */
export function mercatorZoomForWidth(widthPx: number): number {
  return Math.max(0, Math.log2(widthPx / TILE_SIZE));
}
