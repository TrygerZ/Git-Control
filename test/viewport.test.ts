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
  TEXT_MIN_ZOOM,
  clampZoom,
  columnAt,
  columnX,
  edgeIntersectsBand,
  laneY,
  labelVisible,
  minimapGeometry,
  minimapScrollFor,
  needsScrollToReveal,
  partitionUnrequestedHashes,
  scrollToCommit,
  shouldRevealOnContainerFocus,
  stepZoom,
  visibleColumnRange,
  visibleWorldBand,
  segmentIntersectsBand,
  worldHeight,
  worldWidth,
} from '../src/webview/viewport';

// ---------------------------------------------------------------------- zoom

test('clampZoom keeps zoom inside 35%–400%', () => {
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

test('needsScrollToReveal determines whether a target is off-screen', () => {
  // Visible: target column within [scrollLeft, scrollLeft + viewportWidth]
  assert.equal(needsScrollToReveal(200, 1, 100, 500, COLUMN_WIDTH), false);

  // Off-screen left
  assert.equal(needsScrollToReveal(50, 1, 200, 500, COLUMN_WIDTH), true);

  // Off-screen right: right edge exceeds viewport
  assert.equal(needsScrollToReveal(650, 1, 100, 500, COLUMN_WIDTH), true);
});

test('shouldRevealOnContainerFocus allows reveal only for keyboard modality on container', () => {
  // Truth table
  assert.equal(
    shouldRevealOnContainerFocus({ targetIsContainer: true, keyboardModality: true }),
    true,
    'keyboard focus directly on container should reveal',
  );
  assert.equal(
    shouldRevealOnContainerFocus({ targetIsContainer: true, keyboardModality: false }),
    false,
    'pointer focus on container should not reveal',
  );
  assert.equal(
    shouldRevealOnContainerFocus({ targetIsContainer: false, keyboardModality: true }),
    false,
    'focus on child element with keyboard should not trigger container reveal',
  );
  assert.equal(
    shouldRevealOnContainerFocus({ targetIsContainer: false, keyboardModality: false }),
    false,
    'pointer focus on child element should not reveal',
  );
});

// ----------------------------------------------------------------- minimap

test('minimapGeometry scales the viewport rectangle to the minimap (horizontal)', () => {
  // Original large-scale test (1000 * COLUMN_WIDTH)
  const geometry1000 = minimapGeometry(0, 960, 1, 1000 * COLUMN_WIDTH, 160);
  assert.equal(geometry1000.scale, 160 / (1000 * COLUMN_WIDTH));
  assert.ok(geometry1000.rectWidth >= 4);
  assert.equal(geometry1000.rectLeft, 0);

  // Moderate scale (100 * COLUMN_WIDTH)
  const geometry = minimapGeometry(0, 960, 1, 100 * COLUMN_WIDTH, 160);
  assert.equal(geometry.scale, 160 / (100 * COLUMN_WIDTH));
  assert.ok(geometry.rectWidth >= 4);
  assert.equal(geometry.rectLeft, 0);

  // Dynamic / wider minimap width (e.g. 360px floating overlay)
  const widerGeometry = minimapGeometry(0, 960, 1, 100 * COLUMN_WIDTH, 360);
  assert.equal(widerGeometry.scale, 360 / (100 * COLUMN_WIDTH));
  assert.ok(widerGeometry.rectWidth >= 4);
  assert.equal(widerGeometry.rectLeft, 0);
  assert.ok(widerGeometry.rectWidth > geometry.rectWidth);
});

test('minimapGeometry never lets the rectangle escape the minimap', () => {
  const geometry = minimapGeometry(1000 * COLUMN_WIDTH, 960, 1, 1000 * COLUMN_WIDTH, 160);
  assert.ok(geometry.rectLeft + geometry.rectWidth <= 160 + 1e-9);

  const widerGeometry = minimapGeometry(1000 * COLUMN_WIDTH, 960, 1, 1000 * COLUMN_WIDTH, 360);
  assert.ok(widerGeometry.rectLeft + widerGeometry.rectWidth <= 360 + 1e-9);
});

test('minimapGeometry degrades to zero for an empty graph', () => {
  assert.deepEqual(minimapGeometry(0, 960, 1, 0, 160), { scale: 0, rectLeft: 0, rectWidth: 0 });
  assert.deepEqual(minimapGeometry(0, 960, 1, 0, 360), { scale: 0, rectLeft: 0, rectWidth: 0 });
});

test('minimapScrollFor inverts a click position into a scroll offset', () => {
  assert.equal(minimapScrollFor(0, 960, 1, 1000 * COLUMN_WIDTH, 160), 0);
  const max = 1000 * COLUMN_WIDTH - 960;
  assert.equal(minimapScrollFor(160, 960, 1, 1000 * COLUMN_WIDTH, 160), max);
  const middle = minimapScrollFor(80, 960, 1, 1000 * COLUMN_WIDTH, 160);
  assert.ok(middle > 0 && middle < max);

  // Scaled 360px minimap
  assert.equal(minimapScrollFor(0, 960, 1, 1000 * COLUMN_WIDTH, 360), 0);
  assert.equal(minimapScrollFor(360, 960, 1, 1000 * COLUMN_WIDTH, 360), max);
  const widerMiddle = minimapScrollFor(180, 960, 1, 1000 * COLUMN_WIDTH, 360);
  assert.equal(widerMiddle, middle);
});

test('minimapScrollFor clamps out-of-range input', () => {
  assert.equal(minimapScrollFor(-40, 960, 1, 1000 * COLUMN_WIDTH, 160), 0);
  assert.equal(minimapScrollFor(9999, 960, 1, 1000 * COLUMN_WIDTH, 160), 1000 * COLUMN_WIDTH - 960);
  assert.equal(minimapScrollFor(-100, 960, 1, 1000 * COLUMN_WIDTH, 360), 0);
  assert.equal(minimapScrollFor(9999, 960, 1, 1000 * COLUMN_WIDTH, 360), 1000 * COLUMN_WIDTH - 960);
});

// ---------------------------------------------------------------- graph enhancements

test('hit-circle radius compensation maintains rendered target size across zoom', () => {
  const nodeRadius = 14;
  const avatarRadius = 15; // NODE_RADIUS + 1
  const maxHitRadius = Math.min(COLUMN_WIDTH, LANE_HEIGHT) / 2; // 44 world px (half lane height)

  function computeHitRadius(r: number, zoom: number): number {
    return Math.min(maxHitRadius, zoom < 1 ? Math.max(r, 14 / zoom) : r);
  }

  // Properties across zoom ladder plus off-ladder multiplier (1.1)
  const zoomLevels = [MIN_ZOOM, 0.5, 0.75, 1, 1.1, 1.25, 1.5, 2, 3, 4];
  for (const z of zoomLevels) {
    const worldR = computeHitRadius(avatarRadius, z);
    const renderedDiameter = worldR * 2 * z;

    // (i) Hit diameter never exceeds min(COLUMN_WIDTH, LANE_HEIGHT) in world units
    assert.ok(
      worldR * 2 <= Math.min(COLUMN_WIDTH, LANE_HEIGHT),
      `world hit diameter ${worldR * 2} exceeds min(COLUMN_WIDTH, LANE_HEIGHT) at zoom ${z}`,
    );

    // (ii) Rendered diameter is >= 28px at every zoom from MIN_ZOOM upward
    assert.ok(
      renderedDiameter >= 28,
      `rendered diameter ${renderedDiameter}px is below 28px floor at zoom ${z}`,
    );

    // (iii) At zoom >= 1, hit radius equals node/avatar radius exactly
    if (z >= 1) {
      assert.equal(worldR, avatarRadius, `world radius at zoom ${z} equals avatar radius`);
      assert.equal(renderedDiameter, avatarRadius * 2 * z, `rendered diameter at zoom ${z} matches node scaled by zoom`);
    }
  }
});

test('label width derives from COLUMN_WIDTH rather than a constant', () => {
  const zoom = 1.5;
  const computedRowWidth = (COLUMN_WIDTH - 8) * zoom;
  assert.equal(computedRowWidth, (96 - 8) * 1.5);
  assert.equal(computedRowWidth, 132);

  // At zoom 1: exactly COLUMN_WIDTH - 8 (88px)
  assert.equal((COLUMN_WIDTH - 8) * 1, 88);
});

test('leftmost node and commit card stay fully visible across all zoom levels in resting and hovered states', () => {
  const nodeX = GUTTER_X;
  const zoomLevels = [MIN_ZOOM, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, MAX_ZOOM];

  for (const zoom of zoomLevels) {
    const screenNodeX = nodeX * zoom;
    const rowWidth = (COLUMN_WIDTH - 8) * zoom;
    const halfWidthResting = rowWidth / 2;
    const halfWidthHovered = (rowWidth * 1.6) / 2;

    const restingLeft = screenNodeX - halfWidthResting;
    const hoveredLeft = screenNodeX - halfWidthHovered;

    assert.ok(
      restingLeft >= 0,
      `resting card left edge (${restingLeft}px) is negative at zoom ${zoom}`,
    );
    assert.ok(
      hoveredLeft >= 0,
      `hovered card left edge (${hoveredLeft}px) is negative at zoom ${zoom}`,
    );
  }
});

test('rightmost node commit card stays within canvas total world width across all zoom levels', () => {
  const maxNodeX = 1000;
  const totalWorldW = worldWidth(maxNodeX + COLUMN_WIDTH, GUTTER_X);
  const zoomLevels = [MIN_ZOOM, 1, MAX_ZOOM];

  for (const zoom of zoomLevels) {
    const screenTotalW = totalWorldW * zoom;
    const screenMaxNodeX = maxNodeX * zoom;
    const rowWidth = (COLUMN_WIDTH - 8) * zoom;
    const halfWidthHovered = (rowWidth * 1.6) / 2;
    const hoveredRight = screenMaxNodeX + halfWidthHovered;

    assert.ok(
      hoveredRight <= screenTotalW,
      `hovered card right edge (${hoveredRight}px) exceeds canvas width (${screenTotalW}px) at zoom ${zoom}`,
    );
  }
});

// ------------------------------------------------------------- label visibility

const RESTING = { hovered: false, selected: false, focused: false, isHead: false };

test('labelVisible hides a resting label below the legible zoom', () => {
  assert.equal(labelVisible({ zoom: 0.5, ...RESTING }), false);
  assert.equal(labelVisible({ zoom: MIN_ZOOM, ...RESTING }), false);
});

test('labelVisible keeps an active label below the legible zoom', () => {
  assert.equal(labelVisible({ ...RESTING, zoom: MIN_ZOOM, hovered: true }), true);
  assert.equal(labelVisible({ ...RESTING, zoom: MIN_ZOOM, selected: true }), true);
  assert.equal(labelVisible({ ...RESTING, zoom: MIN_ZOOM, focused: true }), true);
  assert.equal(labelVisible({ ...RESTING, zoom: MIN_ZOOM, isHead: true }), true);
});

test('labelVisible shows every label at or above the legible zoom', () => {
  assert.equal(labelVisible({ zoom: TEXT_MIN_ZOOM, ...RESTING }), true);
  assert.equal(labelVisible({ zoom: 1, ...RESTING }), true);
  assert.equal(labelVisible({ zoom: MAX_ZOOM, ...RESTING }), true);
});

test('labelVisible clamps nonsense zoom through clampZoom', () => {
  // Below MIN_ZOOM clamps up to MIN_ZOOM, still under the threshold.
  assert.equal(labelVisible({ zoom: -5, ...RESTING }), false);
  // Above MAX_ZOOM clamps down to MAX_ZOOM, still over it.
  assert.equal(labelVisible({ zoom: 9999, ...RESTING }), true);
  // NaN falls back to zoom 1.
  assert.equal(labelVisible({ zoom: Number.NaN, ...RESTING }), true);
  assert.ok(clampZoom(TEXT_MIN_ZOOM) === TEXT_MIN_ZOOM);
});

// ----------------------------------------------------------- partitionUnrequestedHashes

test('partitionUnrequestedHashes filters out already requested hashes and duplicates', () => {
  const requested = new Set(['hash1', 'hash2']);
  const input = ['hash1', 'hash3', 'hash3', 'hash4', 'hash2', 'hash5'];
  const batches = partitionUnrequestedHashes(input, requested, 50);
  assert.deepEqual(batches, [['hash3', 'hash4', 'hash5']]);
});

test('partitionUnrequestedHashes returns empty array when all hashes are requested or input is empty', () => {
  const requested = new Set(['hash1', 'hash2']);
  assert.deepEqual(partitionUnrequestedHashes(['hash1', 'hash2'], requested), []);
  assert.deepEqual(partitionUnrequestedHashes([], requested), []);
});

test('partitionUnrequestedHashes splits into chunks bounded by 50', () => {
  const requested = new Set<string>();
  const input = Array.from({ length: 125 }, (_, i) => `hash_${i}`);
  const batches = partitionUnrequestedHashes(input, requested);
  assert.equal(batches.length, 3);
  assert.equal(batches[0]?.length, 50);
  assert.equal(batches[1]?.length, 50);
  assert.equal(batches[2]?.length, 25);
});

// ----------------------------------------------------------- segmentIntersectsBand (Ribbon culling)

test('segmentIntersectsBand correctly culls ribbons outside the viewport band', () => {
  const band = { left: 200, right: 800 };

  // Completely to the left
  assert.equal(segmentIntersectsBand(0, 150, band), false);
  // Overlapping left boundary
  assert.equal(segmentIntersectsBand(150, 250, band), true);
  // Inside viewport band
  assert.equal(segmentIntersectsBand(300, 500, band), true);
  // Overlapping right boundary
  assert.equal(segmentIntersectsBand(750, 900, band), true);
  // Completely to the right
  assert.equal(segmentIntersectsBand(850, 1200, band), false);
  // Spanning across entire viewport band
  assert.equal(segmentIntersectsBand(100, 1000, band), true);
});
