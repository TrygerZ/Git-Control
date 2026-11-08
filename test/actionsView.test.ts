/**
 * Actions view (P13).
 *
 * Source-level contract, like `issuesView.test.ts`: no DOM harness exists here,
 * so the component is pinned by the helpers it must route through, the requests
 * it may not send, and the controls it must not draw yet. Behaviour of the
 * helpers lives in `actions.test.ts` and `actionsStore.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('the actions view routes every decision through the pure helpers', () => {
  const view = read('src/webview/ActionsView.tsx');
  for (const helper of [
    'githubGate',
    'groupRuns',
    'filterByWorkflow',
    'needsPolling',
    'nextPoll',
    'applyResult',
    'DEFAULT_POLL_CONFIG',
    'sanitizeGitText',
    'apiQuotaLabel',
  ]) {
    assert.match(view, new RegExp(`\\b${helper}\\b`), `ActionsView: ${helper}`);
  }
  const row = read('src/webview/ActionRunRow.tsx');
  for (const helper of ['toneOf', 'durationText', 'metaLine', 'sanitizeGitText']) {
    assert.match(row, new RegExp(`\\b${helper}\\b`), `ActionRunRow: ${helper}`);
  }
  const filters = read('src/webview/ActionsFilters.tsx');
  for (const helper of ['branchesWithRuns', 'sanitizeGitText']) {
    assert.match(filters, new RegExp(`\\b${helper}\\b`), `ActionsFilters: ${helper}`);
  }
  for (const src of [view, row, filters]) {
    assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
  }
});

test('no component keeps a helper alive just to satisfy a contract test', () => {
  for (const file of ['ActionsView.tsx', 'ActionRunRow.tsx', 'ActionsFilters.tsx']) {
    assert.doesNotMatch(read(`src/webview/${file}`), /^\s*void \w+;/m, file);
  }
});

test('the actions view sends no request of its own beyond the store actions', () => {
  const src = read('src/webview/ActionsView.tsx');
  assert.doesNotMatch(src, /bridge\.request\(/);
});

test('no run, re-run, log, or annotation control exists in this phase', () => {
  const view = read('src/webview/ActionsView.tsx');
  const row = read('src/webview/ActionRunRow.tsx');
  for (const forbidden of ['Run workflow', 'Re-run', 'Open full log', 'Annotations', 'workflow_dispatch']) {
    assert.ok(!view.includes(forbidden), `ActionsView must not draw ${forbidden}`);
    assert.ok(!row.includes(forbidden), `ActionRunRow must not draw ${forbidden}`);
  }
});

test('the run row is a button with aria-expanded and an aria-controls target', () => {
  const src = read('src/webview/ActionRunRow.tsx');
  assert.match(src, /aria-expanded=\{expanded\}/);
  assert.match(src, /aria-controls=\{expanded \? jobsId : undefined\}/);
  // The status is never colour alone: the tone icon always carries a word.
  assert.match(src, /visually-hidden/);
});

test('the signed-out screen is the gate view, not an anonymous list', () => {
  const src = read('src/webview/ActionsView.tsx');
  assert.match(src, /view: 'actions'/);
  assert.match(src, /signedOutTitle/);
});

test('the poll timer stops when nothing is active and while the route is elsewhere', () => {
  const src = read('src/webview/ActionsView.tsx');
  assert.match(src, /needsPolling/);
  assert.match(src, /clearTimeout/);
  assert.match(src, /route\.id !== 'actions'/);
});

test('the sidebar shell mounts the view and probes the dot before it is opened', () => {
  const src = read('src/webview/PendingChanges.tsx');
  assert.match(src, /<ActionsView \/>/);
  assert.match(src, /route\.id === 'actions'/);
  // The dot must be right on every route, not only while Actions is open.
  assert.match(src, /refreshDot\(currentBranch\)/);
  assert.match(src, /if \(!githubConnected\) return;/);
});
