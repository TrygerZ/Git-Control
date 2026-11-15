/**
 * Canvas toolbar, zoom controls, and legend pill (frame 01).
 *
 * Three rows of the frame, one contract:
 *  - `9:45` toolbar: a search input, a checkout dropdown, a show dropdown, the
 *    commit count with `Load older`, the Ribbons switch, and the right-panel
 *    toggle. No visible form labels.
 *  - `10:158` zoom bar: minus, percent, plus, divider, maximize, crosshair.
 *  - `10:184` legend: a 166x28 pill naming the two node states in place, not a
 *    button that opens a teaching panel.
 *
 * Source-level, like the other view contracts: no DOM harness exists here.
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

test('the toolbar drops the three static form labels the frame never draws', () => {
  const src = read(CANVAS);
  for (const label of ['searchLabel', 'checkoutBranchLabel', 'branchFilterLabel']) {
    assert.doesNotMatch(
      src,
      new RegExp(`gc-field__label">\\{strings\\.graph\\.${label}\\}`),
      `${label} must not render as visible text`,
    );
  }
  // The controls keep their accessible names, which is what the labels were for.
  assert.match(src, /aria-label=\{strings\.graph\.searchAria\}|aria-label=\{strings\.graph\.searchLabel\}/);
  assert.match(src, /aria-label=\{strings\.graph\.checkoutBranchAria\}/);
  assert.match(src, /aria-label=\{strings\.graph\.branchFilterAria\}/);
});

test('the commit count and Load older live in the toolbar, as frame 01 draws them', () => {
  const src = read(CANVAS);
  const toolbar = src.slice(src.indexOf('function Toolbar'), src.indexOf('function Toolbar') + 4000);
  assert.match(toolbar, /countId|countAll|countMatched/, 'the count is inside the toolbar');
  assert.match(toolbar, /loadOlder|moreButton/, 'Load older is inside the toolbar');
  assert.doesNotMatch(
    src,
    /<p className="gc-help-text"[\s\S]{0,200}countAll/,
    'the count is no longer a paragraph above the canvas',
  );
});

test('the Ribbons switch moved from the floating stack into the toolbar', () => {
  const src = read(CANVAS);
  const controls = src.slice(src.indexOf('gc-canvas__controls'));
  assert.doesNotMatch(controls, /toggleRibbons/, 'the switch is not in the floating controls');
  const toolbar = src.slice(src.indexOf('function Toolbar'), src.indexOf('function Toolbar') + 4000);
  assert.match(toolbar, /toggleRibbons/, 'the switch is in the toolbar');
  assert.match(toolbar, /showRibbons/, 'and it reads the same state the canvas renders');
});

test('the right-panel toggle is a toolbar button, not an aside header control', () => {
  const canvas = read(CANVAS);
  assert.match(canvas, /strings\.graph\.panelToggleAria|panelToggle/, 'the toolbar owns the toggle');
  assert.match(canvas, /panel-right/, 'frame 01 draws the panel-right glyph');
  assert.match(canvas, /aria-expanded=\{/, 'the toggle reports the panel state');

  const app = read('src/webview/ExplorerApp.tsx');
  assert.doesNotMatch(app, /gc-explorer__aside-toggle/, 'the aside header no longer carries it');
  assert.match(app, /inspectorOpen/, 'the panel still opens and closes');
  assert.match(app, /onToggleInspector|setInspectorOpen/, 'the toolbar drives it');
});

test('the zoom bar carries maximize and crosshair beside plus', () => {
  const src = read(CANVAS);
  const controls = src.slice(src.indexOf('gc-canvas__controls'));
  for (const key of ['zoomOutAria', 'zoomResetAria', 'zoomInAria', 'zoomFitAria', 'zoomHeadAria']) {
    assert.match(controls, new RegExp(`strings\\.graph\\.${key}`), `${key} is a control`);
  }
  assert.match(src, /name="maximize"/, 'frame 10:158 draws a maximize glyph');
  assert.match(src, /name="crosshair"/, 'and a crosshair glyph');
});

test('fit computes a zoom that fills the viewport, and centre targets the HEAD row', () => {
  const src = read(CANVAS);
  // Fit must change the zoom, not the scroll: the frame's maximize is a scale.
  assert.match(src, /setZoom\(/);
  assert.match(src, /fitZoom|zoomToFit|fitToWindow/, 'a pure fit helper decides the value');
  // Crosshair reuses the existing reveal path, so HEAD lands centred.
  assert.match(src, /goToRow\(headRow\)|scrollToCommit\(/);
});

test('the legend is a pill in place, with both frame states named', () => {
  const src = read(CANVAS);
  assert.match(src, /gc-legend-pill/, 'the pill has its own element');
  assert.match(src, /strings\.graph\.legendPushed/);
  assert.match(src, /strings\.graph\.legendNotPushed/);
  // The popover launcher is gone: the frame shows the answer, not a door to it.
  assert.doesNotMatch(src, /legendButtonRef/, 'no launcher button remains');
  assert.doesNotMatch(src, /showLegend|legendPanelRef/, 'no popover state remains');
  // Only the teaching panel is gone. `BranchSelector` is declared in the same
  // file and is still the checkout control the toolbar renders.
  assert.doesNotMatch(src, /<BranchLegend\b/, 'the teaching panel is not mounted from the canvas');
  assert.match(src, /BranchSelector/, 'the checkout control is still the shared component');
});

test('the pill keeps both states distinguishable without colour', () => {
  const css = read('src/webview/styles.css');
  const pill = css.match(/\.gc-legend-pill\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(pill.length > 0, 'the pill has a rule');
  assert.match(css, /\.gc-legend-pill__dot--pushed\s*\{/, 'a filled swatch');
  assert.match(css, /\.gc-legend-pill__dot--local\s*\{/, 'a hollow swatch');
  // Hollow means a border, not a lighter fill: shape is the second channel.
  const local = css.match(/\.gc-legend-pill__dot--local\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(local, /border|outline/);
  const literals = css.match(/\.gc-legend-pill[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.deepEqual(literals, [], 'no literal colour');
});

test('both catalogs name every new toolbar and legend string', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    for (const key of [
      'searchAria',
      'branchFilterAria',
      'panelToggleAria',
      'panelToggleTitle',
      'zoomFitAria',
      'zoomFitTitle',
      'zoomHeadAria',
      'zoomHeadTitle',
      'legendPushed',
      'legendNotPushed',
    ]) {
      assert.ok(catalog.includes(`    ${key}:`), `${lang} catalog is missing ${key}`);
    }
  }
});
