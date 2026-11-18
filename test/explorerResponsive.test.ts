/**
 * Explorer responsiveness with the sidebar open (owner report, 2026-11-18).
 *
 * Measured at a 778 px explorer pane with the aside open: the toolbar overflowed
 * by 97 px, and the Ribbons switch, its divider, and the panel toggle were all
 * past the right edge, so the control that reopens the details panel disappeared
 * exactly when the user needed it. `flex-wrap: nowrap` plus fixed-width children
 * is what did it.
 *
 * Frame 01 is one 44 px strip at 1440 px. Below that the frame cannot hold, and a
 * clipped control is worse than a second row.
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

/** Body of the first `@media` block whose condition contains `needle`. */
function mediaBlock(needle: string): string {
  const css = read(CSS);
  const at = css.indexOf(`@media (${needle}`);
  assert.ok(at > 0, `a media query for ${needle} exists`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

test('the toolbar wraps instead of clipping when the pane is narrow', () => {
  // One row is the frame's shape, not a rule that may hide controls. A wrapping
  // row keeps the panel toggle reachable at every width.
  const block = mediaBlock('max-width: 1100px');
  const toolbar = block.match(/\.gc-toolbar--filters\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(toolbar.length > 0, 'the narrow breakpoint addresses the toolbar');
  assert.match(toolbar, /flex-wrap:\s*wrap/, 'it wraps');
  assert.match(toolbar, /min-height/, 'and keeps its height floor');
});

test('the panel toggle is pinned to the right end at every width', () => {
  const css = read(CSS);
  const toggle = css.match(/\.gc-toolbar__panel-toggle\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(toggle.length > 0, 'the toggle has a rule');
  assert.match(toggle, /margin-left:\s*auto/, 'nothing can push it off the row');
  assert.match(toggle, /flex:\s*0 0 auto/, 'and it never shrinks away');
});

test('the visible frame labels collapse before the controls do', () => {
  // `Checkout` and `Show` are frame words, and the first thing to give up when
  // the row is tight: the control each one names is still there, and its
  // accessible name was never the visible label.
  const block = mediaBlock('max-width: 1100px');
  assert.match(block, /\.gc-toolbar__label\s*\{[^}]*display:\s*none/, 'labels hide when narrow');
  const css = read(CSS);
  const label = css.match(/\.gc-toolbar__label\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(label, /white-space:\s*nowrap/, 'and never wrap at wide widths');
});

test('the aside gives up width before the graph does', () => {
  const css = read(CSS);
  const aside = css.match(/\.gc-explorer__aside\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(aside.length > 0, 'the aside has a rule');
  // `0 1 320px`: no growth, allowed to shrink, 320 as the preferred width.
  assert.match(aside, /flex:\s*0 1 320px/, 'the aside can shrink');
  assert.match(aside, /min-width:/, 'down to a floor');
});
