/**
 * Toolbar right end (frame 01, node `9:45`).
 *
 * The frame ends the toolbar with a `Switch` (28 x 16, knob on the right) and the
 * word `Ribbons`, a divider, then the panel toggle. The app has a checkbox-shaped
 * control in an earlier commit and none now, and its panel toggle is the generic
 * icon button with a hover fill and an inset focus rule, so it reads as a pressed
 * button rather than the frame's quiet glyph.
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

test('the Ribbons switch is back, as a switch and not a checkbox', () => {
  const body = toolbar();
  assert.match(body, /gc-switch/, 'the switch has its own element');
  assert.match(body, /role="switch"/, 'announced as a switch');
  assert.match(body, /aria-checked=\{/, 'and reports its state');
  assert.match(body, /strings\.graph\.toggleRibbonsLabel/, 'the frame word labels it');
  // The frame draws the word beside the control, not only in an accessible name.
  assert.match(body, /gc-switch__label/, 'a visible label span');
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

test('the switch and the label sit before the divider and the toggle', () => {
  const body = toolbar();
  const sw = body.indexOf('gc-switch');
  const divider = body.indexOf('gc-toolbar__divider', body.indexOf('gc-toolbar__count'));
  const toggle = body.indexOf('gc-toolbar__panel-toggle');
  assert.ok(sw > 0 && divider > sw && toggle > divider, 'frame order: switch, divider, toggle');
});

test('both catalogs name the switch', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    for (const key of ['toggleRibbonsLabel', 'toggleRibbonsAria']) {
      assert.ok(catalog.includes(`    ${key}:`), `${lang} catalog is missing ${key}`);
    }
  }
});
