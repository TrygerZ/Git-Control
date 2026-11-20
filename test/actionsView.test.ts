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
  for (const file of ['ActionsView.tsx', 'ActionRunRow.tsx', 'ActionsFilters.tsx', 'RunWorkflowDialog.tsx']) {
    assert.doesNotMatch(read(`src/webview/${file}`), /^\s*void \w+;/m, file);
  }
});

test('the actions view sends no request of its own beyond the store actions', () => {
  const src = read('src/webview/ActionsView.tsx');
  assert.doesNotMatch(src, /bridge\.request\(/);
});

test('annotations remain absent while P27 re-run and dispatch controls are wired', () => {
  const view = read('src/webview/ActionsView.tsx');
  const row = read('src/webview/ActionRunRow.tsx');
  const log = read('src/webview/ActionJobLog.tsx');
  for (const src of [view, row, log]) {
    assert.ok(!src.includes('Annotations'), 'Annotations must not be drawn');
  }

  assert.match(row, /\bcanRerun\b/);
  assert.match(row, /\brerunFailed\b/);
  assert.match(row, /actionsWrite\.rerunFailed/);
  assert.match(row, /gc-actions__run-actions/);

  assert.match(view, /<RunWorkflowDialog/);
  assert.match(view, /pendingFocus !== 'run-workflow'/);
  assert.match(view, /\bopenDispatch\b/);
  assert.match(view, /\bpendingStart\b/);
  assert.match(view, /actionsWrite\.runWorkflow/);
  assert.match(view, /actionsWrite\.startingRun/);
  assert.match(view, /nextBurstDelay/);
  assert.match(view, /finishPollBurst/);
  assert.match(view, /gc-actions__starting/);
  assert.match(view, /pollBurstActive/, 'burst effect gated on pollBurstActive rather than sticky nonce > 0');

  const dialog = read('src/webview/RunWorkflowDialog.tsx');
  assert.doesNotMatch(dialog, /dangerouslySetInnerHTML|innerHTML|href=/);
  assert.match(dialog, /useDialogFocusTrap/);
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-required/);
  assert.match(dialog, /aria-describedby/);
  assert.match(dialog, /role="status"/);
  assert.match(dialog, /<select\b/);
  assert.match(dialog, /type="checkbox"/);
  assert.match(dialog, /\bdispatchCommand\b/);
  assert.match(dialog, /\bmissingRequired\b/);
  assert.match(dialog, /actionsWrite\.openOnGitHub/);
  assert.match(dialog, /\bopenUrl\b/);
  assert.match(dialog, /setTimeout/, 'debounces branch input YAML reads');
  assert.doesNotMatch(dialog, /const canSubmit\s*=[\s\S]*?missing\.length === 0/, 'submit stays clickable so required-field alert is reachable');
});

test('the job log renders text nodes only and reaches the host through openUrl', () => {
  const log = read('src/webview/ActionJobLog.tsx');
  assert.doesNotMatch(log, /dangerouslySetInnerHTML|innerHTML|href=/);
  assert.match(log, /role="region"/);
  assert.match(log, /tabIndex=\{0\}/);
  assert.match(log, /openFullLog/);
  // No Markdown, no link rendering: every line is a plain text node.
  assert.match(log, /\{line\.text\}/);
});

test('the job row gains a disclosure button that targets the log region', () => {
  const row = read('src/webview/ActionRunRow.tsx');
  assert.match(row, /aria-expanded=\{jobExpanded\}/);
  assert.match(row, /aria-controls=\{jobExpanded \? logId : undefined\}/);
  assert.match(row, /<ActionJobLog/);
  assert.match(row, /canLoadLog/);
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
  // One derived flag gates both the route and the active-run condition, so the
  // effect cannot arm a timer on a route that does not draw the list.
  assert.match(src, /route\.id === 'actions' && needsPolling\(runs\)/);
});

test('the sidebar shell mounts the view and probes the dot before it is opened', () => {
  const src = read('src/webview/PendingChanges.tsx');
  assert.match(src, /<ActionsView \/>/);
  assert.match(src, /route\.id === 'actions'/);
  // The dot must be right on every route, not only while Actions is open.
  assert.match(src, /refreshDot\(currentBranch\)/);
  assert.match(src, /if \(!githubConnected\) return;/);
});

test('P27: AGENTS.md, purity contract, and README document the Actions write modules and scopes', () => {
  const agents = read('AGENTS.md');
  assert.ok(agents.includes('src/workflowInputs.ts'), 'AGENTS.md File Map lists workflowInputs.ts');
  assert.ok(agents.includes('src/webview/RunWorkflowDialog.tsx'), 'AGENTS.md File Map lists RunWorkflowDialog.tsx');

  const purity = read('test/purity.test.ts');
  assert.match(purity, /'src\/workflowInputs\.ts'/);

  const readme = read('README.md');
  assert.match(readme, /Actions Write Actions/);
  assert.match(readme, /`repo` and `workflow`/);
});
