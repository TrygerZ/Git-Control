/**
 * Inspector detail blocks versus frame 01 (`9:83`).
 *
 * Four differences the owner reported as "the detail tab still looks different":
 *  - `FULL MESSAGE` sits in a bordered box; the frame draws it as plain text in
 *    the column.
 *  - the ref chips are bare text; the frame gives each one its branch glyph.
 *  - the pull request state is plain words; the frame draws it as a pill.
 *  - the merge parent selector prints a visible `Compare with parent` label the
 *    frame never draws, and pushes the file list down by a whole row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { refChipKind } from '../src/webview/Inspector';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

const CSS = 'src/webview/styles.css';
const INSPECTOR = 'src/webview/Inspector.tsx';

test('the full message is plain column text, not a box', () => {
  const css = read(CSS);
  const body = css.match(/\.gc-inspector__body\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(body.length > 0, 'the message has a rule');
  assert.doesNotMatch(body, /background:/, 'no panel fill');
  assert.doesNotMatch(body, /border:/, 'no box border');
  assert.doesNotMatch(body, /border-radius/, 'and no rounded corners');
  assert.match(body, /white-space:\s*pre-wrap/, 'line breaks survive');
});

test('each ref chip carries the branch glyph the frame draws', () => {
  const src = read(INSPECTOR);
  const refs = src.slice(src.indexOf('gc-inspector__refs'), src.indexOf('sectionBody'));
  assert.match(refs, /<Icon name=/, 'a glyph leads the chip');
  assert.match(refs, /name="git-branch"/, 'the frame branch glyph');
  // Measured in the browser: `git log --decorate` hands over SHORT names, so
  // `feat/stash-pinned-footer` contains a slash and was classified as a remote.
  // The remote test must key on a known remote name, not on a slash.
  assert.match(refs, /refChipKind\(/, 'the kind comes from one named rule');
});

test('refChipKind tells a slashed local branch from a remote-tracking ref', () => {
  // `git log --decorate` prints short names, so a local branch with a slash and a
  // remote-tracking ref look alike. Only the remote names disambiguate them.
  const remotes = new Set(['origin', 'upstream']);
  assert.equal(refChipKind('feat/stash-pinned-footer', remotes), 'local');
  assert.equal(refChipKind('origin/main', remotes), 'remote');
  assert.equal(refChipKind('upstream/bugfix', remotes), 'remote');
  assert.equal(refChipKind('main', remotes), 'local');
  assert.equal(refChipKind('tag: v0.7.1', remotes), 'tag');
  // A branch that happens to start with the same word as a remote still wins only
  // when it is actually `<remote>/<branch>`: `origin` alone is a local branch.
  assert.equal(refChipKind('origin', remotes), 'local');
  assert.equal(refChipKind('refs/heads/main', remotes), 'local');
  assert.equal(refChipKind('refs/remotes/origin/main', remotes), 'remote');
});

test('the pull request state is a pill, not plain words', () => {
  const src = read(INSPECTOR);
  const card = src.slice(src.indexOf('gc-inspector__pr-card'), src.indexOf('sectionBody'));
  assert.match(card, /gc-inspector__pr-state/, 'the state has its own element');
  assert.match(card, /pullRequestState/, 'and its word still comes from the catalog');
  const css = read(CSS);
  const rule = css.match(/\.gc-inspector__pr-state\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(rule.length > 0, 'the pill has a rule');
  assert.match(rule, /border-radius:\s*var\(--gc-radius-pill\)/, 'pill shaped');
  assert.match(rule, /background:\s*var\(--gc-/, 'a fill from a token');
  // Merged is the state the frame shows, and it has its own tone.
  assert.match(css, /\.gc-inspector__pr-state--merged\s*\{/, 'a merged tone exists');
});

test('the merge parent selector is compact, with no visible label row', () => {
  const src = read(INSPECTOR);
  const files = src.slice(src.indexOf('gc-inspector__block--files'), src.indexOf('gc-filelist'));
  assert.doesNotMatch(files, /gc-field__label/, 'no visible label above the select');
  assert.match(files, /aria-label=\{strings\.inspector\.compareParentLabel\}/, 'the name stays on the control');
});
