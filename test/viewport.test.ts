import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMN_WIDTH,
  DEFAULT_OVERSCAN,
  GUTTER_X,
  LANE_HEIGHT,
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_RADIUS,
  RULER_HEIGHT,
  clampZoom,
  columnAt,
  columnX,
  edgeIntersectsBand,
  laneY,
  minimapGeometry,
  minimapScrollFor,
  scrollToCommit,
  stepZoom,
  visibleColumnRange,
  visibleWorldBand,
  worldHeight,
  worldWidth,
} from '../src/webview/viewport';

// ---------------------------------------------------------------------- zoom

test('clampZoom keeps zoom inside 25%–400%', () => {
  assert.equal(clampZoom(0.1), MIN_ZOOM);
  assert.equal(clampZoom(10), MAX_ZOOM);
  assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom(Number.NaN), 1);
});

test('stepZoom walks the discrete ladder and stops at the bounds', () => {
  assert.equal(stepZoom(1, 1), 1.25);
  assert.equal(stepZoom(1, -1), 0.75);
  assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM);
  assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM);
});

test('stepZoom snaps an off-ladder value onto the next stop', () => {
  assert.equal(stepZoom(1.1, 1), 1.25);
  assert.equal(stepZoom(1.1, -1), 1);
});

// ---------------------------------------------------------------- column range

test('visibleColumnRange covers the viewport plus overscan on both sides', () => {
  const range = visibleColumnRange({
    scrollLeft: 96 * 40, // column 40 at 96px
    viewportWidth: 960, // 10 columns
    nodeCount: 1000,
    zoom: 1,
  });
  assert.equal(range.start, 40 - DEFAULT_OVERSCAN);
  assert.equal(range.end, 40 + 11 + DEFAULT_OVERSCAN);
});

test('visibleColumnRange clamps the overscan away at the very left', () => {
  const range = visibleColumnRange({ scrollLeft: 96 * 2, viewportWidth: 960, nodeCount: 1000, zoom: 1 });
  assert.equal(range.start, 0);
});

test('visibleColumnRange clamps at the left and right of the list', () => {
  const left = visibleColumnRange({ scrollLeft: 0, viewportWidth: 960, nodeCount: 1000, zoom: 1 });
  assert.equal(left.start, 0);

  const right = visibleColumnRange({
    scrollLeft: 1000 * COLUMN_WIDTH,
    viewportWidth: 960,
    nodeCount: 1000,
    zoom: 1,
  });
  assert.equal(right.end, 1000);
  assert.ok(right.start <= 1000);
});

test('visibleColumnRange accounts for zoom: wider columns mean fewer of them', () => {
  const at100 = visibleColumnRange({ scrollLeft: 0, viewportWidth: 960, nodeCount: 1000, zoom: 1 });
  const at200 = visibleColumnRange({ scrollLeft: 0, viewportWidth: 960, nodeCount: 1000, zoom: 2 });
  assert.ok(at200.end < at100.end, `${at200.end} < ${at100.end}`);

  const at50 = visibleColumnRange({ scrollLeft: 0, viewportWidth: 960, nodeCount: 1000, zoom: 0.5 });
  assert.ok(at50.end > at100.end);
});

test('visibleColumnRange stays bounded at 10 000 nodes — the virtualization budget', () => {
  const range = visibleColumnRange({
    scrollLeft: 5000 * COLUMN_WIDTH,
    viewportWidth: 960,
    nodeCount: 10_000,
    zoom: 1,
  });
  const rendered = range.end - range.start;
  assert.ok(rendered < 80, `rendered ${rendered} columns`);
  assert.ok(rendered > 0);
});

test('visibleColumnRange returns an empty window for an empty graph', () => {
  const range = visibleColumnRange({ scrollLeft: 0, viewportWidth: 500, nodeCount: 0, zoom: 1 });
  assert.deepEqual(range, { start: 0, end: 0 });
});

test('visibleColumnRange honours a custom overscan', () => {
  const range = visibleColumnRange({
    scrollLeft: 96 * 50,
    viewportWidth: 960,
    nodeCount: 1000,
    zoom: 1,
    overscan: 0,
  });
  assert.equal(range.start, 50);
});

test('visibleColumnRange ignores a negative scroll offset', () => {
  const range = visibleColumnRange({ scrollLeft: -500, viewportWidth: 960, nodeCount: 100, zoom: 1 });
  assert.equal(range.start, 0);
});

// ------------------------------------------------------------- edge culling

test('visibleWorldBand converts screen scroll into world space', () => {
  const band = visibleWorldBand(960, 960, 1, 0, COLUMN_WIDTH);
  assert.deepEqual(band, { left: 960, right: 1920 });

  const zoomed = visibleWorldBand(960, 960, 2, 0, COLUMN_WIDTH);
  assert.deepEqual(zoomed, { left: 480, right: 960 });
});

test('edgeIntersectsBand keeps an edge with an endpoint inside the band', () => {
  const band = { left: 100, right: 200 };
  assert.equal(edgeIntersectsBand(150, 400, band), true);
  assert.equal(edgeIntersectsBand(0, 150, band), true);
});

test('edgeIntersectsBand keeps an edge that spans the band with both ends outside', () => {
  const band = { left: 100, right: 200 };
  assert.equal(edgeIntersectsBand(0, 5000, band), true);
  assert.equal(edgeIntersectsBand(5000, 0, band), true);
});

