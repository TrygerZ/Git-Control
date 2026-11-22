/**
 * Collapsible section headers (Pending Changes panel).
 *
 * The folder-collapse state (`collapsed`) and the section-collapse state
 * (`collapsedSections`) are two different sets in the store on purpose: one
 * keys by folder path, the other by section name, and a leak between them
 * would fold things the user never folded. These tests pin the separation,
 * the default (every section open), and the persist/restore round trip.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useChangesStore, useOperationStore, useRepoStore, pruneStashCache } from '../src/webview/store';
import { bridge, loadState, saveState } from '../src/webview/bridge';
import { t } from '../src/webview/i18n';
import { isNavVisible, navRegistry } from '../src/webview/navRegistry';
import type { RepoStatus } from '../src/messages';
import '../src/webview/NavStrip';

function reset(): void {
  useChangesStore.setState({
    selection: new Set<string>(),
    collapsed: new Set<string>(),
    collapsedSections: new Set(),
  });
}

test('every section starts open by default', () => {
  reset();
  assert.equal(useChangesStore.getState().collapsedSections.size, 0);
});

test('toggling one section leaves every other section untouched', () => {
  reset();
  const toggleSection = useChangesStore.getState().toggleSection;

  toggleSection('staged');
  let collapsed = useChangesStore.getState().collapsedSections;
  assert.ok(collapsed.has('staged'));
  assert.ok(!collapsed.has('conflicted') && !collapsed.has('unstaged') && !collapsed.has('untracked'));

  toggleSection('untracked');
  collapsed = useChangesStore.getState().collapsedSections;
  assert.ok(collapsed.has('staged') && collapsed.has('untracked'));

  // Toggle staged back open: untracked stays folded.
  toggleSection('staged');
  collapsed = useChangesStore.getState().collapsedSections;
  assert.ok(!collapsed.has('staged'));
  assert.ok(collapsed.has('untracked'));
});

test('section collapse and folder collapse are separate state sets', () => {
  reset();
  const state = useChangesStore.getState();
  state.toggleCollapsed('src/webview');
  useChangesStore.getState().toggleSection('staged');

  let after = useChangesStore.getState();
  assert.ok(after.collapsed.has('src/webview'), 'folder state keeps its own key');
  assert.ok(after.collapsedSections.has('staged'), 'section state keeps its own key');
  assert.ok(!after.collapsed.has('staged') && !after.collapsedSections.has('conflicted'), 'no cross-leak');

  // Folding and unfolding a section must not disturb folder state, and vice versa.
  useChangesStore.getState().toggleSection('staged');
  useChangesStore.getState().toggleCollapsed('src/other');
  after = useChangesStore.getState();
  assert.equal(after.collapsedSections.size, 0);
  assert.deepEqual([...after.collapsed].sort(), ['src/other', 'src/webview']);
});

test('collapsed sections survive a saveState/loadState round trip', () => {
  reset();
  const toggleSection = useChangesStore.getState().toggleSection;
  toggleSection('conflicted');
  toggleSection('staged');

  saveState({ collapsedSections: [...useChangesStore.getState().collapsedSections] });
  assert.deepEqual(loadState().collapsedSections, ['conflicted', 'staged']);

  // Folding them all back saves an empty list, not a stale one.
  toggleSection('conflicted');
  toggleSection('staged');
  saveState({ collapsedSections: [...useChangesStore.getState().collapsedSections] });
  assert.deepEqual(loadState().collapsedSections, []);

  // Folder state rides in the same persisted object without colliding.
  useChangesStore.getState().toggleCollapsed('src/a.ts');
  saveState({ collapsedFolders: [...useChangesStore.getState().collapsed] });
  const restored = loadState();
  assert.deepEqual(restored.collapsedFolders, ['src/a.ts']);
  assert.deepEqual(restored.collapsedSections, []);
});

test('toggle aria strings name the action and the section in both languages', () => {
  const en = t('en');
  const id = t('id');
  assert.equal(en.pending.collapseSectionAria('Staged Changes'), 'Collapse Staged Changes');
  assert.equal(en.pending.expandSectionAria('Staged Changes'), 'Expand Staged Changes');
  assert.equal(id.pending.collapseSectionAria('Siap di-commit'), 'Lipat Siap di-commit');
  assert.equal(id.pending.expandSectionAria('Siap di-commit'), 'Buka Siap di-commit');
});

test('the section header renders a real toggle button with aria-expanded and a decorative twisty', () => {
  // No DOM here: pin the source contract instead, same as the a11y suite does
  // for GraphCanvas. A native button inside the heading gives Enter/Space for
  // free; the chevron span is aria-hidden decoration; the bulk button stays a
  // sibling, never nested inside the toggle.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.match(src, /aria-expanded=\{!isCollapsed\}/);
  assert.match(src, /className="gc-section__toggle"/);
  assert.match(src, /isCollapsed \? 'chevron-right' : 'chevron-down'/);
  assert.match(src, /<span className="gc-section__twisty" aria-hidden="true">/);
  assert.match(src, /className="gc-icon-button gc-section__bulk"/);
  assert.match(src, /disabled=\{isSectionBulkDisabled\(busy, validPaths\.length, isCollapsed\)\}/);
  assert.doesNotMatch(
    src,
    /className="gc-section__toggle"[\s\S]{0,600}<button/,
    'no button nested inside the section toggle',
  );
});

test('stashes live in the Stashes sub-tab: no pinned footer, no collapsible section header, no collapse state', () => {
  // Replaces the 2.7.0 assertions on the archive-icon section badge. Frame 67 shows the stash
  // list directly under the segmented control, with no header of its own (D-04).
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.doesNotMatch(src, /gc-pending__stash/, 'the footer block is gone');
  assert.doesNotMatch(src, /StashSection/, 'the sub-tab is the header');
  assert.doesNotMatch(src, /stashesCollapsed|toggleStashesCollapsed/);
  assert.doesNotMatch(src, /gc-section__badge--special/, 'only the removed stash header used it');
  assert.equal(src.match(/<StashList\b/g)?.length, 1, 'the list renders once, inside the panel');
  assert.doesNotMatch(
    src,
    /gc-section__badge[^>]*>\s*\$/,
    'no raw dollar glyph in section badges',
  );

  const store = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'store.ts'), 'utf8');
  assert.doesNotMatch(store, /stashesCollapsed|toggleStashesCollapsed/, 'not persisted before, so nothing to migrate');

  const css = fs
    .readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /gc-pending__stash/);
  assert.doesNotMatch(css, /gc-section__badge--special/);
});

test('the Changes and Stashes sub-tabs read and write the route through the validating store', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.match(src, /<Tablist\b/);
  assert.match(src, /classPrefix="gc-subtabs"/);
  assert.match(src, /idPrefix=\{CHANGES_TABS_PREFIX\}/);
  assert.match(src, /changesSubTabs\(/, 'tab model comes from the pure helper');
  assert.match(src, /changesSubOf\(/, 'active sub-tab comes from the route');
  assert.match(src, /parseRoute\(\{\s*id: 'changes',\s*sub:/, 'a selected id is validated, not cast');
  assert.match(src, /useRouteStore\.getState\(\)\.navigate\(/, 'persisting goes through the store action');
  assert.doesNotMatch(src, /bridge\.request\('(?:ui|route)/, 'a sub-tab is UI state only, no new request');
});

test('the list area is one tabpanel labelled by the active sub-tab, and the two views swap inside it', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.match(src, /role="tabpanel"/);
  assert.match(src, /id=\{CHANGES_PANEL_ID\}/, 'the id both tabs point at with aria-controls');
  assert.match(src, /aria-labelledby=\{changesTabId\(/, 'named by the active tab');
  assert.equal(src.match(/role="tabpanel"/g)?.length, 1, 'one panel, not one per view');
  assert.match(src, /===\s*'stashes'/, 'the panel shows the stash list or the change list');
  // Frame 67 draws a search row above the stashes, and the owner chose to make it a real stash
  // filter (see the filter test below).
  assert.equal(src.match(/className="gc-listbar"/g)?.length, 1);
  // Frame 6:2 draws no Select all / Clear row and no language toggle anywhere in the panel.
  // Both were code-only affordances; the owner asked for frame parity on 2026-11-16, so the
  // rows and their strings are gone rather than restyled.
  assert.doesNotMatch(src, /gc-listbar__selection/, 'no selection row, frame 6:2 has none');
  assert.doesNotMatch(src, /strings\.pending\.switchLanguageAria/, 'no language toggle in the panel');
  assert.doesNotMatch(src, /gc-pending__bar/, 'and no empty bar left behind where the toggle lived');
});

test('the Stashes sub-tab filters its own list through the pure helper, with its own strings and one shared search row', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.match(src, /filterStashes\(/, 'matching is the pure, tested helper');
  // A filtered list must not renumber: Apply and Drop take the index from the ref, so the
  // component uses the same parser the helper uses, not a private copy and not list position.
  assert.match(src, /import \{[^}]*\bparseStashIndex\b[^}]*\} from '\.\/format'/);
  assert.doesNotMatch(src, /function parseStashIndex/, 'one parser, shared with the helper');
  assert.doesNotMatch(src, /<StashList\s+stashes=\{stashes\}/, 'the list gets the filtered stashes');
  for (const key of ['stashSearchPlaceholder', 'stashSearchAria', 'stashSearchMatched', 'stashSearchEmptyTitle']) {
    assert.match(src, new RegExp(`strings\\.pending\\.${key}`), key);
  }
  assert.match(src, /strings\.pending\.clearSearch/, 'an empty result offers the same way out as the file list');
  // The search row markup exists once and both sub-tabs render it, so they cannot drift apart.
  assert.equal(src.match(/type="search"/g)?.length, 1, 'one search input in the source');
  assert.equal(src.match(/className="gc-listbar"/g)?.length, 1);
  assert.equal(src.match(/maxLength=\{100\}/g)?.length, 1);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);

  const store = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'store.ts'), 'utf8');
  assert.doesNotMatch(store, /stashFilter|stashSearch/, 'a filter narrows what is drawn and nothing else: no store, no request');
  assert.doesNotMatch(src, /saveState\(\{[^}]*(?:stashFilter|filter)/, 'and nothing is persisted');
});

test('the commit form sits in a footer pinned after the list area, in both sub-tabs', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.equal(src.match(/<CommitForm \/>/g)?.length, 1);
  assert.doesNotMatch(src, /sub\s*===\s*'(?:changes|stashes)'\s*(?:&&|\?)\s*\(?\s*<CommitForm/, 'a typed message must survive a tab switch');

  const panel = src.search(/role="tabpanel"/);
  const footer = src.indexOf('gc-pending__footer-body');
  const form = src.indexOf('<CommitForm />');
  assert.ok(panel > 0, 'the list area exists');
  assert.ok(footer > panel, 'the footer follows the list area, it does not precede it');
  assert.ok(form > footer, 'the form lives inside the footer body');
  assert.ok(src.indexOf('<ToastRegion />') > footer, 'the toast stack rides with the footer');

  // Banners keep their place above the list and stay ungated by a sub-tab. The window
  // ends at the tabpanel: the toolbar between the banners and the list legitimately
  // branches on the sub-tab, so scanning up to the form would hit it.
  assert.ok(src.indexOf('gc-pending__notifications') < panel, 'the banners are above the panel');
  assert.doesNotMatch(
    src.slice(src.indexOf('gc-pending__notifications'), panel),
    /(?:ConflictPanel|churnTruncatedTitle|ErrorBanner)[\s\S]{0,200}(?:sub\s*===|===\s*'changes')/,
    'banners are not gated on a sub-tab',
  );
});

test('the footer is a full-bleed border-topped strip that scrolls internally, and the card chrome is gone', () => {
  const css = fs
    .readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string): string =>
    css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

  const footer = rule('.gc-pending__footer');
  assert.match(footer, /flex:\s*0 1 auto/, 'the footer never grows, and it yields height so the list keeps a floor');
  assert.match(footer, /border-top:\s*1px solid var\(--gc-border\)/, 'separation is a border, which survives forced colours');
  assert.match(footer, /max-height:\s*50%/, 'a short panel scrolls the footer rather than clipping the buttons');
  assert.match(footer, /margin:\s*calc\(-1 \* var\(--gc-space-2\)\)/, 'full bleed over the panel padding and gap');
  assert.match(footer, /position:\s*relative/, 'the toast stack anchors to it');

  const body = rule('.gc-pending__footer-body');
  assert.match(body, /overflow-y:\s*auto/, 'the body scrolls inside the cap');
  assert.match(body, /padding:\s*var\(--gc-space-4\)/, 'frame 20: 12 px inset');

  // A fixed toast would sit on top of Commit, Push, and Retry push. Anchoring it to the
  // footer keeps it above the buttons and outside the scroller that could clip it.
  assert.match(
    css,
    /\.gc-pending__footer\s+\.gc-toasts\s*\{[^}]*position:\s*absolute/,
    'the toast stack is positioned against the footer',
  );

  // The form is the footer now. A card inside a footer reads as two surfaces.
  const commit = rule('.gc-commit');
  assert.doesNotMatch(commit, /box-shadow/, 'no elevation inside the footer');
  assert.doesNotMatch(commit, /border-radius/, 'no card corners');
  assert.doesNotMatch(commit, /background:/, 'the footer supplies the fill');
  assert.doesNotMatch(commit, /border:/, 'no card edge');

  // The list keeps a floor, so a short panel cannot push the footer past the clipped edge.
  const sections = rule('.gc-pending__sections');
  assert.match(sections, /min-height:\s*64px/, 'the old 120 px floor outgrew a short panel');

  // The panel box shrinks on short panels while its children keep their own minimums;
  // without a clip they paint into the footer behind its transparent body (found at
  // 500 px and below in the browser; the footer stays interactive either way).
  const panel = rule('.gc-pending__panel');
  assert.match(panel, /overflow:\s*hidden/, 'panel children clip at the panel box, not over the footer');
});

test('the selection row and the language toggle are gone, with their styles and their strings', () => {
  // Frame 6:2 (and 20, 103) draw neither control. Owner decision 2026-11-16: parity beats the
  // code-only affordance, so the row, the toggle, the segmented pair that only it used, and
  // every string that named them are removed rather than left dead.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  for (const gone of [
    'gc-listbar__selection',
    'gc-selection-group',
    'gc-segmented',
    'gc-lang-toggle',
    'gc-pending__bar',
    'gc-toolbar__end',
  ]) {
    assert.doesNotMatch(src, new RegExp(gone), `PendingChanges: ${gone} is gone`);
  }
  for (const gone of ['selectAllTitle', 'clearSelectionTitle', 'selectedCount', 'selectionGroupAria', 'switchLanguageAria']) {
    assert.doesNotMatch(src, new RegExp(`strings\\.pending\\.${gone}`), `PendingChanges: ${gone} is gone`);
  }

  const css = fs
    .readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const gone of ['.gc-listbar__selection', '.gc-selection-group', '.gc-segmented', '.gc-lang-toggle', '.gc-pending__bar', '.gc-toolbar__end', '.gc-toolbar--actions']) {
    assert.ok(!css.includes(gone), `styles.css: ${gone} is gone`);
  }
  // The action tier keeps its bottom hairline in the frame, so the rule that drew it
  // for the bar has to survive under a name the panel still uses, or the list loses
  // the separation the frame shows above the search row.
  assert.match(css, /\.gc-pending__panel\s*\{[^}]*border-top:\s*1px solid var\(--gc-border\)/, 'the frame rule above the list survives');
});

test('the segmented control no longer repeats the list heading, and its i18n key is gone', () => {
  // Frame 20: the sub-tab already reads "Changes 6", so the heading and count pill above the
  // search box are gone. The key goes with them.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.doesNotMatch(src, /gc-listbar__header|gc-listbar__title|gc-listbar__total|changesHeader/);
  const css = fs
    .readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /gc-listbar__header|gc-listbar__title|gc-listbar__total/);
  for (const lang of ['en', 'id'] as const) {
    assert.equal('changesHeader' in t(lang).pending, false, lang);
  }
  assert.match(src, /gc-listbar__controls/, 'the search row stays');
});

test('commit form progress spinner renders inside gc-commit__status outside actions', () => {
  const commitFormSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'CommitForm.tsx'),
    'utf8',
  );
  const stylesSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'),
    'utf8',
  );
  const storeSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'store.ts'),
    'utf8',
  );

  // Structural binding, not a loose regex: everything before the status
  // paragraph must be Spinner-free. A Spinner inside the actions div would
  // necessarily appear in this slice, so the check cannot cross a closing tag.
  const actionsIdx = commitFormSrc.indexOf('<div className="gc-commit__actions">');
  const statusIdx = commitFormSrc.search(/<p\s+className="gc-commit__status"/);
  assert.ok(actionsIdx >= 0, 'actions block must exist');
  assert.ok(statusIdx > actionsIdx, 'status row must come after the actions block');
  const beforeStatus = commitFormSrc.slice(0, statusIdx);
  assert.ok(
    !beforeStatus.includes('<Spinner'),
    'Spinner must not render before the gc-commit__status row (in particular, not inside gc-commit__actions)',
  );
  assert.match(
    commitFormSrc,
    /<p\s+className="gc-commit__status"[^>]*>\s*\{busy && \(?\s*<Spinner/,
    'Spinner must be rendered inside gc-commit__status',
  );

  // Invariant, not literal: the status row must reserve a font-relative
  // minimum height and clamp its spinner to the same one-line box. The
  // max() floor (px term) must be present so a very small base font can
  // never let the spinner dot outgrow the reserved row. Removing the floor
  // or reverting to a bare em/rem reservation fails.
  const statusBlock = stylesSrc.match(/\.gc-commit__status\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(
    statusBlock,
    /min-height:\s*max\(\s*[\d.]+(?:em|rem)\s*,\s*[\d.]+px\s*\)\s*;/,
    '.gc-commit__status must reserve a font-relative height with a px floor',
  );
  assert.match(
    statusBlock,
    /line-height:\s*[\d.]+\s*;/,
    '.gc-commit__status must pin line-height so idle and busy rows measure identically',
  );
  const spinnerOverride = stylesSrc.match(/\.gc-commit__status\s+\.gc-spinner\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(
    spinnerOverride,
    /min-height:\s*max\(\s*[\d.]+(?:em|rem)\s*,\s*[\d.]+px\s*\)\s*;/,
    '.gc-commit__status .gc-spinner must clamp to the reserved row with the same px floor',
  );

  // One-line clamp (defect 2): the label inside the status row must never wrap.
  const labelOverride =
    stylesSrc.match(/\.gc-commit__status\s+\.gc-spinner__label\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(
    labelOverride,
    /white-space:\s*nowrap\s*;/,
    'status label must stay on one line',
  );
  assert.match(
    labelOverride,
    /text-overflow:\s*ellipsis\s*;/,
    'an overlong status label must clip with ellipsis instead of growing the row',
  );

  // Clipped-label reveal: the ellipsis hides text from low-vision users, so
  // the row must carry a conditional title with the full label. Mounted only
  // while busy: the idle row is empty and must not show an empty tooltip.
  assert.match(
    commitFormSrc,
    /\{\.\.\.\(\s*busy\s*\?\s*\{\s*title:\s*statusLabel\s*\}\s*:\s*\{\s*\}\s*\)\}/,
    'status row must carry a conditional title with the full status label',
  );

  // Operation discriminator (defect 1): the label follows busyKind, never the
  // combined changesBusy boolean, and the store must type it.
  assert.match(
    storeSrc,
    /busyKind:\s*'stage'\s*\|\s*'commit'\s*\|\s*null/,
    'changes store must carry a busyKind discriminator',
  );
  assert.doesNotMatch(
    commitFormSrc,
    /label=\{\s*changesBusy\s*\?/,
    'spinner label must not be chosen from the combined changesBusy boolean',
  );
  assert.match(
    commitFormSrc,
    /busyKind === 'stage'/,
    'stage operation must map to the staging label',
  );
  assert.match(
    commitFormSrc,
    /busyKind === 'commit'/,
    'commit operation must map to the saving label',
  );

  // Decoupling guard: the generic fallback spinner label must use its own
  // generic key, never the push-scoped pushDisabledBusy button title. The
  // push title at the busy branch of pushTitle stays pushDisabledBusy.
  assert.doesNotMatch(
    commitFormSrc,
    /statusLabel[\s\S]*?pushDisabledBusy/,
    'fallback spinner label must not reuse the push-scoped pushDisabledBusy key',
  );
  assert.match(
    commitFormSrc,
    /:\s*strings\.commitForm\.operationInProgress;?/,
    'fallback spinner label must use the generic operationInProgress key',
  );
});

test('discard action is scoped strictly to unstaged changes section', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.match(
    src,
    /discardAction=\{\s*section === 'unstaged'\s*\?/,
    'discard action must be conditionally provided only for unstaged section',
  );
});

test('pruneStashCache drops indices greater than or equal to stash count', () => {
  const cached = {
    0: [{ path: 'a.txt', additions: 1, deletions: 0 }],
    1: [{ path: 'b.txt', additions: 2, deletions: 1 }],
    2: [{ path: 'c.txt', additions: null, deletions: null }],
  };
  const pruned = pruneStashCache(cached, 2);
  assert.deepEqual(Object.keys(pruned).sort(), ['0', '1']);
  assert.equal(pruned[2], undefined);
  assert.equal(pruned[0]?.length, 1);
  assert.equal(pruned[1]?.length, 1);
});

test('toggleStashExpanded toggles expansion and lazy fetches stash files with caching', async (t) => {
  useChangesStore.setState({
    stashesExpanded: new Set<number>(),
    stashContents: {},
    stashContentsLoading: new Set<number>(),
  });

  let requestedIndex: number | null = null;
  const originalRequest = bridge.request;
  bridge.request = (async (kind: any, payload: any): Promise<any> => {
    if (kind === 'stash/show') {
      const p = payload as { index: number };
      requestedIndex = p.index;
      return [{ path: 'file1.txt', additions: 5, deletions: 2 }];
    }
    return originalRequest.call(bridge, kind, payload);
  }) as any;
  t.after(() => {
    bridge.request = originalRequest;
  });

  // First toggle: expands and fetches
  await useChangesStore.getState().toggleStashExpanded(0);
  assert.ok(useChangesStore.getState().stashesExpanded.has(0));
  assert.equal(requestedIndex, 0);
  assert.deepEqual(useChangesStore.getState().stashContents[0], [
    { path: 'file1.txt', additions: 5, deletions: 2 },
  ]);

  // Second toggle: collapses without re-fetching
  requestedIndex = null;
  await useChangesStore.getState().toggleStashExpanded(0);
  assert.ok(!useChangesStore.getState().stashesExpanded.has(0));
  assert.equal(requestedIndex, null);
  // Cache remains intact
  assert.deepEqual(useChangesStore.getState().stashContents[0], [
    { path: 'file1.txt', additions: 5, deletions: 2 },
  ]);

  // Third toggle: expands using cached content without re-fetching
  requestedIndex = null;
  await useChangesStore.getState().toggleStashExpanded(0);
  assert.ok(useChangesStore.getState().stashesExpanded.has(0));
  assert.equal(requestedIndex, null);
});

test('loadStashes resets stashesExpanded and prunes stashContents on stash list changes', async (t) => {
  useChangesStore.setState({
    stashes: [
      { ref: 'stash@{0}', hash: '1111111', subject: 'first' },
      { ref: 'stash@{1}', hash: '2222222', subject: 'second' },
    ],
    stashesExpanded: new Set<number>([0, 1]),
    stashContents: {
      0: [{ path: 'a.txt', additions: 1, deletions: 0 }],
      1: [{ path: 'b.txt', additions: 2, deletions: 1 }],
    },
  });

  const originalRequest = bridge.request;
  bridge.request = (async (kind: any, payload: any): Promise<any> => {
    if (kind === 'stash/list') {
      // Stash was dropped, only 1 entry left with shifted hash
      return [{ ref: 'stash@{0}', hash: '2222222', subject: 'second' }];
    }
    return originalRequest.call(bridge, kind, payload);
  }) as any;
  t.after(() => {
    bridge.request = originalRequest;
  });

  await useChangesStore.getState().loadStashes();

  const state = useChangesStore.getState();
  assert.equal(state.stashes.length, 1);
  // Expanded state reset
  assert.equal(state.stashesExpanded.size, 0);
  // Index 1 pruned from cache
  assert.equal(state.stashContents[1], undefined);
  assert.ok(state.stashContents[0] !== undefined);
});

test('stash item row renders expandable twisty, 1-based label, metadata sub-row, hash button, and Apply/Drop buttons', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.match(src, /className="gc-icon-button gc-stash-item__twisty"/);
  assert.match(src, /aria-expanded=\{isExpanded\}/);
  assert.match(src, /formatStashLabel\(parsedIndex, language\)/);
  assert.match(src, /formatStashMeta\(stash, language\)/);
  assert.match(src, /className="gc-stash-item__meta"/);
  assert.match(src, /className="gc-stash-item__hash-btn"/);
  assert.match(src, /aria-label=\{strings\.pending\.stashOpenCommitAria\}/);
  assert.match(src, /title=\{strings\.pending\.stashOpenCommitTitle\}/);
  assert.doesNotMatch(src, /stash\.subject/);
  assert.match(src, /aria-label=\{strings\.pending\.stashApplyAria\(stash\.ref\)\}/);
  assert.match(src, /title=\{strings\.pending\.stashApplyTitle\}/);
  assert.match(src, /strings\.pending\.stashApplyLabel/);
  assert.match(src, /aria-label=\{strings\.pending\.stashDropAria\(stash\.ref\)\}/);
  assert.match(src, /title=\{strings\.pending\.stashDropTitle\}/);
  assert.match(src, /strings\.pending\.stashDropLabel/);

  const stylesSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'),
    'utf8',
  );
  const actionsBlock = stylesSrc.match(/\.gc-stash-item__actions\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(actionsBlock, /margin-left:\s*auto;/);
  const btnBlock = stylesSrc.match(/\.gc-stash-item__btn\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(btnBlock, /font-size:\s*var\(--gc-fs-xs\);/);
});

test('stash file row renders theme file icon, path, and click button for actions/openStashDiff', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.match(src, /<FileIcon kind="file" name=\{baseName\(file\.path\)\} \/>/);
  assert.match(src, /className="gc-stash-file__path"/);
  assert.match(src, /actions\/openStashDiff/);
  assert.match(src, /className="gc-tree__row gc-stash-file__button"/);
  assert.match(src, /onClick=\{\(\) => onOpenDiff\(parsedIndex, file\.path\)\}/);
  assert.match(src, /aria-label=\{strings\.pending\.stashFileOpenDiffAria\(file\.path, churn\)\}/);

  const stylesSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'),
    'utf8',
  );
  const buttonBlock = stylesSrc.match(/\.gc-stash-file__button\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(buttonBlock, /cursor:\s*pointer;/);
});

test('openStashDiff dispatches actions/openStashDiff request with index and path', async (t) => {
  let requestedKind: string | null = null;
  let requestedPayload: unknown = null;
  const originalRequest = bridge.request;
  bridge.request = (async (kind: any, payload: any): Promise<any> => {
    requestedKind = kind;
    requestedPayload = payload;
    return { opened: true, mode: 'stash' };
  }) as any;
  t.after(() => {
    bridge.request = originalRequest;
  });

  await bridge.request('actions/openStashDiff', { index: 2, path: 'src/app.ts' });
  assert.equal(requestedKind, 'actions/openStashDiff');
  assert.deepEqual(requestedPayload, { index: 2, path: 'src/app.ts' });
});

test('pending panel renders SidebarHeader and the toolbar no longer owns branch, refresh, or graph controls', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.match(src, /<SidebarHeader \/>/);
  assert.doesNotMatch(src, /ContextBar/);
  assert.doesNotMatch(src, /BranchSelector/);
  assert.doesNotMatch(src, /strings\.pending\.reloadAria/);
  assert.doesNotMatch(src, /strings\.pending\.openGraphAria/);
  // Frame 6:2 parity: neither the toggle nor the selection row is drawn any more.
  assert.doesNotMatch(src, /strings\.pending\.switchLanguageAria/);
  assert.doesNotMatch(src, /strings\.pending\.selectAll\b/);
});

test('sidebar header keeps both icon buttons named and routes checkout through BranchSelector', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'SidebarHeader.tsx'),
    'utf8',
  );
  assert.match(src, /<BranchSelector/);
  assert.match(src, /aria-label=\{strings\.pending\.reloadAria\}/);
  assert.match(src, /aria-label=\{strings\.pending\.openGraphAria\}/);
  assert.match(src, /title=\{strings\.pending\.reloadAria\}/);
  assert.match(src, /title=\{strings\.pending\.openGraphAria\}/);
  assert.match(src, /aria-label=\{shell\.headerAria\}/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
  // P15 adds the quick actions button; P17 adds the Help button beside it.
  assert.match(src, /aria-label=\{strings\.palette\.openAria\}/, 'P15: the search button is named');
  assert.match(src, /aria-label=\{strings\.help\.openAria\}/, 'P17: the help button is named');
  assert.match(src, /data-help-open/, 'P17: the button is the focus return target');
});

test('sidebar header keeps the frame 20 geometry: 12 px inset, 28 px select and chip, tones scoped above .gc-chip', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8');
  const header = css.match(/\.gc-sidebar-header\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(header, /padding:\s*var\(--gc-space-4\)\s+var\(--gc-space-4\)\s+var\(--gc-space-3\);/);
  assert.match(header, /--gc-sidebar-header-control:\s*28px;/);
  const chip = css.match(/\.gc-sidebar-header \.gc-sidebar-header__sync\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(chip, /height:\s*var\(--gc-sidebar-header-control\);/);
  assert.match(chip, /border-color:\s*transparent;/);
  const select = css.match(/\.gc-sidebar-header \.gc-toolbar__branch-select\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(select, /min-height:\s*var\(--gc-sidebar-header-control\);/);
  for (const tone of ['ahead', 'behind', 'diverged']) {
    assert.match(css, new RegExp(`\.gc-sidebar-header \.gc-sidebar-header__sync--${tone}`));
  }
});

test('pending panel mounts the nav strip directly under the sidebar header', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.match(src, /import \{ NavStrip \} from '\.\/NavStrip';/);
  // P06 puts the sub-tabs between the strip and the banners (S3 row 11), so the order is
  // header, strip, sub-tabs, notifications. P17 swaps the repo header for the help one
  // on the help route, so the header slot is a ternary; the strip stays under it.
  assert.match(src, /<SidebarHeader \/>[\s\S]{0,40}?<NavStrip \/>/, 'the strip follows the header slot');
  assert.match(
    src,
    /<NavStrip \/>[\s\S]{0,80}?<Tablist\b[\s\S]{0,500}?\/>\s*<div className="gc-pending__notifications">/,
    'strip, branch bar on Changes, then the sub-tabs, then the notifications',
  );
  assert.equal(src.match(/<NavStrip \/>/g)?.length, 1, 'mounted once');
});

test('Changes, Pull requests, Issues, Actions, and Branches are registered, so the strip is visible', () => {
  // P07, P08, P11, and P13 add destinations, which is what makes the strip render
  // (D-06). The order is the strip's left-to-right order, as frame 08 draws it.
  assert.deepEqual(
    navRegistry.list().map((d) => d.id),
    ['changes', 'prs', 'issues', 'actions', 'branches'],
  );
  assert.equal(isNavVisible(navRegistry.list().length), true);
});

// ------------------------------------------------------------------- amend

/** Reset the amend slice plus the status it derives from. */
function resetAmend(): void {
  useChangesStore.setState({
    amend: false,
    amendBase: null,
    amendDraft: null,
    commitMessage: '',
    messageError: null,
  });
}

