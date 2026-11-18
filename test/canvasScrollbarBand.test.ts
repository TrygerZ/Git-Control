/**
 * Canvas floating chrome versus the scrollbars (owner report, 2026-11-18).
 *
 * The minimap, the legend pill, and the zoom bar sat 12 px off the canvas edge.
 * The canvas scrolls both ways, so its horizontal scrollbar and the corner box
 * occupy that band: measured at a 700 px pane, the bars take 19 px and 18 px, and
 * the minimap's bottom edge ran into the horizontal bar.
 *
 * The fix is to reserve the scrollbar band once, so every floating item clears it.
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

const CSS = 'src/webview/styles.css';

test('the canvas reserves its scrollbar band once, as a local variable', () => {
  // It must sit on `.gc-graph__stage`, not `.gc-canvas`: the floating chrome is
  // absolutely positioned against the stage, so a variable declared on the canvas
  // child never reaches them and `calc()` collapses to `bottom: auto`. Measured
  // in the browser after putting it on the canvas: the minimap rendered at the
  // stage's top edge instead of its bottom.
  const css = read(CSS);
  const stage = css.match(/^\.gc-graph__stage\s*\{([^}]*)\}/m)?.[1] ?? '';
  assert.ok(stage.length > 0, 'the stage has a rule');
  assert.match(stage, /--gc-scrollbar-band:\s*\d+px/, 'the band is a named width');
  const canvas = css.match(/^\.gc-canvas\s*\{([^}]*)\}/m)?.[1] ?? '';
  assert.doesNotMatch(canvas, /--gc-scrollbar-band/, 'not on the scroll container');
});

test('both floating groups clear the band above the scrollbar', () => {
  const css = read(CSS);
  for (const selector of ['gc-canvas__bottom-row', 'gc-canvas__controls']) {
    const rule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    assert.ok(rule.length > 0, `${selector} has a rule`);
    assert.match(
      rule,
      /bottom:\s*calc\(var\(--gc-scrollbar-band\)/,
      `${selector} sits above the scrollbar, not on it`,
    );
  }
});

test('the zoom bar keeps clear of the vertical scrollbar too', () => {
  const css = read(CSS);
  const rule = css.match(/\.gc-canvas__controls\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /right:\s*calc\(var\(--gc-scrollbar-band\)/, 'right edge clears the band');
});
