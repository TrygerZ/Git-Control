/**
 * Changed-file row (frame 01, node `9:138`).
 *
 * The frame splits a file row into four cells: the status badge, the file name,
 * the directory it lives in, and the churn. The directory cell reads `src/webview`,
 * not `src/webview/store.ts`: repeating the name the cell to its left already shows
 * costs the width that keeps the churn visible at 320 px.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dirOf } from '../src/webview/format';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

test('dirOf returns the directory, and nothing for a root-level file', () => {
  assert.equal(dirOf('src/webview/store.ts'), 'src/webview');
  assert.equal(dirOf('test/stash.test.ts'), 'test');
  assert.equal(dirOf('README.md'), '');
  assert.equal(dirOf('a/b/c/d.ts'), 'a/b/c');
  // A path with no extension is still a file at the root, not a directory.
  assert.equal(dirOf('Makefile'), '');
});

test('the file row prints the directory, not the whole path', () => {
  const src = read('src/webview/Inspector.tsx');
  const row = src.slice(src.indexOf('gc-filelist__button'), src.indexOf('gc-filelist__stats'));
  assert.match(row, /gc-filelist__dir/, 'the directory cell exists');
  assert.match(row, /dirOf\(/, 'and it is built by the helper');
  assert.doesNotMatch(row, /\{safePath\}\s*<\/span>/, 'the whole path is not the cell');
});

test('the churn column survives a 320 px panel', () => {
  // Measured in the browser at the frame's panel width: the name cell took its
  // full intrinsic width and the directory grew, so `+9 -3` was clipped by the
  // button's edge. The name yields first; the churn never shrinks.
  const css = read('src/webview/styles.css');
  const name = css.match(/\.gc-filelist__name\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(name.length > 0, 'the name has a rule');
  assert.match(name, /min-width:\s*[1-9]/, 'the name can shrink to a floor');
  const stats = css.match(/\.gc-filelist__stats\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(stats, /flex:\s*0 0 auto/, 'the churn keeps its width');
});