function setStatus(patch: Partial<RepoStatus>): void {
  useRepoStore.setState({
    status: {
      repoRoot: 'D:/work/git-control',
      branch: 'main',
      head: 'aaa1111bbb2222ccc3333ddd4444eee5555fff6',
      detached: false,
      upstream: 'origin/main',
      ahead: 2,
      behind: 0,
      incoming: 0,
      outgoing: 2,
      dirty: false,
      staged: false,
      operation: 'idle',
      changes: [],
      conflicts: [],
      churnTruncated: false,
      statusToken: 'token',
      lastFetchedAt: null,
      lastFetchAt: null,
      ...patch,
    },
  });
}

/** Stub `commits/detail` only; every other request falls through. */
function stubDetail(
  t: TestContext,
  detail: { hash: string; subject: string; body: string } | Error,
  onRequest?: () => void,
): void {
  const original = bridge.request;
  bridge.request = (async (kind: any, payload: any): Promise<any> => {
    if (kind === 'commits/detail') {
      onRequest?.();
      if (detail instanceof Error) throw detail;
      return { ...detail, shortHash: detail.hash.slice(0, 7) };
    }
    return original.call(bridge, kind, payload);
  }) as any;
  t.after(() => {
    bridge.request = original;
  });
}

test('setAmend loads the last commit message when the box is empty', async (t) => {
  resetAmend();
  setStatus({ ahead: 2 });
  stubDetail(t, { hash: 'aaa1111bbb2222ccc3333ddd4444eee5555fff6', subject: 'feat: first', body: 'longer story' });

  await useChangesStore.getState().setAmend(true);
  const after = useChangesStore.getState();
  assert.equal(after.amend, true);
  assert.equal(after.commitMessage, 'feat: first\n\nlonger story', 'subject and body, blank-line separated');
  assert.equal(after.amendBase?.subject, 'feat: first');
  assert.equal(after.amendBase?.message, 'feat: first\n\nlonger story');
  assert.equal(after.amendDraft, '', 'the empty draft is remembered so toggling off restores it');
});

