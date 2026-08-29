/**
 * Viewport maths for the virtualized graph canvas. Pure so the virtualization
 * rules are testable without a DOM (`test/viewport.test.ts`).
 *
 * Coordinate spaces:
 *   world  — what `layout.ts` produced (`node.x`, `node.y`), zoom-independent
 *   screen — world × zoom, minus the scroll offset
 */

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
/** Rows rendered above and below the viewport so scrolling never shows a gap. */
export const DEFAULT_OVERSCAN = 12;
/** Must match the `rowHeight` requested from `repos/graph`. */
export const ROW_HEIGHT = 24;
export const LANE_WIDTH = 16;
/** Left padding before lane 0 so the first node's ring is not clipped. */
export const GUTTER_X = 20;
export const NODE_RADIUS = 5;

const ZOOM_STEPS = [0.25, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

/** Keep zoom inside the PRD's 25 %–400 % window. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Next/previous stop on the discrete zoom ladder, so `+`/`-` feel predictable. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const current = clampZoom(zoom);
  if (direction === 1) {
    for (const step of ZOOM_STEPS) {
      if (step > current + 1e-6) return step;
    }
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const step = ZOOM_STEPS[i] as number;
    if (step < current - 1e-6) return step;
  }
  return MIN_ZOOM;
}

export interface RowRangeInput {
  scrollTop: number;
  viewportHeight: number;
  rowCount: number;
  zoom: number;
  rowHeight?: number;
  overscan?: number;
}

/** Half-open row window `[start, end)` to render. Always inside `[0, rowCount]`. */
export interface RowRange {
  start: number;
  end: number;
}

/**
 * Rows intersecting the viewport plus overscan.
 *
 * This is the whole virtualization budget: at 10 000 commits and a 900 px
 * viewport at 100 % zoom the window is ~38 rows + 2 × 12 overscan ≈ 62 rows.
 */
export function visibleRowRange(input: RowRangeInput): RowRange {
  const rowHeight = (input.rowHeight ?? ROW_HEIGHT) * clampZoom(input.zoom);
  const overscan = Math.max(0, input.overscan ?? DEFAULT_OVERSCAN);
  if (input.rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };

  const top = Math.max(0, input.scrollTop);
  const first = Math.floor(top / rowHeight) - overscan;
  const visible = Math.ceil(Math.max(0, input.viewportHeight) / rowHeight) + 1;
  const last = Math.floor(top / rowHeight) + visible + overscan;

  return {
    start: Math.max(0, Math.min(input.rowCount, first)),
    end: Math.max(0, Math.min(input.rowCount, last)),
  };
}

/** World-space y-band currently on screen, used for the edge-spans test. */
export function visibleWorldBand(
  scrollTop: number,
  viewportHeight: number,
  zoom: number,
  overscanRows: number = DEFAULT_OVERSCAN,
  rowHeight: number = ROW_HEIGHT,
): { top: number; bottom: number } {
  const z = clampZoom(zoom);
  const pad = overscanRows * rowHeight;
  const top = Math.max(0, scrollTop) / z - pad;
  const bottom = (Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / z + pad;
  return { top, bottom };
}

/**
 * An edge must draw whenever its vertical extent overlaps the band — including
 * the case where BOTH endpoints are off-screen but the edge crosses the viewport
 * (a long-lived branch merging far below its fork point).
 */
export function edgeIntersectsBand(
  fromY: number,
  toY: number,
  band: { top: number; bottom: number },
): boolean {
  const min = Math.min(fromY, toY);
  const max = Math.max(fromY, toY);
  return max >= band.top && min <= band.bottom;
}

/** Total scrollable world height for `rowCount` rows. */
export function worldHeight(rowCount: number, rowHeight: number = ROW_HEIGHT): number {
  return Math.max(0, rowCount) * rowHeight;
}

/** World width wide enough for `laneCount` lanes plus the gutter. */
export function worldWidth(laneCount: number, laneWidth: number = LANE_WIDTH): number {
  return GUTTER_X * 2 + Math.max(1, laneCount) * laneWidth;
}

/** World x for a lane centre, including the gutter. */
export function laneX(lane: number, laneWidth: number = LANE_WIDTH): number {
  return GUTTER_X + lane * laneWidth;
}

/** Row centre in world space. */
export function rowY(index: number, rowHeight: number = ROW_HEIGHT): number {
  return index * rowHeight + rowHeight / 2;
}

/** Row index under a screen-space y coordinate, clamped to the row count. */
export function rowAt(
  screenY: number,
  scrollTop: number,
  zoom: number,
  rowCount: number,
  rowHeight: number = ROW_HEIGHT,
): number {
  const z = clampZoom(zoom);
  const worldY = (Math.max(0, screenY) + Math.max(0, scrollTop)) / z;
  const index = Math.floor(worldY / rowHeight);
  return Math.min(Math.max(0, rowCount - 1), Math.max(0, index));
}

/** Scroll offset that centres `index`, clamped to the scrollable range. */
export function scrollToRow(
  index: number,
  viewportHeight: number,
  zoom: number,
  rowCount: number,
  rowHeight: number = ROW_HEIGHT,
): number {
  const z = clampZoom(zoom);
  const target = rowY(index, rowHeight) * z - Math.max(0, viewportHeight) / 2;
  const max = Math.max(0, worldHeight(rowCount, rowHeight) * z - Math.max(0, viewportHeight));
  return Math.min(max, Math.max(0, target));
}

export interface MinimapGeometry {
  /** Vertical scale: minimap px per world px. */
  scale: number;
  /** Top of the viewport rectangle, in minimap px. */
  rectTop: number;
  /** Height of the viewport rectangle, in minimap px (never below 4 px). */
  rectHeight: number;
}

/** Geometry for the minimap's draggable viewport rectangle. */
export function minimapGeometry(
  scrollTop: number,
  viewportHeight: number,
  zoom: number,
  rowCount: number,
  minimapHeight: number,
  rowHeight: number = ROW_HEIGHT,
): MinimapGeometry {
  const z = clampZoom(zoom);
  const total = worldHeight(rowCount, rowHeight) * z;
  if (total <= 0 || minimapHeight <= 0) return { scale: 0, rectTop: 0, rectHeight: 0 };
  const scale = minimapHeight / total;
  const rectHeight = Math.max(4, Math.min(minimapHeight, Math.max(0, viewportHeight) * scale));
  const rectTop = Math.min(minimapHeight - rectHeight, Math.max(0, scrollTop) * scale);
  return { scale, rectTop, rectHeight };
}

/** Inverse of {@link minimapGeometry}: minimap click y → scroll offset. */
export function minimapScrollFor(
  minimapY: number,
  viewportHeight: number,
  zoom: number,
  rowCount: number,
  minimapHeight: number,
  rowHeight: number = ROW_HEIGHT,
): number {
  const z = clampZoom(zoom);
  const total = worldHeight(rowCount, rowHeight) * z;
  if (total <= 0 || minimapHeight <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, minimapY / minimapHeight));
  const max = Math.max(0, total - Math.max(0, viewportHeight));
  return Math.min(max, Math.max(0, ratio * total - Math.max(0, viewportHeight) / 2));
}
