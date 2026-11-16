/**
 * Edge strokes (frame 01, node `9:82`).
 *
 * The frame draws two stroke styles, and the difference carries meaning: an edge
 * that lands on a branch already merged into the current line is SOLID (`12:17`,
 * `12:18` into `feat/stash-pinned-footer`), and an edge into a branch that has not
 * landed is DASHED (`12:19` into `feat/graph-ribbons`, `12:20` into
 * `origin/release/1.4`). The app drew every edge solid at 1.4 px, so the graph lost
 * the only channel that says "this line is not in your branch yet".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { edgeDashed } from '../src/webview/laneGutter';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

test('an edge into a landed lane is solid, one into an unlanded lane is dashed', () => {
  // "Landed" is merged OR the lane HEAD sits on. The current branch is never
  // merged into anything, so a set of merged lanes alone would dash every edge of
  // the branch the user is standing on.
  const landed = new Set([0, 1]);
  assert.equal(edgeDashed(0, landed), false, 'the HEAD lane: solid');
  assert.equal(edgeDashed(1, landed), false, 'a merged lane: solid');
  assert.equal(edgeDashed(2, landed), true, 'a local only lane: dashed');
  assert.equal(edgeDashed(3, landed), true, 'a remote only lane: dashed');
  // A lane index the graph does not know is unlanded, so it stays dashed rather
  // than claiming a merge nobody proved.
  assert.equal(edgeDashed(9, landed), true, 'unknown lane: dashed');
});

test('the canvas uses the rule for the edge class', () => {
  const src = read('src/webview/GraphCanvas.tsx');
  assert.match(src, /edgeDashed/, 'the canvas asks the pure rule');
  assert.match(src, /gc-edge--dashed/, 'and applies a class for it');
  // The landed set must include the lane HEAD sits on, or the whole current
  // branch draws dashed. Both facts come from the graph the canvas already holds.
  const memo = src.slice(src.indexOf('mergedLaneSet'), src.indexOf('mergedLaneSet') + 500);
  assert.match(memo, /mergedLanes\(/, 'the merged set is the base');
  assert.match(memo, /headLane|isHead/, 'and the HEAD lane joins it');
});

test('the dashed stroke is a dash pattern, not a thinner solid line', () => {
  const css = read('src/webview/styles.css');
  const rule = css.match(/\.gc-edge--dashed\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(rule.length > 0, 'the dashed edge has a rule');
  assert.match(rule, /stroke-dasharray:\s*\d/, 'a real dash pattern');
  assert.doesNotMatch(rule, /stroke-dasharray:\s*none/, 'not the solid reset');
});