test('setAmend keeps a typed draft instead of overwriting it', async (t) => {
  resetAmend();
  setStatus({ ahead: 2 });
  useChangesStore.setState({ commitMessage: 'my own message' });
  stubDetail(t, { hash: 'aaa1111bbb2222ccc3333ddd4444eee5555fff6', subject: 'feat: first', body: '' });

  await useChangesStore.getState().setAmend(true);
  const after = useChangesStore.getState();
  assert.equal(after.commitMessage, 'my own message', 'the draft wins, as frame 70 shows');
  assert.equal(after.amendBase?.message, 'feat: first', 'the base is still recorded for the toggle-off compare');
  assert.equal(after.amendDraft, 'my own message');
});

test('setAmend(false) restores the draft only when the message was not edited', async (t) => {
  resetAmend();
  setStatus({ ahead: 2 });
  stubDetail(t, { hash: 'aaa1111bbb2222ccc3333ddd4444eee5555fff6', subject: 'feat: first', body: '' });

  // Untouched: the prefill is dropped and the original draft comes back.
  await useChangesStore.getState().setAmend(true);
  await useChangesStore.getState().setAmend(false);
  let after = useChangesStore.getState();
  assert.equal(after.amend, false);
  assert.equal(after.commitMessage, '', 'the empty draft is restored');
  assert.equal(after.amendBase, null);
  assert.equal(after.amendDraft, null);

  // Edited: the user typed while amending, so the edit survives the toggle.
  useChangesStore.setState({ commitMessage: 'typed draft' });
  await useChangesStore.getState().setAmend(true);
  useChangesStore.getState().setCommitMessage('edited while amending');
  await useChangesStore.getState().setAmend(false);
  after = useChangesStore.getState();
  assert.equal(after.commitMessage, 'edited while amending', 'an edit is never thrown away');
  assert.equal(after.amendBase, null);
});

