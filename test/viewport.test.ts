import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OVERSCAN,
  GUTTER_X,
  LANE_WIDTH,
  MAX_ZOOM,
  MIN_ZOOM,
  ROW_HEIGHT,
  clampZoom,
  edgeIntersectsBand,
  laneX,
  minimapGeometry,
  minimapScrollFor,
  rowAt,
  rowY,
  scrollToRow,
  stepZoom,
  visibleRowRange,
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

// ---------------------------------------------------------------- row range

test('visibleRowRange covers the viewport plus overscan on both sides', () => {
  const range = visibleRowRange({
    scrollTop: 24 * 40, // row 40 at 24px
    viewportHeight: 240, // 10 rows
    rowCount: 1000,
    zoom: 1,
  });
  assert.equal(range.start, 40 - DEFAULT_OVERSCAN);
  assert.equal(range.end, 40 + 11 + DEFAULT_OVERSCAN);
});

test('visibleRowRange clamps the overscan away at the very top', () => {
  const range = visibleRowRange({ scrollTop: 24 * 2, viewportHeight: 240, rowCount: 1000, zoom: 1 });
  assert.equal(range.start, 0);
});

test('visibleRowRange clamps at the top and bottom of the list', () => {
  const top = visibleRowRange({ scrollTop: 0, viewportHeight: 240, rowCount: 1000, zoom: 1 });
  assert.equal(top.start, 0);

  const bottom = visibleRowRange({
    scrollTop: 1000 * ROW_HEIGHT,
    viewportHeight: 240,
    rowCount: 1000,
    zoom: 1,
  });
  assert.equal(bottom.end, 1000);
  assert.ok(bottom.start <= 1000);
});

test('visibleRowRange accounts for zoom: bigger rows mean fewer of them', () => {
  const at100 = visibleRowRange({ scrollTop: 0, viewportHeight: 480, rowCount: 1000, zoom: 1 });
  const at200 = visibleRowRange({ scrollTop: 0, viewportHeight: 480, rowCount: 1000, zoom: 2 });
  assert.ok(at200.end < at100.end, `${at200.end} < ${at100.end}`);

  const at50 = visibleRowRange({ scrollTop: 0, viewportHeight: 480, rowCount: 1000, zoom: 0.5 });
  assert.ok(at50.end > at100.end);
});

test('visibleRowRange stays bounded at 10 000 rows — the virtualization budget', () => {
  const range = visibleRowRange({
    scrollTop: 5000 * ROW_HEIGHT,
    viewportHeight: 900,
    rowCount: 10_000,
    zoom: 1,
  });
  const rendered = range.end - range.start;
  assert.ok(rendered < 80, `rendered ${rendered} rows`);
  assert.ok(rendered > 0);
});

test('visibleRowRange returns an empty window for an empty graph', () => {
  const range = visibleRowRange({ scrollTop: 0, viewportHeight: 500, rowCount: 0, zoom: 1 });
  assert.deepEqual(range, { start: 0, end: 0 });
});

test('visibleRowRange honours a custom overscan', () => {
  const range = visibleRowRange({
    scrollTop: 24 * 50,
    viewportHeight: 240,
    rowCount: 1000,
    zoom: 1,
    overscan: 0,
  });
  assert.equal(range.start, 50);
});

test('visibleRowRange ignores a negative scroll offset', () => {
  const range = visibleRowRange({ scrollTop: -500, viewportHeight: 240, rowCount: 100, zoom: 1 });
  assert.equal(range.start, 0);
});

// ------------------------------------------------------------- edge culling

test('visibleWorldBand converts screen scroll into world space', () => {
  const band = visibleWorldBand(240, 240, 1, 0, ROW_HEIGHT);
  assert.deepEqual(band, { top: 240, bottom: 480 });

  const zoomed = visibleWorldBand(240, 240, 2, 0, ROW_HEIGHT);
  assert.deepEqual(zoomed, { top: 120, bottom: 240 });
});

test('edgeIntersectsBand keeps an edge with an endpoint inside the band', () => {
  const band = { top: 100, bottom: 200 };
  assert.equal(edgeIntersectsBand(150, 400, band), true);
  assert.equal(edgeIntersectsBand(0, 150, band), true);
});

