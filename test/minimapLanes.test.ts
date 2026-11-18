/**
 * Minimap placement and drawing (frame 01, nodes `10:178`, `10:184`).
 *
 * Two defects, both measured against the frame:
 *  - the minimap was positioned inside the canvas scroller but offset from the
 *    canvas edge, so at a 150 px gutter it sat over the gutter column;
 *  - it drew one grey tick per commit, while the frame draws one coloured
 *    horizontal line per branch lane, with the viewport rectangle on top.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { minimapLaneRows } from '../src/webview/viewport';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

const CSS = 'src/webview/styles.css';
const MINIMAP = 'src/webview/GraphMinimap.tsx';

test('minimapLaneRows puts one row per lane, ordered by lane index', () => {
  const rows = minimapLaneRows(
    [
      { lane: 2, x: 400 },
      { lane: 0, x: 100 },
      { lane: 0, x: 900 },
      { lane: 1, x: 300 },
    ],
    3,
  );
  assert.equal(rows.length, 3, 'one row per lane');
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 2], 'lane order');
  // A row spans from its first commit to its last, in world units.
  assert.deepEqual([rows[0]?.startX, rows[0]?.endX], [100, 900]);
  assert.deepEqual([rows[2]?.startX, rows[2]?.endX], [400, 400], 'a single-commit lane is a point');
});

test('an empty graph yields no rows, and a lane past laneCount is ignored', () => {
  assert.deepEqual(minimapLaneRows([], 3), []);
  assert.deepEqual(minimapLaneRows([{ lane: 5, x: 10 }], 2), [], 'lane 5 is outside a 2-lane graph');
});

test('the minimap draws lane lines, not one tick per commit', () => {
  const src = read(MINIMAP);
  assert.match(src, /minimapLaneRows/, 'it asks the pure helper');
  assert.match(src, /gc-minimap__lane/, 'each lane is its own line');
  assert.doesNotMatch(src, /v3`/, 'the per-commit tick path is gone');
});

test('the minimap sits at the canvas left edge, never over the gutter', () => {
  // Measured in the real app: the row's containing block is `.gc-graph__stage`,
  // whose left edge is the GUTTER's, so `left: 12px` landed on the gutter column.
  // The offset now clears the gutter first, and it must stay a sibling of the
  // scroller: an absolute child of `.gc-canvas` scrolls away with the content.
  const css = read(CSS);
  const row = css.match(/\.gc-canvas__bottom-row\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(row.length > 0, 'the row has a rule');
  assert.match(row, /left:\s*calc\(var\(--gc-gutter-width\)/, 'it starts past the gutter');
  assert.match(row, /position:\s*absolute/, 'positioned against the stage');
  const src = read('src/webview/GraphCanvas.tsx');
  const rowAt = src.indexOf('gc-canvas__bottom-row');
  const canvasClose = src.lastIndexOf('</div>', rowAt);
  assert.ok(rowAt > 0 && canvasClose > 0, 'the row renders');
  // The row must come after the scroller's closing tag, not inside it.
  assert.ok(
    src.slice(canvasClose, rowAt).includes('\n'),
    'the row is a sibling of the scroller, not its child',
  );
});
