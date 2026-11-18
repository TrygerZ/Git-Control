/**
 * Commit marks (frame 01, node `9:82`).
 *
 * The frame draws three separate shapes, and the app collapsed them into two:
 *  - `10:25`..`10:122` plain nodes: a 28 px circle carrying the author initial.
 *  - `10:102` HEAD node: 34 px, one size up, with `151:5 HeadHalo` 52 px behind it
 *    and `151:6 Tag/HEAD` (39 x 16) sitting above the circle.
 *  - `10:81 SelectedHalo` 46 px: a ring around the selected node.
 *  - `10:50` merge node: the merge glyph inside the circle, not a bigger plain dot.
 *
 * The app drew HEAD as a 40 x 18 capsule with a house glyph, which is a different
 * object on the canvas and reads as a control rather than a commit.
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

function nodeMark(): string {
  const src = read(CANVAS);
  const start = src.indexOf('function NodeMark');
  assert.ok(start > 0, 'NodeMark exists');
  return src.slice(start, src.indexOf('\nfunction ', start + 10));
}

test('HEAD is a larger circle with a HEAD tag above it, not a capsule', () => {
  const mark = nodeMark();
  assert.doesNotMatch(mark, /gc-node__capsule/, 'the capsule is gone');
  assert.match(mark, /gc-node__head-tag/, 'the frame tag has its own element');
  assert.match(mark, /strings\.graph\.headTag/, 'and its word comes from the catalog');

  // The tag is text, so it needs the tag styles rather than a second glyph.
  const css = read(CSS);
  const tag = css.match(/\.gc-node__head-tag\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(tag.length > 0, 'the tag has a rule');
  assert.match(tag, /font-size:/, 'it is set as a label');
  assert.match(tag, /var\(--gc-/, 'from tokens');
  assert.doesNotMatch(tag, /#[0-9a-fA-F]{3,8}/, 'no literal colour');
});

test('the HEAD node is one size up from a plain node, as the frame draws 34 against 28', () => {
  const mark = nodeMark();
  // `r` already grows for a merge. HEAD must grow too, and the two must not share
  // one branch: a merge commit at HEAD is both, so the radius takes the larger.
  assert.match(mark, /isHead/, 'the radius reads the HEAD flag');
  assert.match(mark, /Math\.max\(/, 'the two reasons for a bigger circle combine');
  const src = read(CANVAS);
  assert.match(src, /HEAD_RADIUS|headRadius/, 'the extra radius has a name');
});

test('the selection halo is a ring behind the dot, not a fatter stroke', () => {
  const mark = nodeMark();
  assert.match(mark, /gc-node__halo/, 'a halo element exists');
  const css = read(CSS);
  const halo = css.match(/\.gc-node__halo\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(halo.length > 0, 'the halo has a rule');
  assert.match(halo, /fill:\s*none/, 'a ring, not a disc');
  assert.match(halo, /stroke:/, 'drawn with a stroke');
  // Frame 01: `10:81` is 46 px against a 28 px node, so the ring clears the dot.
  // Chrome colour comes from a theme variable, never a literal: the focus border
  // is the one accent every theme guarantees.
  assert.match(halo, /var\(--(?:gc|vscode)-/, 'from a theme token');
  assert.doesNotMatch(halo, /#[0-9a-fA-F]{3,8}/, 'no literal colour');
});

test('a merge commit carries the merge glyph inside its circle', () => {
  const mark = nodeMark();
  assert.match(mark, /isMerge/, 'the mark knows it is a merge');
  // Frame 01 (`10:51`): the merge node is a plain 28 px circle with a merge glyph
  // inside it, not a bigger empty dot. The glyph is drawn as an SVG path so it
  // scales with the zoom; the class lets the stylesheet own its colour.
  assert.match(mark, /gc-node__merge-glyph/, 'the glyph has its own element');
  assert.match(mark, /node\.isMerge\s*&&/, 'and it is drawn only for a merge');
});

test('both catalogs carry the HEAD tag word', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    assert.ok(catalog.includes('    headTag:'), `${lang} catalog is missing headTag`);
  }
});
