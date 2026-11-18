/**
 * HEAD tag versus the branch pill (frame 01, node `151:6`).
 *
 * Frame 01 marks the HEAD commit with `Tag/HEAD` (39 x 16) directly above the
 * circle, and draws no branch pill on that node at all: the pill for the current
 * branch sits on the branch tip, which is a different commit. The app drew both
 * on the same node, centred on the same x, so `HEAD` and `main` overlapped.
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

/** The branch-pill map, from its comment to the commit-card map that follows. */
function pillBlock(): string {
  const src = read(CANVAS);
  const start = src.indexOf('Branch pill on branch tips');
  assert.ok(start > 0, 'the pill map exists');
  const end = src.indexOf('Compact commit card', start);
  assert.ok(end > start, 'the card map follows it');
  return src.slice(start, end);
}

test('a HEAD node draws no branch pill: the tag owns the space above it', () => {
  const block = pillBlock();
  assert.match(block, /node\.isHead/, 'the pill map reads the HEAD flag');
  // A bare `return null` already exists for "no chips". The rule has to be the
  // HEAD guard itself, or this passes on the wrong branch.
  assert.match(
    block,
    /if \(node\.isHead\) return null;/,
    'a HEAD node returns before any pill is built',
  );
});

test('every other node keeps its pill', () => {
  const block = pillBlock();
  // The guard is the only early exit: the chip path stays reachable.
  assert.match(block, /chipsFor\(/, 'the chip list is still built');
  assert.match(block, /gc-pill/, 'and rendered');
  assert.match(block, /chips\.length === 0/, 'the empty case is separate from HEAD');
});

test('the HEAD tag stays where the frame draws it', () => {
  // The guard above is only safe because the tag marks the node on its own.
  const src = read(CANVAS);
  assert.match(src, /gc-node__head-tag/, 'the tag is still drawn');
  assert.match(src, /strings\.graph\.headTag/, 'and still named');
});
