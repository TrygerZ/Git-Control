/**
 * Node marks versus avatars (owner report, 2026-11-18).
 *
 * The merge glyph was drawn inside every merge node, on top of the author's
 * GitHub photo, which read as a dark squiggle across the face. The glyph is a
 * fallback for a node with no picture, not a badge laid over one.
 *
 * Same rule for the author initial, which already had it.
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

function nodeMark(): string {
  const src = read('src/webview/GraphCanvas.tsx');
  const start = src.indexOf('function NodeMark');
  assert.ok(start > 0, 'NodeMark exists');
  return src.slice(start, src.indexOf('\nfunction ', start + 10));
}

test('the merge glyph never paints over an avatar', () => {
  const mark = nodeMark();
  const at = mark.indexOf('gc-node__merge-glyph');
  assert.ok(at > 0, 'the glyph still exists as a fallback');
  // The condition must carry the same "no avatar" guard the author initial uses.
  const before = mark.slice(Math.max(0, at - 400), at);
  assert.match(before, /!hasAvatar/, 'the glyph is skipped when a picture is drawn');
});

test('the glyph still marks a merge with no picture, at legible zoom', () => {
  const mark = nodeMark();
  const at = mark.indexOf('gc-node__merge-glyph');
  const before = mark.slice(Math.max(0, at - 400), at);
  assert.match(before, /node\.isMerge/, 'a merge still gets the glyph');
  assert.match(before, /showContent/, 'and it follows the zoom threshold');
});

test('the author initial keeps its own no-avatar guard', () => {
  const mark = nodeMark();
  const at = mark.indexOf('gc-node__initial');
  assert.ok(at > 0, 'the initial still exists');
  const before = mark.slice(Math.max(0, at - 300), at);
  assert.match(before, /!hasAvatar/, 'the initial is a fallback too');
});
