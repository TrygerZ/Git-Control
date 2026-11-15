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

test('the Ribbons switch is gone: the lane gutter already answers what it toggled', () => {
  // The gutter names every lane in place, permanently, which is what the ribbon
  // trail was for. Keeping both means two answers to one question, one of them a
  // switch the user has to know about. Frame 01 draws no switch either.
  const src = read(CANVAS);
  assert.doesNotMatch(src, /toggleRibbons|showRibbons/, 'no switch, no state');
  assert.doesNotMatch(src, /gc-branch-ribbon|computeBranchRibbons/, 'no ribbon paths are drawn');
  assert.doesNotMatch(read('src/webview/styles.css'), /\.gc-branch-ribbon/, 'no ribbon styles remain');
  assert.doesNotMatch(read('src/webview/bridge.ts'), /showRibbons/, 'no persisted setting remains');
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

test('the legend pill sits beside the minimap on the canvas bottom edge', () => {
  // Frame 01 bottom row: minimap at x 167-384, pill at x 401-565, both ending at
  // y 882. The pill is a sibling of the minimap in that row, not a banner floating
  // above the graph. Anchoring it 176 px up put it on top of a commit row once the
  // lanes grew to the frame pitch.
  const css = read('src/webview/styles.css');
  const pill = css.match(/\.gc-legend-pill\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(pill.length > 0, 'the pill has a rule');
  // A static flex item: the row positions it, and nothing here pretends otherwise.
  assert.doesNotMatch(pill, /position:\s*absolute/, 'the pill is a flex item, not a floater');
  assert.doesNotMatch(pill, /left:\s*50%/, 'it is not centred on the canvas');
  assert.doesNotMatch(pill, /transform:/, 'no centring transform');
  assert.doesNotMatch(pill, /bottom:/, 'the row owns the offset, not the pill');

  // The row is what carries the placement, shared with the minimap.
  const row = css.match(/\.gc-canvas__bottom-row\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(row.length > 0, 'the row has a rule');
  assert.match(row, /position:\s*absolute/);
  assert.match(row, /bottom:\s*var\(--gc-space-4\)/, 'the minimap and pill share one bottom edge');
  assert.match(row, /display:\s*flex/);
  assert.match(row, /align-items:\s*flex-end/, 'both items rest on that edge');

  // One positioned row holds both, so they cannot drift apart.
  const src = read(CANVAS);
  const wrap = src.indexOf('gc-minimap-wrap');
  const pillMarkup = src.indexOf('gc-legend-pill');
  assert.ok(wrap > 0 && pillMarkup > wrap, 'the pill follows the minimap in the same bottom row');
  const rowAt = src.indexOf('gc-canvas__bottom-row');
  assert.ok(rowAt > 0 && rowAt < wrap, 'both live inside the row');
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
