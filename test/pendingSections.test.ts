/**
 * Collapsible section headers (Pending Changes panel).
 *
 * The folder-collapse state (`collapsed`) and the section-collapse state
 * (`collapsedSections`) are two different sets in the store on purpose: one
 * keys by folder path, the other by section name, and a leak between them
 * would fold things the user never folded. These tests pin the separation,
 * the default (every section open), and the persist/restore round trip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useChangesStore, pruneStashCache } from '../src/webview/store';
import { bridge, loadState, saveState } from '../src/webview/bridge';
import { t } from '../src/webview/i18n';
import { isNavVisible, navRegistry } from '../src/webview/navRegistry';
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
  // filter (see the filter test below). Select all and Clear still act on file paths only, so
  // they stay in the Changes list bar and disappear with it.
  assert.match(src, /gc-listbar__selection/, 'selection helpers ride in the list bar, which only Changes renders');
  assert.equal(src.match(/className="gc-listbar"/g)?.length, 1);
  assert.equal(src.match(/strings\.pending\.switchLanguageAria/g)?.length, 1, 'the language toggle stays reachable in both sub-tabs');
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

  // Banners keep their place above the list and stay ungated by a sub-tab.
  assert.ok(src.indexOf('gc-pending__notifications') < panel, 'the banners are above the panel');
  assert.doesNotMatch(
    src.slice(src.indexOf('gc-pending__notifications'), panel),
    /sub\s*===/,
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
  assert.match(footer, /flex:\s*0 0 auto/, 'the footer never grows, so the list scrolls instead');
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
});

test('select all, clear, and the count live in the list bar, not the toolbar', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  const bar = src.indexOf('className="gc-listbar__selection"');
  const changesBranch = src.indexOf('strings.pending.searchPlaceholder');
  const scroller = src.indexOf('className="gc-pending__sections"', bar);
  const selectAll = src.indexOf('onClick={selectAll}');
  const clear = src.indexOf('onClick={clear}');
  assert.ok(bar > changesBranch, 'the selection row sits in the Changes branch only, so Stashes has none');
  assert.ok(selectAll > bar, 'select all moved into the selection row');
  assert.ok(clear > bar, 'clear moved into the selection row');
  assert.ok(scroller > clear, 'and both stay outside the scroller, so they never scroll away');

  // The toolbar keeps the language toggle only; the old column group is gone.
  const toolbar = src.slice(src.indexOf('gc-pending__bar'), bar);
  assert.doesNotMatch(toolbar, /gc-selection-group/);
  assert.match(toolbar, /switchLanguageAria/);
  assert.doesNotMatch(src, /gc-toolbar__secondary-group/, 'no dead wrapper');

  const css = fs
    .readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /gc-toolbar__secondary-group/, 'the wrapper CSS goes with the wrapper');
  const row = css.match(/\.gc-listbar__selection\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(row, /display:\s*flex/);
  assert.match(row, /flex-wrap:\s*wrap/, 'at 300 px the count drops below the pair');
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

test('stash item row renders expandable twisty, 1-based label, open-commit hash button, and no subject', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'PendingChanges.tsx'),
    'utf8',
  );
  assert.match(src, /className="gc-icon-button gc-stash-item__twisty"/);
  assert.match(src, /aria-expanded=\{isExpanded\}/);
  assert.match(src, /formatStashLabel\(parsedIndex, language\)/);
  assert.match(src, /className="gc-stash-item__hash-btn"/);
  assert.match(src, /aria-label=\{strings\.pending\.stashOpenCommitAria\}/);
  assert.match(src, /title=\{strings\.pending\.stashOpenCommitTitle\}/);
  assert.doesNotMatch(src, /stash\.subject/);
  assert.match(src, /aria-label=\{strings\.pending\.stashApplyAria\(stash\.ref\)\}/);
  assert.match(src, /title=\{strings\.pending\.stashApplyTitle\}/);
  assert.match(src, /<Icon name="add" \/>/);
  assert.match(src, /aria-label=\{strings\.pending\.stashDropAria\(stash\.ref\)\}/);
  assert.match(src, /title=\{strings\.pending\.stashDropTitle\}/);
  assert.match(src, /<Icon name="dash" \/>/);
  assert.doesNotMatch(src, /strings\.pending\.stashApplyLabel/);
  assert.doesNotMatch(src, /strings\.pending\.stashDropLabel/);

  const stylesSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css'),
    'utf8',
  );
  const actionsBlock = stylesSrc.match(/\.gc-stash-item__actions\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(actionsBlock, /margin-left:\s*auto;/);
  const actionBlock = stylesSrc.match(/\.gc-stash-item__action\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(actionBlock, /font-size:\s*var\(--gc-fs-sm\);/);
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
  assert.match(src, /strings\.pending\.switchLanguageAria/, 'language toggle stays in the toolbar');
  assert.match(src, /strings\.pending\.selectAll\b/, 'select all stays reachable');
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
  assert.doesNotMatch(src, /quick|help/i, 'no quick-actions or help button before P15 and P17');
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
  // header, strip, sub-tabs, notifications. The strip stays directly under the header.
  assert.match(
    src,
    /<SidebarHeader \/>\s*<NavStrip \/>\s*<Tablist\b[\s\S]{0,500}?\/>\s*<div className="gc-pending__notifications">/,
    'header, then strip, then the sub-tabs, then the notifications',
  );
  assert.equal(src.match(/<NavStrip \/>/g)?.length, 1, 'mounted once');
});

test('only Changes is registered in the shipped build, so the strip stays hidden', () => {
  assert.deepEqual(
    navRegistry.list().map((d) => d.id),
    ['changes'],
  );
  assert.equal(isNavVisible(navRegistry.list().length), false);
});
