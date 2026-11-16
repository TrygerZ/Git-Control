/**
 * Graph toolbar (frame 01, node `9:45`).
 *
 * The frame is ONE 44 px row, left to right:
 *   `Search hash, message, author...` (320 px) | `Checkout <branch>` |
 *   `Show  All branches` | divider | `500 commits  Load older` | divider | panel
 * and the controls carry visible labels, not only accessible ones: `Checkout` and
 * `Show` are words in the frame, and the commit count sits at the right end of the
 * filter group, not before the dropdowns.
 *
 * The implementation wrapped to two rows, put the count second, and hid the two
 * labels in `aria-label`. These contracts pin the frame's order and words.
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

function toolbar(): string {
  const src = read(CANVAS);
  const start = src.indexOf('function Toolbar');
  assert.ok(start > 0, 'the Toolbar component exists');
  return src.slice(start, src.indexOf('\nexport function GraphCanvas', start));
}

test('the checkout and show controls carry the frame words as visible labels', () => {
  const body = toolbar();
  // `Checkout` and `Show` are the frame's words (`9:62`, `9:67`). They are visible
  // text, not only an accessible name: a dropdown that reads `main (current)` with
  // no verb does not say whether it switches or filters.
  assert.match(body, /strings\.graph\.checkoutBranchLabel/, 'the Checkout label renders');
  assert.match(body, /strings\.graph\.showLabel/, 'the Show label renders');
  assert.match(body, /gc-toolbar__label/, 'both use the quiet toolbar label style');
  // The accessible names stay: the visible label names the group, not the value.
  assert.match(body, /aria-label=\{strings\.graph\.checkoutBranchAria\}/);
  assert.match(body, /aria-label=\{strings\.graph\.branchFilterAria\}/);
});

test('the count sits at the right end of the filter group, after the dropdowns', () => {
  const body = toolbar();
  const count = body.indexOf('gc-toolbar__count');
  const checkout = body.indexOf('BranchSelector');
  const show = body.indexOf('gc-toolbar__branch-select');
  assert.ok(checkout > 0 && show > 0 && count > 0, 'all three render');
  assert.ok(count > checkout, 'the count follows the checkout dropdown');
  assert.ok(count > show, 'and the show dropdown');
  // Load older follows the count, as the frame draws `500 commits  Load older`.
  const load = body.indexOf('gc-toolbar__load-older');
  assert.ok(load > count, 'Load older follows the count');
});

test('the row does not wrap: the frame is one 44 px strip', () => {
  const css = read(CSS);
  const row = css.match(/\.gc-toolbar--filters\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(row.length > 0, 'the filter row has a rule');
  assert.match(row, /flex-wrap:\s*nowrap/, 'one row, always');
  assert.match(row, /min-height:\s*(44px|var\(--gc-space-7\))/, 'the frame height');
  // The search field is the only element allowed to absorb spare width.
  assert.match(row, /align-items:\s*center/);
  const search = css.match(/\.gc-toolbar__search-wrap\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(search, /flex:\s*1 1/, 'the search field grows');
  const count = css.match(/\.gc-toolbar__count\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(count, /margin:\s*0 0 0 auto/, 'the count no longer pushes itself right');
});

test('the frame dividers separate the count group and the panel toggle', () => {
  const body = toolbar();
  assert.match(body, /gc-toolbar__divider/, 'a divider element exists');
  const dividers = body.match(/gc-toolbar__divider/g) ?? [];
  assert.equal(dividers.length, 2, 'two dividers, as the frame draws them');
  const css = read(CSS);
  assert.match(css, /\.gc-toolbar__divider\s*\{[^}]*width:\s*1px/, 'a hairline rule');
});

test('both catalogs name the Show label', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    assert.ok(catalog.includes('    showLabel:'), `${lang} catalog is missing showLabel`);
  }
});