test('edgeIntersectsBand keeps an edge that spans the band with both ends outside', () => {
  const band = { top: 100, bottom: 200 };
  // A long-lived branch forking above and merging far below the viewport.
  assert.equal(edgeIntersectsBand(0, 5000, band), true);
  assert.equal(edgeIntersectsBand(5000, 0, band), true);
});

test('edgeIntersectsBand drops an edge entirely above or below the band', () => {
  const band = { top: 100, bottom: 200 };
  assert.equal(edgeIntersectsBand(0, 50, band), false);
  assert.equal(edgeIntersectsBand(300, 900, band), false);
});

test('edgeIntersectsBand keeps an edge exactly touching a boundary', () => {
  const band = { top: 100, bottom: 200 };
  assert.equal(edgeIntersectsBand(50, 100, band), true);
  assert.equal(edgeIntersectsBand(200, 400, band), true);
});

// -------------------------------------------------------------- world sizes

test('worldHeight and worldWidth scale with rows and lanes', () => {
  assert.equal(worldHeight(10), 10 * ROW_HEIGHT);
  assert.equal(worldHeight(-5), 0);
  assert.equal(worldWidth(3), GUTTER_X * 2 + 3 * LANE_WIDTH);
  // An empty graph still reserves one lane so the gutter renders.
  assert.equal(worldWidth(0), GUTTER_X * 2 + LANE_WIDTH);
});

test('laneX and rowY place a node at its lane centre and row centre', () => {
  assert.equal(laneX(0), GUTTER_X);
  assert.equal(laneX(2), GUTTER_X + 2 * LANE_WIDTH);
  assert.equal(rowY(0), ROW_HEIGHT / 2);
  assert.equal(rowY(3), 3 * ROW_HEIGHT + ROW_HEIGHT / 2);
});

// ------------------------------------------------------------------ scroll

test('rowAt maps a screen y back to a row index', () => {
  assert.equal(rowAt(0, 0, 1, 100), 0);
  assert.equal(rowAt(ROW_HEIGHT * 3 + 1, 0, 1, 100), 3);
  assert.equal(rowAt(0, ROW_HEIGHT * 5, 1, 100), 5);
});

test('rowAt halves the index at 200% zoom', () => {
  assert.equal(rowAt(ROW_HEIGHT * 4, 0, 2, 100), 2);
});

test('rowAt clamps to the available rows', () => {
  assert.equal(rowAt(1_000_000, 0, 1, 10), 9);
  assert.equal(rowAt(-50, 0, 1, 10), 0);
});

test('scrollToRow centres the row and clamps to the scrollable range', () => {
  const middle = scrollToRow(50, 240, 1, 1000);
  assert.equal(middle, rowY(50) - 120);
  assert.equal(scrollToRow(0, 240, 1, 1000), 0);
  assert.equal(scrollToRow(999, 240, 1, 1000), 1000 * ROW_HEIGHT - 240);
});

// ----------------------------------------------------------------- minimap

test('minimapGeometry scales the viewport rectangle to the minimap', () => {
  const geometry = minimapGeometry(0, 240, 1, 1000, 160);
  assert.equal(geometry.scale, 160 / (1000 * ROW_HEIGHT));
  assert.ok(geometry.rectHeight >= 4);
  assert.equal(geometry.rectTop, 0);
});

test('minimapGeometry never lets the rectangle escape the minimap', () => {
  const geometry = minimapGeometry(1000 * ROW_HEIGHT, 240, 1, 1000, 160);
  assert.ok(geometry.rectTop + geometry.rectHeight <= 160 + 1e-9);
});

test('minimapGeometry degrades to zero for an empty graph', () => {
  assert.deepEqual(minimapGeometry(0, 240, 1, 0, 160), { scale: 0, rectTop: 0, rectHeight: 0 });
});

test('minimapScrollFor inverts a click position into a scroll offset', () => {
  assert.equal(minimapScrollFor(0, 240, 1, 1000, 160), 0);
  const max = 1000 * ROW_HEIGHT - 240;
  assert.equal(minimapScrollFor(160, 240, 1, 1000, 160), max);
  const middle = minimapScrollFor(80, 240, 1, 1000, 160);
  assert.ok(middle > 0 && middle < max);
});

test('minimapScrollFor clamps out-of-range input', () => {
  assert.equal(minimapScrollFor(-40, 240, 1, 1000, 160), 0);
  assert.equal(minimapScrollFor(9999, 240, 1, 1000, 160), 1000 * ROW_HEIGHT - 240);
});
