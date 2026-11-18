/**
 * Canvas bottom controls (frame 01, nodes `10:158`, `10:178`, `10:184`).
 *
 * The frame stacks the bottom row as: the minimap at the LEFT edge of the canvas
 * (x 166..384, 220 x 68), the legend pill beside it (`10:184`), and the zoom bar
 * alone at the right end (`10:158`: minus, percent, plus, divider, maximize,
 * crosshair). The app put the minimap in the centre, gave it 360 px, and added a
 * separate home card above the zoom bar, which the frame does not draw.
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

test('the bottom row starts at the canvas left edge, not centred', () => {
  const css = read(CSS);
  const row = css.match(/\.gc-canvas__bottom-row\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(row.length > 0, 'the row has a rule');
  assert.doesNotMatch(row, /left:\s*50%/, 'not centred');
  assert.doesNotMatch(row, /translateX/, 'and no centring transform');
  // The containing block is `.gc-graph__stage`, whose left edge is the gutter's,
  // so the offset has to clear the gutter first. `left: var(--gc-space-4)` alone
  // put the row at x 16, on top of the 150 px gutter column.
  assert.match(row, /left:\s*calc\(var\(--gc-gutter-width\)/, 'it clears the gutter');
  const stage = css.match(/\.gc-graph__stage\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(stage, /--gc-gutter-width:\s*\d+px/, 'the gutter width is declared on the stage');
  const gutter = css.match(/\.gc-gutter\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(gutter, /width:\s*var\(--gc-gutter-width\)/, 'and the column consumes it');
});

test('the minimap is the frame size, not a share of the stage width', () => {
  const src = read(CANVAS);
  // Frame 01 (`10:178`) is 220 x 68. A percentage of the viewport made it 360 px
  // wide on a 1600 px stage, which pushed the legend off the row.
  assert.match(src, /MINIMAP_WIDTH\s*=\s*220/, 'the frame width');
  assert.match(src, /MINIMAP_HEIGHT\s*=\s*68/, 'and the frame height');
  assert.match(src, /width=\{MINIMAP_WIDTH\}/, 'the minimap takes the constant');
  assert.doesNotMatch(src, /viewportWidthState \* 0\.45/, 'no share-of-stage maths');
});

test('the zoom bar is one row: minus, percent, plus, divider, maximize, crosshair', () => {
  const src = read(CANVAS);
  const controls = src.slice(src.indexOf('gc-canvas__controls'));
  // The home card is a second stack above the zoom bar; the frame has no such
  // control, so the jump-to-HEAD button lives inside the zoom bar's crosshair.
  assert.doesNotMatch(controls, /jumpHeadAria/, 'the separate home button is gone');
  for (const key of ['zoomOutAria', 'zoomResetAria', 'zoomInAria', 'zoomFitAria', 'zoomHeadAria']) {
    assert.match(controls, new RegExp(`strings\\.graph\\.${key}`), `${key} is a control`);
  }
  const css = read(CSS);
  const bar = css.match(/\.gc-canvas__controls\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(bar, /flex-direction:\s*row/, 'one horizontal bar');
  assert.doesNotMatch(bar, /flex-direction:\s*column/, 'not a stack of cards');
});

test('the legend pill follows the minimap on the same bottom edge', () => {
  const src = read(CANVAS);
  const wrap = src.indexOf('gc-minimap-wrap');
  const pill = src.indexOf('gc-legend-pill');
  assert.ok(wrap > 0 && pill > wrap, 'the pill follows the minimap');
  const css = read(CSS);
  const row = css.match(/\.gc-canvas__bottom-row\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(row, /align-items:\s*flex-end/, 'both rest on the same edge');
});