test('edgeIntersectsBand drops an edge entirely left or right of the band', () => {
  const band = { left: 100, right: 200 };
  assert.equal(edgeIntersectsBand(0, 50, band), false);
  assert.equal(edgeIntersectsBand(300, 900, band), false);
});

test('edgeIntersectsBand keeps an edge exactly touching a boundary', () => {
  const band = { left: 100, right: 200 };
  assert.equal(edgeIntersectsBand(50, 100, band), true);
  assert.equal(edgeIntersectsBand(200, 400, band), true);
});

// -------------------------------------------------------------- world sizes

test('worldHeight and worldWidth scale with lanes and contentWidth', () => {
  assert.equal(worldHeight(3), RULER_HEIGHT + 3 * LANE_HEIGHT);
  assert.equal(worldHeight(0), RULER_HEIGHT + LANE_HEIGHT);
  assert.equal(worldWidth(500), 500 + GUTTER_X);
  assert.equal(worldWidth(-5), GUTTER_X);
});

test('worldWidth honours custom gutter and never drops below gutter', () => {
  assert.equal(worldWidth(0, 50), 50);
  assert.equal(worldWidth(1000, 50), 1050);
  assert.equal(worldWidth(-100, 50), 50);
});

test('worldWidth does not explode with large node counts', () => {
  const contentWidth = 10_000 * COLUMN_WIDTH;
  const width = worldWidth(contentWidth, GUTTER_X);
  assert.equal(width, 10_000 * COLUMN_WIDTH + GUTTER_X);
  assert.ok(Number.isFinite(width));
});

test('columnX and laneY place a node at its column centre and lane centre', () => {
  assert.equal(columnX(0), GUTTER_X + COLUMN_WIDTH / 2);
  assert.equal(columnX(2), GUTTER_X + 2 * COLUMN_WIDTH + COLUMN_WIDTH / 2);
  assert.equal(laneY(0), RULER_HEIGHT + LANE_HEIGHT / 2);
  assert.equal(laneY(3), RULER_HEIGHT + 3 * LANE_HEIGHT + LANE_HEIGHT / 2);
});

// ------------------------------------------------------------------ scroll

test('columnAt maps a screen x back to a column index', () => {
  assert.equal(columnAt(0, 0, 1, 100), 0);
  assert.equal(columnAt(COLUMN_WIDTH * 3 + 1, 0, 1, 100), 3);
  assert.equal(columnAt(0, COLUMN_WIDTH * 5, 1, 100), 5);
});

test('columnAt halves the index at 200% zoom', () => {
  assert.equal(columnAt(COLUMN_WIDTH * 4, 0, 2, 100), 2);
});

test('columnAt clamps to the available nodes', () => {
  assert.equal(columnAt(1_000_000, 0, 1, 10), 9);
  assert.equal(columnAt(-50, 0, 1, 10), 0);
});

test('scrollToCommit centres the target and clamps to the scrollable range', () => {
  const targetX = columnX(50);
  const middle = scrollToCommit(targetX, 960, 1, 1000 * COLUMN_WIDTH);
  assert.equal(middle, targetX - 480);
  assert.equal(scrollToCommit(0, 960, 1, 1000 * COLUMN_WIDTH), 0);
  assert.equal(scrollToCommit(1000 * COLUMN_WIDTH, 960, 1, 1000 * COLUMN_WIDTH), 1000 * COLUMN_WIDTH - 960);
});

// ----------------------------------------------------------------- minimap

test('minimapGeometry scales the viewport rectangle to the minimap (horizontal)', () => {
  const geometry = minimapGeometry(0, 960, 1, 1000 * COLUMN_WIDTH, 160);
  assert.equal(geometry.scale, 160 / (1000 * COLUMN_WIDTH));
  assert.ok(geometry.rectWidth >= 4);
  assert.equal(geometry.rectLeft, 0);
});

test('minimapGeometry never lets the rectangle escape the minimap', () => {
  const geometry = minimapGeometry(1000 * COLUMN_WIDTH, 960, 1, 1000 * COLUMN_WIDTH, 160);
  assert.ok(geometry.rectLeft + geometry.rectWidth <= 160 + 1e-9);
});

test('minimapGeometry degrades to zero for an empty graph', () => {
  assert.deepEqual(minimapGeometry(0, 960, 1, 0, 160), { scale: 0, rectLeft: 0, rectWidth: 0 });
});

test('minimapScrollFor inverts a click position into a scroll offset', () => {
  assert.equal(minimapScrollFor(0, 960, 1, 1000 * COLUMN_WIDTH, 160), 0);
  const max = 1000 * COLUMN_WIDTH - 960;
  assert.equal(minimapScrollFor(160, 960, 1, 1000 * COLUMN_WIDTH, 160), max);
  const middle = minimapScrollFor(80, 960, 1, 1000 * COLUMN_WIDTH, 160);
  assert.ok(middle > 0 && middle < max);
});

test('minimapScrollFor clamps out-of-range input', () => {
  assert.equal(minimapScrollFor(-40, 960, 1, 1000 * COLUMN_WIDTH, 160), 0);
  assert.equal(minimapScrollFor(9999, 960, 1, 1000 * COLUMN_WIDTH, 160), 1000 * COLUMN_WIDTH - 960);
});
