/**
 * Inspector actions footer (frame 01, node `9:179`).
 *
 * The frame closes the right-hand panel with a 57 px bar holding three controls:
 * `Button/Checkout` (check glyph), `Button/Branch here` (branch glyph), and an
 * overflow `IconButton/more`. Today the panel ends after the file list, so the
 * two fastest commit actions are reachable only through the canvas context menu.
 *
 * The bar acts on the selected commit, so the availability rules are the same ones
 * the context menu already enforces: no checkout of the current HEAD, no branch
 * creation while an operation is in flight.
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

const INSPECTOR = 'src/webview/Inspector.tsx';
const APP = 'src/webview/ExplorerApp.tsx';

test('the panel ends in an actions bar pinned below the scrollable body', () => {
  // Frame 01 (`9:179`) is a fixed 57 px footer of the aside: the body above it
  // scrolls, the bar does not. Rendering it inside the scrolling body would push
  // Checkout off screen the moment the file list is long, which is exactly the
  // case the bar exists for.
  const app = read(APP);
  assert.match(app, /gc-explorer__aside-actions/, 'the bar is the aside footer');
  assert.match(app, /gc-inspector__actions/, 'and it carries the frame element');

  const body = app.indexOf('gc-explorer__aside-content');
  const bar = app.indexOf('gc-explorer__aside-actions');
  assert.ok(body > 0 && bar > body, 'the footer follows the scrollable body');

  // Contributors sits above the bar, as the frame orders it.
  const contributors = app.indexOf('<Contributors');
  assert.ok(contributors > 0 && contributors < bar, 'contributors come before the bar');

  // One implementation: the buttons live with the aside, not duplicated in the
  // panel that the aside happens to render.
  assert.doesNotMatch(read(INSPECTOR), /gc-inspector__actions/);
});

test('the two primary actions are named and carry the frame glyphs', () => {
  const src = read(APP);
  assert.match(src, /strings\.inspector\.actionCheckout/);
  assert.match(src, /strings\.inspector\.actionBranchHere/);
  assert.match(src, /name="check"/, 'Checkout carries the check glyph');
  assert.match(src, /name="git-branch"|name="branch-add"/, 'Branch here carries the branch glyph');
});

test('the overflow button is the frame ellipsis, and it opens the shared menu', () => {
  const src = read(APP);
  assert.match(src, /strings\.inspector\.actionMoreAria/);
  assert.match(src, /name="ellipsis"/);
  assert.match(src, /aria-haspopup="menu"/);
  // One menu implementation, not a second: the commit menu already owns the
  // destructive verbs, and duplicating them here would double the surface.
  assert.match(src, /NodeContextMenu|menuItemsFor/, 'it reuses the commit menu');
});

test('checkout is refused for the commit already at HEAD, and while busy', () => {
  const src = read(APP);
  assert.match(src, /isHead|detail\.hash === status\?\.head|hash === status\.head/, 'HEAD is the guard');
  assert.match(src, /disabled=\{/, 'an impossible action is disabled, not silently dropped');
  assert.match(src, /operation !== 'idle'|busy/, 'an in-flight operation blocks both buttons');
});

test('both actions go through the operation store, never a raw bridge call', () => {
  const src = read(APP);
  assert.match(src, /useOperationStore/);
  assert.match(src, /runAction\(/);
  assert.match(src, /action: 'checkout-commit'/);
  assert.match(src, /action: 'create-branch'|createBranch/, 'Branch here opens the prompt');
  // The inspector may not spawn git itself.
  assert.doesNotMatch(src, /bridge\.request\('(?!commits\/detail|actions\/openDiff|actions\/openStashDiff)/);
});

test('the bar keeps its geometry from the frame and tokens only', () => {
  const css = read('src/webview/styles.css');
  const bar = css.match(/\.gc-inspector__actions\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(bar.length > 0, 'the bar has a rule');
  assert.match(bar, /border-top/, 'the frame separates it from the body');
  assert.match(bar, /gap:/);
  const literals = css.match(/\.gc-inspector__actions[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.deepEqual(literals, [], 'no literal colour');
});

test('both catalogs name the three actions', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    for (const key of ['actionCheckout', 'actionBranchHere', 'actionMoreAria']) {
      assert.ok(catalog.includes(`    ${key}:`), `${lang} catalog is missing ${key}`);
    }
  }
});
