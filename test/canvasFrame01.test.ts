/**
 * Canvas parity with frame 01 (`9:82`): the lane bands, the commit marks, the
 * edges, and the floating controls.
 *
 * Source-level, like the other view contracts: no DOM harness exists here. Each
 * test names the frame node it pins so a later reader can check the drawing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

const CANVAS = 'src/webview/GraphCanvas.tsx';
const CSS = 'src/webview/styles.css';

test('the canvas paints one horizontal band per lane, as frame 01 draws LaneBand', () => {
  // Frame 01: `LaneBand/main` (`10:2`) and `LaneBand/fix/graph-edges` (`10:3`) are
  // 930 x 150 rectangles that start at the canvas left edge and alternate lane by
  // lane. The band is what ties a gutter row to its nodes, so it runs the full
  // world width and follows the lane pitch, not the calendar.
  const src = read(CANVAS);
  assert.match(src, /gc-canvas__lane-band/, 'the band rect has its own class');
  const bandAt = src.indexOf('gc-canvas__lane-band');
  const band = src.slice(bandAt, bandAt + 500);
  assert.match(band, /lane/i, 'one band per lane');
  assert.match(band, /LANE_HEIGHT/, 'its height is the lane pitch');
  assert.match(band, /RULER_HEIGHT/, 'and it starts below the date ruler');
  assert.match(band, /index % 2 === 1|% 2 === 1/, 'odd lanes take the fill');
  assert.match(band, /totalWorldW|totalWorldWidth/, 'it spans the whole world, not one viewport');

  const css = read(CSS);
  const rule = css.match(/\.gc-canvas__lane-band\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(rule.length > 0, 'the band has a fill rule');
  assert.match(rule, /fill:/, 'it is an SVG fill');
  assert.match(rule, /var\(--gc-/, 'from a token');
  assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}/, 'no literal colour');
});

test('the vertical day zebra is gone: frame 01 alternates by lane, not by day', () => {
  // The old `gc-canvas__day-band` painted alternate calendar days, so a lane read
  // as a stack of rectangles instead of one band. The day separator line stays:
  // it is the frame's `DayDivider` (`10:4`).
  const src = read(CANVAS);
  assert.doesNotMatch(src, /gc-canvas__day-band/, 'no day band is drawn');
  assert.match(src, /gc-canvas__day-line/, 'the day divider line remains');
  assert.doesNotMatch(read(CSS), /\.gc-canvas__day-band/, 'and no day band rule survives');
});

test('the lane gutter is one flat column: the band lives on the canvas', () => {
  // Frame 01 paints the gutter `#181818` top to bottom and puts every alternate
  // fill on the canvas side of the seam. Two zebras, one on each side, read as a
  // misalignment even when they tile.
  const src = read('src/webview/LaneGutterView.tsx');
  assert.doesNotMatch(src, /gc-gutter__row--alt/, 'no alternate row class');
  assert.doesNotMatch(src, /% 2 === 1/, 'and no alternation in the row');
  assert.doesNotMatch(read(CSS), /\.gc-gutter__row--alt/, 'no alternate row rule');
});