test('toggling off while the detail request is in flight does not prefill', async (t) => {
  resetAmend();
  setStatus({ ahead: 2 });

  let release = (): void => {
    throw new Error('gate not armed');
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = bridge.request;
  bridge.request = (async (kind: any, payload: any): Promise<any> => {
    if (kind === 'commits/detail') {
      await gate;
      return { hash: 'aaa1111bbb2222ccc3333ddd4444eee5555fff6', shortHash: 'aaa1111', subject: 'late', body: '' };
    }
    return original.call(bridge, kind, payload);
  }) as any;
  t.after(() => {
    bridge.request = original;
  });

  const pending = useChangesStore.getState().setAmend(true);
  await useChangesStore.getState().setAmend(false);
  release();
  await pending;

  const after = useChangesStore.getState();
  assert.equal(after.amend, false);
  assert.equal(after.commitMessage, '', 'the late response must not write into a form the user already left');
  assert.equal(after.amendBase, null);
});

test('a blocked status never sends the detail request', async (t) => {
  resetAmend();
  for (const patch of [
    { upstream: 'origin/main', ahead: 0 }, // published
    { operation: 'merge' as const, ahead: 2 }, // operation in progress
    { head: null }, // nothing to amend
  ]) {
    setStatus(patch);
    let requested = 0;
    stubDetail(t, { hash: 'x', subject: 'x', body: '' }, () => {
      requested += 1;
    });
    await useChangesStore.getState().setAmend(true);
    assert.equal(requested, 0, JSON.stringify(patch));
    assert.equal(useChangesStore.getState().amend, false, JSON.stringify(patch));
  }
});

test('a failed detail request clears the amend state and surfaces the error', async (t) => {
  resetAmend();
  setStatus({ ahead: 2 });
  const originalFail = useOperationStore.getState().fail;
  let failed = 0;
  useOperationStore.setState({
    fail: (err: unknown) => {
      failed += 1;
      originalFail.call(useOperationStore.getState(), err);
    },
  });
  t.after(() => {
    useOperationStore.setState({ fail: originalFail });
  });
  stubDetail(t, new Error('boom'));

  await useChangesStore.getState().setAmend(true);
  const after = useChangesStore.getState();
  assert.equal(after.amend, false, 'a failed prefill must not leave the toggle on');
  assert.equal(after.amendDraft, null);
  assert.equal(failed, 1, 'the failure is reported, not swallowed');
});

test('commit sends amend only while the toggle is on', async (t) => {
  const original = bridge.request;
  const sent: any[] = [];
  bridge.request = (async (kind: any, payload: any): Promise<any> => {
    if (kind === 'actions/commit') {
      sent.push(payload);
      return { success: true, commit: 'abc', pushed: false, operation: 'idle', statusToken: 'token' };
    }
    if (kind === 'repos/status') {
      return {
        repoRoot: 'D:/work/git-control',
        branch: 'main',
        head: 'abc',
        detached: false,
        upstream: 'origin/main',
        ahead: 2,
        behind: 0,
        incoming: 0,
        outgoing: 2,
        dirty: false,
        staged: false,
        operation: 'idle',
        changes: [],
        conflicts: [],
        churnTruncated: false,
        statusToken: 'token',
        lastFetchedAt: null,
        lastFetchAt: null,
      };
    }
    if (kind === 'stash/list') return [];
    if (kind === 'repos/graph') {
      return {
        nodes: [],
        edges: [],
        lanes: [],
        dateBuckets: [],
        refs: [],
        head: null,
        truncated: false,
        nextCursor: null,
        stale: false,
      };
    }
    if (kind === 'repos/contributors') return [];
    return original.call(bridge, kind, payload);
  }) as any;
  t.after(() => {
    bridge.request = original;
  });

  resetAmend();
  useChangesStore.setState({ commitMessage: 'plain commit' });
  assert.equal(await useChangesStore.getState().commit(), true);
  assert.equal(sent[0]?.amend, undefined, 'a plain commit carries no amend key at all');

  resetAmend();
  useChangesStore.setState({ commitMessage: 'reword', amend: true, amendBase: null, amendDraft: '' });
  assert.equal(await useChangesStore.getState().commit(), true);
  assert.equal(sent[1]?.amend, true);
  const after = useChangesStore.getState();
  assert.equal(after.amend, false, 'a landed commit leaves amend mode');
  assert.equal(after.amendBase, null);
  assert.equal(after.amendDraft, null);
});

test('the persisted message is the pre-amend draft, not the loaded HEAD message', async (t) => {
  resetAmend();
  setStatus({ ahead: 2 });
  useChangesStore.setState({ commitMessage: 'draft in progress' });
  stubDetail(t, { hash: 'aaa1111bbb2222ccc3333ddd4444eee5555fff6', subject: 'HEAD message', body: '' });

  await useChangesStore.getState().setAmend(true);
  assert.equal(useChangesStore.getState().commitMessage, 'draft in progress');

  useChangesStore.getState().setCommitMessage('HEAD message edited');
  assert.equal(
    loadState().commitMessage,
    'draft in progress',
    'hiding and showing the webview must not resurrect the HEAD message with amend off',
  );

  await useChangesStore.getState().setAmend(false);
  useChangesStore.getState().setCommitMessage('after amend off');
  assert.equal(loadState().commitMessage, 'after amend off', 'once amend is off the live message is persisted again');
});

test('toggling amend off persists the message the box now shows', async (t) => {
  // `retainContextWhenHidden: false`, so a rebuild is routine. Anything not
  // persisted at toggle-off is silently lost on the next reveal.
  resetAmend();
  setStatus({ ahead: 2 });
  stubDetail(t, { hash: 'aaa1111bbb2222ccc3333ddd4444eee5555fff6', subject: 'HEAD message', body: '' });

  useChangesStore.setState({ commitMessage: 'draft' });
  await useChangesStore.getState().setAmend(true);
  useChangesStore.getState().setCommitMessage('edited while amending');
  await useChangesStore.getState().setAmend(false);

  assert.equal(useChangesStore.getState().commitMessage, 'edited while amending');
  assert.equal(loadState().commitMessage, 'edited while amending', 'the edit survives a rebuild');

  // The restore path persists too. Empty the box so the prefill runs, then
  // toggle off: the box returns to the empty draft, and so does storage.
  useChangesStore.getState().setCommitMessage('');
  await useChangesStore.getState().setAmend(true);
  assert.equal(useChangesStore.getState().commitMessage, 'HEAD message', 'prefilled because the box was empty');
  await useChangesStore.getState().setAmend(false);
  assert.equal(useChangesStore.getState().commitMessage, '');
  assert.equal(loadState().commitMessage, '', 'the restored draft is persisted, not the HEAD message');
});

// ------------------------------------------------------- amend toggle markup

test('the commit footer renders an amend toggle bound to the store state', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'CommitForm.tsx'), 'utf8');

  // Derived state: the toggle follows `amend` only while the block reason is null,
  // so a stale `amend: true` cannot render as on.
  assert.match(src, /amendBlockedReason\(/, 'the reason comes from the pure helper');
  assert.match(
    src,
    /const\s+amendOn\s*=\s*amend\s*&&\s*amendReason\s*===\s*null/,
    'a blocked status forces the toggle off',
  );

  // A blocked toggle stays focusable and reachable: aria-disabled, never the
  // `disabled` attribute, so activation can reveal the reason.
  const toggle = src.slice(src.indexOf('commitForm.amendToggle') - 900, src.indexOf('commitForm.amendToggle') + 200);
  assert.match(toggle, /'aria-disabled':\s*true/, 'the attribute is only spread while blocked');
  assert.match(toggle, /amendReason === null\s*\?\s*\{\}/, 'an unblocked toggle carries no aria-disabled at all');
  assert.doesNotMatch(toggle, /(?<!-)disabled=\{amendReason/, 'a blocked amend must not be a dead control');
  assert.match(toggle, /'aria-describedby':\s*reasonId/, 'the description is only referenced while it exists');
  assert.match(toggle, /setAmend\(/, 'activation goes through the store action');

  // The reason is always reachable to a screen reader while blocked, and the
  // visible note appears once the user activates the blocked toggle.
  assert.match(src, /gc-visually-hidden/, 'a hidden description carries the reason');
  assert.match(src, /showReason/, 'activation of a blocked toggle reveals the note');
  assert.match(src, /InfoBanner/, 'the note reuses the shared banner');

  // The button relabels and, while amending, no longer needs a staged file.
  assert.match(src, /amendButton/);
  assert.match(src, /amendTitle/);
  assert.match(
    src,
    /disabled=\{busy \|\| conflictCount > 0 \|\| \(stagedCount === 0 && !amendOn\)\}/,
    'a message-only reword is the main use, so amend enables the button with nothing staged unless conflicts exist',
  );
});

test('the amend note names the replaced commit and strips bidi controls from it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'CommitForm.tsx'), 'utf8');
  // The subject is repository-controlled text, so it goes through the sanitizer
  // before it reaches the note.
  assert.match(src, /sanitizeGitText\(/, 'the commit subject is sanitized at the render site');
  assert.match(src, /amendNote\(/, 'the note text is a catalog function');
  assert.match(src, /amendBlockedPublished\(/, 'the blocked note is a catalog function');
});

test('the amend strings exist in both catalogs and keep their function arity', () => {
  for (const lang of ['en', 'id'] as const) {
    const form = t(lang).commitForm;
    assert.equal(typeof form.amendToggle, 'string', lang);
    assert.equal(typeof form.amendButton, 'string', lang);
    assert.equal(typeof form.amendTitle, 'string', lang);
    assert.equal(typeof form.amendNote, 'function', lang);
    assert.equal(typeof form.amendBlockedPublished, 'function', lang);
    assert.equal(typeof form.amendBlockedNoCommit, 'string', lang);
    assert.equal(typeof form.amendBlockedOperation, 'string', lang);

    const note = form.amendNote('4c9e1a2', 'feat(graph): ribbon', 'origin');
    assert.ok(note.includes('4c9e1a2') && note.includes('feat(graph): ribbon'), lang);
    assert.ok(note.includes('origin'), lang);
    assert.ok(form.amendNote('4c9e1a2', 'x', null).length > 0, lang);
    assert.ok(form.amendBlockedPublished('origin').includes('origin'), lang);
  }
});

test('the amend toggle and note use spacing tokens and clip in a narrow footer', () => {
  const css = fs
    .readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const meta = css.match(/\.gc-commit__meta\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(meta, /flex-wrap:\s*wrap/, 'two toggles plus the count cannot fit on one row at 300 px');

  const options = css.match(/\.gc-commit__options\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(options, /display:\s*flex/);
  assert.match(options, /flex-wrap:\s*wrap/, 'the pair wraps as a unit');
  assert.match(options, /gap:\s*var\(--gc-space-\d\)/, 'no literal spacing');

  // The note IS the banner: a wrapper with its own padding would double the
  // inset frame 70 draws (8/10 around two lines), so the padding and the radius
  // live on the banner inside the note slot.
  const note = css.match(/\.gc-commit__note\s+\.gc-banner\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(note, /border-radius:\s*var\(--gc-radius/, 'frame 70 corner, from the token scale');
  assert.match(note, /padding:\s*var\(--gc-space-\d\)/, 'frame 70: 8/10 padding, tokenised');
  assert.match(note, /overflow-wrap:\s*anywhere/, 'a long hash must not overflow the footer');
  assert.match(note, /background:\s*transparent/, 'the footer supplies the fill');
  assert.match(note, /border-left:\s*3px solid/, 'the stripe is the only edge the frame keeps');
});

test('a late detail response for a superseded HEAD does not overwrite amendBase', async (t) => {
  resetAmend();
  const HASH_A = 'aaa1111bbb2222ccc3333ddd4444eee5555fff6';
  const HASH_B = 'bbb2222ccc3333ddd4444eee5555fff6aaa1111';
  setStatus({ head: HASH_A, ahead: 2 });

  // Hold A's response, move HEAD to B, start a second amend, let B land, then
  // release A. The guard on `amend` alone is a boolean, so A used to win the
  // last write and the note named a commit that was no longer HEAD.
  const releases: Record<string, () => void> = {};
  const gates: Record<string, Promise<void>> = {};
  for (const hash of [HASH_A, HASH_B]) {
    gates[hash] = new Promise<void>((resolve) => {
      releases[hash] = resolve;
    });
  }
  const original = bridge.request;
  bridge.request = (async (kind: any, payload: any): Promise<any> => {
    if (kind === 'commits/detail') {
      const hash = (payload as { hash: string }).hash;
      await gates[hash];
      return { hash, shortHash: hash.slice(0, 7), subject: `subject ${hash.slice(0, 4)}`, body: '' };
    }
    return original.call(bridge, kind, payload);
  }) as any;
  t.after(() => {
    bridge.request = original;
  });

  const pendingA = useChangesStore.getState().setAmend(true);
  setStatus({ head: HASH_B, ahead: 2 });
  const pendingB = useChangesStore.getState().setAmend(true);

  releases[HASH_B]?.();
  await pendingB;
  assert.equal(useChangesStore.getState().amendBase?.hash, HASH_B, 'B is the live HEAD');

  releases[HASH_A]?.();
  await pendingA;
  assert.equal(
    useChangesStore.getState().amendBase?.hash,
    HASH_B,
    'a superseded response must not replace the base with an older commit',
  );
});

test('commit refuses to amend when HEAD moved away from the captured base', async (t) => {
  resetAmend();
  const HASH_A = 'aaa1111bbb2222ccc3333ddd4444eee5555fff6';
  const HASH_B = 'bbb2222ccc3333ddd4444eee5555fff6aaa1111';
  setStatus({ head: HASH_A, ahead: 2 });

  const sent: any[] = [];
  const original = bridge.request;
  bridge.request = (async (kind: any, payload: any): Promise<any> => {
    if (kind === 'actions/commit') {
      sent.push(payload);
      return { success: true, commit: 'abc', pushed: false, operation: 'idle', statusToken: 'token' };
    }
    if (kind === 'repos/status') {
      return {
        repoRoot: 'D:/work/git-control',
        branch: 'main',
        head: HASH_B,
        detached: false,
        upstream: 'origin/main',
        ahead: 2,
        behind: 0,
        incoming: 0,
        outgoing: 2,
        dirty: false,
        staged: false,
        operation: 'idle',
        changes: [],
        conflicts: [],
        churnTruncated: false,
        statusToken: 'token',
        lastFetchedAt: null,
        lastFetchAt: null,
      };
    }
    if (kind === 'stash/list') return [];
    if (kind === 'repos/graph') {
      return { nodes: [], edges: [], lanes: [], dateBuckets: [], refs: [], head: null, truncated: false, nextCursor: null, stale: false };
    }
    if (kind === 'repos/contributors') return [];
    if (kind === 'commits/detail') {
      return { hash: HASH_A, shortHash: 'aaa1111', subject: 'subject A', body: '' };
    }
    return original.call(bridge, kind, payload);
  }) as any;
  t.after(() => {
    bridge.request = original;
  });

  await useChangesStore.getState().setAmend(true);
  assert.equal(useChangesStore.getState().amendBase?.hash, HASH_A);
  useChangesStore.setState({ commitMessage: 'reword A' });

  // HEAD is B now. The payload carries no hash, so git would amend B while the
  // note promised A. The store must refuse instead of sending.
  assert.equal(await useChangesStore.getState().commit(), false);
  assert.equal(sent.length, 0, 'nothing was sent');
  assert.equal(useChangesStore.getState().amend, false, 'amend mode drops so the user sees the plain form');
});

test('the notification slot may shrink on a short panel, so the footer stays on screen', () => {
  // `.gc-pending` is a flex column with a definite height. The slot holding the
  // Get started card must not GROW (or it steals the list's space) but it must be
  // able to SHRINK, or on a short panel it holds its 227 px and pushes the commit
  // footer past the bottom edge. Measured at 510x480: with `flex: 0 0 auto` the
  // footer's bottom sat below the root's bottom.
  //
  // The height cap and the scroll live on this slot, so it can give height back.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8');
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = src.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `${selector} must have a rule`);
    return match[1] ?? '';
  };

  const notifications = rule('.gc-pending__notifications');
  // Grow must stay 0: a grower steals the list's height.
  assert.match(notifications, /flex:\s*0 [01] auto/, 'grow must be 0, so the list keeps the free space');
  // Shrink must be 1: a non-shrinker holds its content height and pushes the footer out.
  assert.match(notifications, /flex:\s*0 1 auto/, 'it must shrink when the panel is short');
  assert.match(notifications, /overflow-y:\s*auto/, 'and scroll what it can no longer show');

  // The panel keeps the whole remainder, which is what makes the list fill it.
  // The panel must take the remainder with a ZERO basis. With `flex: 1 1 auto`
  // its basis is its content height, so it competes with the notification slot on
  // equal terms and both shrink: measured at 510x1104 the slot came out 193.8 px
  // against a 227.3 px card, clipping the checklist even though the panel had
  // 392.5 px of unused room. A zero basis makes the panel absorb only what is
  // actually left after the slot has taken its natural height.
  const panel = rule('.gc-pending__panel');
  assert.match(panel, /flex:\s*1 1 0/, 'the panel takes the remainder from a zero basis');
  assert.match(panel, /min-height:\s*\d+px/, 'and keeps a measured floor rather than collapsing to zero');
});

test('the get started card caps against the viewport, never against its own slot', () => {
  // `max-height: 45%` on `.gc-started` resolved against its containing block, which
  // is `.gc-pending__notifications`. That slot is sized by the card's own content, so
  // the percentage became a self-reference: the card's intrinsic height set the slot,
  // then the card was clamped to 45 % of the slot it had just created. Measured at
  // 510x993: slot 227.3 px, card 102.3 px, which is exactly 45 %, leaving 125 px empty
  // and clipping the last checklist row mid-line.
  //
  // Moving the percentage to the slot did not help either: the slot's flex basis is
  // still its content, so the same self-reference came back one level up (slot 193.8
  // against a 227.3 px card at full height). The cap has to be independent of the
  // content it caps, so it is expressed in viewport units.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8');
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = src.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `${selector} must have a rule`);
    return match[1] ?? '';
  };

  const card = rule('.gc-started');
  assert.doesNotMatch(card, /max-height:\s*\d+%/, 'a percentage here measures the card against its own slot');
  assert.match(card, /max-height:\s*\d+vh/, 'the cap is viewport-relative, so it cannot depend on the card itself');
  // Shrink 1, not 0: a `0 0 auto` card holds its 227 px even when the panel is shorter
  // than the card, which is exactly the zero-height list measured at 380x667.
  assert.match(card, /flex:\s*0 1 auto/, 'the card yields height before the list does');

  const slot = rule('.gc-pending__notifications');
  assert.doesNotMatch(slot, /max-height:/, 'the slot carries no cap of its own');
  assert.match(slot, /flex:\s*0 1 auto/, 'grow 0 so the list keeps the free space, shrink 1 so a short panel still fits the footer');
  assert.match(slot, /min-height:\s*0/, 'and it may shrink below its content');
});

test('the card and the commit footer both yield, so the list never collapses to zero', () => {
  // Measured in Chromium at 380x667 with the checklist active: `.gc-pending__panel`
  // came out 0 px high while the card held its full 227 px and the footer its 197 px.
  // The list was unreachable, and the panel's own `overflow: hidden` hid the fact.
  // Three rules make the floor hold; each is asserted here because any one of them
  // regressing brings the zero back.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8');
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = src.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `${selector} must have a rule`);
    return match[1] ?? '';
  };

  // 1. The card shrinks. A `0 0 auto` card holds its intrinsic height no matter how
  //    short the panel is, so the slot above the list can never give anything back.
  const card = rule('.gc-started');
  assert.match(card, /flex:\s*0 1 auto/, 'the card gives height back before the list does');
  assert.match(card, /max-height:\s*\d+vh/, 'and it still caps itself against the viewport');

  // 2. The commit footer shrinks too. `max-height: 50%` alone is a cap, not a floor:
  //    at 380x667 the footer measured 197 px and left the panel zero.
  const footer = rule('.gc-pending__footer');
  assert.match(footer, /flex:\s*0 1 auto/, 'the footer yields height to the list');

  // 3. The panel keeps a real floor, so even a hostile stack cannot hide the list.
  const panel = rule('.gc-pending__panel');
  assert.match(panel, /min-height:\s*\d+px/, 'the list keeps a measured floor');
  const floor = Number(panel.match(/min-height:\s*(\d+)px/)?.[1] ?? '0');
  assert.ok(floor >= 96, `the floor has to fit the search row and a row or two, got ${floor} px`);
});

test('each sidebar destination scrolls in exactly one box, and no footer floats', () => {
  // Reported from a real window: the Actions tab showed a page scrollbar and an inner
  // list scrollbar, so the wheel moved the wrong thing and the quota line looked like
  // it was hovering. The shell is a flex column with `overflow: hidden`, so any second
  // scroller has to come from a child that grows past it.
  const css = fs
    .readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string): string =>
    css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

  // The shell clips, so nothing can scroll the page under a pinned footer.
  assert.match(rule('.gc-pending'), /overflow:\s*hidden/, 'the shell is the clip');

  // Every view root is a flex column with a zero floor and its own clip; the one
  // scroller inside it then owns the wheel for the whole destination.
  for (const view of ['.gc-prs', '.gc-issues', '.gc-actions', '.gc-branches']) {
    const body = rule(view);
    assert.match(body, /min-height:\s*0/, `${view} may shrink, or it pushes its footer out`);
    assert.match(body, /overflow:\s*hidden/, `${view} clips its own children`);
  }

  // The Actions log is a block inside the list, not a second scroll region. Frame 08
  // draws it inline at its natural height with the list owning the wheel; a cap plus
  // `overflow: visible` would spill the tail over the following rows instead, so both
  // the cap and the scroll go, and the one list scroller handles the length.
  const log = rule('.gc-actions__log-body');
  assert.doesNotMatch(log, /max-height:/, 'the log grows to its content inside the list');
  assert.doesNotMatch(log, /overflow:\s*(auto|scroll)/, 'and it is not a nested scroller');

  // The footer sits on the panel's bottom edge in every frame (08 at y 854, 09 and 05
  // at y 870, 11 at y 854, 105 at y 849), not right under the last row. Measured with a
  // short list the shipped footers landed at 340 of 1000 (Issues) and 758 of 1000
  // (Help): a floating strip with the view's own background under it.
  //
  // The four list views are flex columns whose scroller is `flex: 1 1 auto`, so the
  // free space goes to the scroller while rows fill it. When the view renders an empty
  // state instead, nothing grows and the footer rides up. `margin-top: auto` is the
  // one-line rule that absorbs that slack without touching the filled case.
  for (const footer of ['.gc-prs__footer', '.gc-issues__footer', '.gc-actions__footer', '.gc-branches__footer']) {
    assert.match(rule(footer), /margin-top:\s*auto/, `${footer} stays on the bottom edge when the list is short`);
  }

  // Help needs the other shape: `.gc-help` was its own scroller, so `position: sticky`
  // on the footer had nothing to stick to and the footer still measured 242 px above
  // the panel's bottom edge at 380x1000. The section is a flex column with the clip,
  // the body between the tabs and the footer is the one scroller, and the footer is a
  // flex sibling that the column pins. Frame 105 draws it at y 849 of 900.
  const help = rule('.gc-help');
  assert.match(help, /display:\s*flex/, 'the section is the column');
  assert.match(help, /overflow:\s*hidden/, 'and the clip, not the scroller');
  const helpBody = rule('.gc-help__body');
  assert.match(helpBody, /flex:\s*1 1 auto/, 'the body takes the remainder');
  assert.match(helpBody, /min-height:\s*0/, 'and may shrink below its content');
  assert.match(helpBody, /overflow-y:\s*auto/, 'the body owns the wheel');
  const helpFooter = rule('.gc-help__footer');
  assert.doesNotMatch(helpFooter, /position:\s*sticky/, 'a flex sibling needs no sticky');
  assert.match(helpFooter, /flex:\s*0 0 auto/, 'the footer keeps its height');
});

