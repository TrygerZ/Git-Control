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
import { useChangesStore } from '../src/webview/store';
import { loadState, saveState } from '../src/webview/bridge';
import { t } from '../src/webview/i18n';

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
  const statusIdx = commitFormSrc.indexOf('<p className="gc-commit__status">');
  assert.ok(actionsIdx >= 0, 'actions block must exist');
  assert.ok(statusIdx > actionsIdx, 'status row must come after the actions block');
  const beforeStatus = commitFormSrc.slice(0, statusIdx);
  assert.ok(
    !beforeStatus.includes('<Spinner'),
    'Spinner must not render before the gc-commit__status row (in particular, not inside gc-commit__actions)',
  );
  assert.match(
    commitFormSrc,
    /<p className="gc-commit__status">\s*\{busy && \(?\s*<Spinner/,
    'Spinner must be rendered inside gc-commit__status',
  );

  // Invariant, not literal: the status row must reserve a font-relative
  // minimum height and clamp its spinner to the same one-line box. Any
  // em/rem-based reservation passes; dropping the reservation fails.
  const statusBlock = stylesSrc.match(/\.gc-commit__status\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(
    statusBlock,
    /min-height:\s*[\d.]+(?:em|rem)\s*;/,
    '.gc-commit__status must reserve a font-relative minimum height',
  );
  assert.match(
    statusBlock,
    /line-height:\s*[\d.]+\s*;/,
    '.gc-commit__status must pin line-height so idle and busy rows measure identically',
  );
  const spinnerOverride = stylesSrc.match(/\.gc-commit__status\s+\.gc-spinner\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(
    spinnerOverride,
    /min-height:\s*[\d.]+(?:em|rem)\s*;/,
    '.gc-commit__status .gc-spinner must clamp its hit area to the reserved row',
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
