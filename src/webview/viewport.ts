/**
 * Viewport maths for the virtualized graph canvas (Horizontal timeline). Pure so the virtualization
 * rules are testable without a DOM (`test/viewport.test.ts`).
 *
 * Coordinate spaces:
 *   world  — what `layout.ts` produced (`node.x`, `node.y`), zoom-independent
 *   screen — world × zoom, minus the scroll offset
 */

export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 4;
/** Columns rendered left and right of the viewport so scrolling never shows a gap. */
export const DEFAULT_OVERSCAN = 6;

export const COLUMN_WIDTH = 96;
export const LANE_HEIGHT = 88;
export const NODE_RADIUS = 14;
export const DAY_GAP = 48;
export const RULER_HEIGHT = 32;
export const GUTTER_X = 32;

/**
 * Zoom below which small text turns to mush: both the author initial inside a node and the
 * commit card outside it rest on that same fact, so they share one threshold and disappear
 * together instead of alternating.
 */
export const TEXT_MIN_ZOOM = 0.75;

const ZOOM_STEPS = [0.35, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

/** Keep zoom inside the 35 %–400 % window. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Check if target node/column is currently outside the visible scroll view. */
export function needsScrollToReveal(
  targetX: number,
  zoom: number,
  scrollLeft: number,
  viewportWidth: number,
  columnWidth: number = COLUMN_WIDTH,
): boolean {
  const z = clampZoom(zoom);
  const left = targetX * z;
  const right = left + columnWidth * z;
  return left < scrollLeft || right > scrollLeft + viewportWidth;
}

/** Container focus should only reveal active row for keyboard modality, not pointer clicks. */
export function shouldRevealOnContainerFocus(input: {
  targetIsContainer: boolean;
  keyboardModality: boolean;
}): boolean {
  return input.targetIsContainer && input.keyboardModality;
}

/**
 * A commit card is drawn once text is legible ({@link TEXT_MIN_ZOOM}); below that only the
 * states the user is acting on stay on screen. Zoom goes through `clampZoom` so a nonsense
 * value cannot reveal or hide everything.
 */
export function labelVisible(input: {
  zoom: number;
  hovered: boolean;
  selected: boolean;
  focused: boolean;
  isHead: boolean;
}): boolean {
  if (input.hovered || input.selected || input.focused || input.isHead) return true;
  return clampZoom(input.zoom) >= TEXT_MIN_ZOOM;
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

export interface ColumnRangeInput {
  scrollLeft: number;
  viewportWidth: number;
  nodeCount: number;
  zoom: number;
  columnWidth?: number;
  overscan?: number;
}

/** Half-open commit/column window `[start, end)` to render. Always inside `[0, nodeCount]`. */
export interface ColumnRange {
  start: number;
  end: number;
}

/**
 * Columns/nodes intersecting the viewport plus overscan.
 */
export function visibleColumnRange(input: ColumnRangeInput): ColumnRange {
  const colWidth = (input.columnWidth ?? COLUMN_WIDTH) * clampZoom(input.zoom);
  const overscan = Math.max(0, input.overscan ?? DEFAULT_OVERSCAN);
  if (input.nodeCount <= 0 || colWidth <= 0) return { start: 0, end: 0 };

  const left = Math.max(0, input.scrollLeft);
  const first = Math.floor(left / colWidth) - overscan;
  const visible = Math.ceil(Math.max(0, input.viewportWidth) / colWidth) + 1;
  const last = Math.floor(left / colWidth) + visible + overscan;

  return {
    start: Math.max(0, Math.min(input.nodeCount, first)),
    end: Math.max(0, Math.min(input.nodeCount, last)),
  };
}

/** World-space x-band currently on screen, used for edge and element culling. */
export function visibleWorldBand(
  scrollLeft: number,
  viewportWidth: number,
  zoom: number,
  overscanCols: number = DEFAULT_OVERSCAN,
  columnWidth: number = COLUMN_WIDTH,
): { left: number; right: number } {
  const z = clampZoom(zoom);
  const pad = overscanCols * columnWidth;
  const left = Math.max(0, scrollLeft) / z - pad;
  const right = (Math.max(0, scrollLeft) + Math.max(0, viewportWidth)) / z + pad;
  return { left, right };
}

/**
 * An edge must draw whenever its horizontal extent overlaps the band.
 */
export function edgeIntersectsBand(
  fromX: number,
  toX: number,
  band: { left: number; right: number },
): boolean {
  const min = Math.min(fromX, toX);
  const max = Math.max(fromX, toX);
  return max >= band.left && min <= band.right;
}

/** Total scrollable world width for nodes. */
export function worldWidth(
  contentWidth: number,
  gutterX: number = GUTTER_X,
): number {
  return Math.max(0, contentWidth) + gutterX;
}

/** Total scrollable world height for `laneCount` lanes plus ruler and padding. */
export function worldHeight(
  laneCount: number,
  laneHeight: number = LANE_HEIGHT,
  rulerHeight: number = RULER_HEIGHT,
): number {
  return rulerHeight + Math.max(1, laneCount) * laneHeight;
}

/** World y for a lane centre, including the ruler header. */
export function laneY(lane: number, laneHeight: number = LANE_HEIGHT, rulerHeight: number = RULER_HEIGHT): number {
  return rulerHeight + lane * laneHeight + laneHeight / 2;
}

/** Column centre in world space from column slot index. */
export function columnX(index: number, columnWidth: number = COLUMN_WIDTH, gutterX: number = GUTTER_X): number {
  return gutterX + index * columnWidth + columnWidth / 2;
}

/** Column index under a screen-space x coordinate, clamped to node count. */
export function columnAt(
  screenX: number,
  scrollLeft: number,
  zoom: number,
  nodeCount: number,
  columnWidth: number = COLUMN_WIDTH,
): number {
  const z = clampZoom(zoom);
  const worldX = (Math.max(0, screenX) + Math.max(0, scrollLeft)) / z;
  const index = Math.floor(worldX / columnWidth);
  return Math.min(Math.max(0, nodeCount - 1), Math.max(0, index));
}

/** Scroll offset that centres `x` coordinate (or commit index), clamped to scrollable range. */
export function scrollToCommit(
  targetX: number,
  viewportWidth: number,
  zoom: number,
  totalWorldWidth: number,
): number {
  const z = clampZoom(zoom);
  const target = targetX * z - Math.max(0, viewportWidth) / 2;
  const max = Math.max(0, totalWorldWidth * z - Math.max(0, viewportWidth));
  return Math.min(max, Math.max(0, target));
}

export interface MinimapGeometry {
  /** Horizontal scale: minimap px per world px. */
  scale: number;
  /** Left of the viewport rectangle, in minimap px. */
  rectLeft: number;
  /** Width of the viewport rectangle, in minimap px (never below 4 px). */
  rectWidth: number;
}

/** Geometry for the minimap's draggable viewport rectangle (horizontal). */
export function minimapGeometry(
  scrollLeft: number,
  viewportWidth: number,
  zoom: number,
  totalWorldWidth: number,
  minimapWidth: number,
): MinimapGeometry {
  const z = clampZoom(zoom);
  const total = totalWorldWidth * z;
  if (total <= 0 || minimapWidth <= 0) return { scale: 0, rectLeft: 0, rectWidth: 0 };
  const scale = minimapWidth / total;
  const rectWidth = Math.max(4, Math.min(minimapWidth, Math.max(0, viewportWidth) * scale));
  const rectLeft = Math.min(minimapWidth - rectWidth, Math.max(0, scrollLeft) * scale);
  return { scale, rectLeft, rectWidth };
}

/** Inverse of {@link minimapGeometry}: minimap click x → scroll offset. */
export function minimapScrollFor(
  minimapX: number,
  viewportWidth: number,
  zoom: number,
  totalWorldWidth: number,
  minimapWidth: number,
): number {
  const z = clampZoom(zoom);
  const total = totalWorldWidth * z;
  if (total <= 0 || minimapWidth <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, minimapX / minimapWidth));
  const max = Math.max(0, total - Math.max(0, viewportWidth));
  return Math.min(max, Math.max(0, ratio * total - Math.max(0, viewportWidth) / 2));
}
