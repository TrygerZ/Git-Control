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

test('an edge into a merged lane is solid, one into an unmerged lane is dashed', () => {
  const merged = new Set([1]);
  assert.equal(edgeDashed(1, merged), false, 'merged lane: solid');
  assert.equal(edgeDashed(2, merged), true, 'local only lane: dashed');
  assert.equal(edgeDashed(3, merged), true, 'remote only lane: dashed');
  // A lane index the graph does not know is unmerged, so it stays dashed rather
  // than claiming a merge nobody proved.
  assert.equal(edgeDashed(9, merged), true, 'unknown lane: dashed');
});

test('the canvas uses the rule for the edge class', () => {
  const src = read('src/webview/GraphCanvas.tsx');
  assert.match(src, /edgeDashed/, 'the canvas asks the pure rule');
  assert.match(src, /gc-edge--dashed/, 'and applies a class for it');
});

test('the dashed stroke is a dash pattern, not a thinner solid line', () => {
  const css = read('src/webview/styles.css');
  const rule = css.match(/\.gc-edge--dashed\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(rule.length > 0, 'the dashed edge has a rule');
  assert.match(rule, /stroke-dasharray:\s*\d/, 'a real dash pattern');
  assert.doesNotMatch(rule, /stroke-dasharray:\s*none/, 'not the solid reset');
});
