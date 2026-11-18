/**
 * Toolbar right end (frame 01, node `9:45`).
 *
 * The frame ends the toolbar with a `Switch` (28 x 16, knob on the right) and the
 * word `Ribbons`, a divider, then the panel toggle. The switch was built, then
 * retired, then restored, and the owner has now asked for it gone for good: the
 * lane gutter already names every branch, and the switch only dimmed a stripe.
 * These tests pin the removal, so a later pass cannot quietly bring it back.
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

test('the Ribbons switch and its state are gone', () => {
  const body = toolbar();
  assert.doesNotMatch(body, /gc-switch|role="switch"/, 'no switch in the toolbar');
  assert.doesNotMatch(body, /ribbons|Ribbons/, 'and no leftover prop or label');
  const src = read(CANVAS);
  assert.doesNotMatch(src, /showRibbons|onToggleRibbons/, 'the canvas owns no such state');
  assert.doesNotMatch(read('src/webview/bridge.ts'), /showRibbons/, 'and it left the webview state');
});

test('the quiet lane band left with the switch', () => {
  // `--quiet` existed only for the switch's off position. With the switch gone the
  // ternary has one branch, so the class and its rule must go too.
  assert.doesNotMatch(read(CSS), /gc-canvas__lane-band--quiet/, 'no dead band class');
});

test('the catalogs no longer name a switch that does not exist', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    assert.doesNotMatch(catalog, /toggleRibbons/, `${lang} still carries a dead key`);
  }
});

test('the panel toggle is the frame quiet glyph, not a pressed button', () => {
  const css = read(CSS);
  // The generic `[aria-expanded='true']` rule fills any expanded icon button, so
  // a toggle that is on by default reads as permanently pressed. The frame draws
  // the same glyph on and off.
  const rule = css.match(/\.gc-toolbar__panel-toggle[^{]*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(rule.length > 0, 'the toggle has its own rule');
  assert.match(rule, /background:\s*transparent/, 'no fill of its own');
  assert.match(
    css,
    /\.gc-icon-button\[aria-expanded='true'\]:not\(\.gc-explorer__aside-toggle\):not\(\.gc-toolbar__panel-toggle\)/,
    'the pressed-fill rule excludes the panel toggle',
  );
});

test('the panel toggle is the last control on the row', () => {
  const body = toolbar();
  const toggle = body.indexOf('gc-toolbar__panel-toggle');
  assert.ok(toggle > 0, 'the toggle is in the toolbar');
  const after = body.slice(toggle);
  // Nothing but the closing tags may follow the toggle's own button element.
  assert.doesNotMatch(after, /<button/, 'no control sits past the toggle');
});