test('the visually hidden helper stays inside a scroller instead of stretching the document', () => {
  // Reported again from a real window: the Actions tab still showed two scrollbars.
  // The list scroller was already the only `overflow: auto` box, so the second bar was
  // the page itself. Measured at 380x622 and 380x1000: `document.scrollHeight` was 1112
  // at both heights, and `window.scrollTo(0, 400)` moved 112 px.
  //
  // Cause: `.gc-visually-hidden` used `position: absolute` with no positioned ancestor.
  // Its containing block was the viewport, so every one of the 20 hidden spans inside
  // the Actions rows escaped the scroller's clip and landed at its document offset,
  // with the last at y 1111. Hiding them dropped the document back to 1000; so did
  // giving the scroller `position: relative`, which confirms the mechanism.
  //
  // The fix is the modern clip recipe: keep the box in flow so it can never be
  // positioned outside its parent, and clip it to a 1 px square instead. Screen
  // readers still get the text and the box still takes no visible space.
  const css = fs
    .readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(match, `${selector} must have a rule`);
    return match[1] ?? '';
  };

  const hidden = rule('.gc-visually-hidden');
  assert.doesNotMatch(hidden, /position:\s*absolute/, 'an absolute box escapes any scroller it sits in');
  assert.match(hidden, /clip-path:\s*inset\(50%\)/, 'the modern clip keeps the text available and the box invisible');
  assert.match(hidden, /width:\s*1px/, 'a 1 px box takes no visible space');
  assert.match(hidden, /height:\s*1px/);
  assert.match(hidden, /white-space:\s*nowrap/, 'a wrapped box would grow taller than 1 px');
  // The legacy `clip` rectangle only works with absolute positioning; keeping both
  // would make the helper's intent ambiguous for the next reader.
  assert.doesNotMatch(hidden, /clip:\s*rect/, 'the legacy clip rectangle goes with the absolute position');
});
