/**
 * Start work dialog and its wiring (P09).
 *
 * Source-level contract, like `issuesView.test.ts`: this project has no DOM
 * harness. What must hold is that the dialog reuses the shared focus trap, builds
 * its request through the pure helpers, and that the row button stays disabled
 * with a spoken reason instead of silently doing nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('the dialog exists and reuses the shared focus trap instead of re-implementing Tab handling', () => {
  const src = read('src/webview/StartWorkDialog.tsx');
  assert.match(src, /useDialogFocusTrap/);
  assert.doesNotMatch(src, /addEventListener\(\s*['"]keydown['"]/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
});

test('the dialog is a labelled modal with an initially selected name field', () => {
  const src = read('src/webview/StartWorkDialog.tsx');
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal="true"/);
  assert.match(src, /aria-labelledby=\{/);
  assert.match(src, /\.select\(\)/, 'the suggested name is selected so typing replaces it');
});

test('the dialog routes naming and the request through the pure helpers', () => {
  const src = read('src/webview/StartWorkDialog.tsx');
  for (const helper of ['suggestBranchName', 'branchNameProblem', 'startWorkRequest', 'gitCommandOf']) {
    assert.match(src, new RegExp(`\\b${helper}\\b`), helper);
  }
  assert.match(src, /sanitizeGitText/, 'the issue title is untrusted text');
});

test('the command preview is a code element with its own visible label', () => {
  const src = read('src/webview/StartWorkDialog.tsx');
  assert.match(src, /<code[^>]*>/);
  assert.match(src, /strings\.startWork\.commandLabel/);
});

test('the dirty-tree note appears only when the tree is dirty', () => {
  const src = read('src/webview/StartWorkDialog.tsx');
  assert.match(src, /dirty\s*&&/);
  assert.match(src, /strings\.startWork\.dirtyNote/);
});

test('an invalid or duplicate name blocks submit and says why inline', () => {
  const src = read('src/webview/StartWorkDialog.tsx');
  assert.match(src, /disabled=\{problem !== null\}/);
  assert.match(src, /role="alert"/);
  assert.match(src, /aria-invalid=/);
});

test('the issue row offers Start work and explains why it can be unavailable', () => {
  const src = read('src/webview/IssuesView.tsx');
  assert.match(src, /strings\.startWork\.button/);
  assert.match(src, /startWorkBlocker/);
  // The blocked state is `aria-disabled` plus a described-by, never `disabled`:
  // a dead control announces nothing. Spread-key form is how the repo binds it.
  assert.match(src, /['"]aria-describedby['"]\s*:/);
  assert.match(src, /['"]aria-disabled['"]\s*:\s*true/);
  assert.doesNotMatch(src, /disabled=\{startWorkBlocker/, 'a blocked button stays focusable');
  assert.match(src, /<StartWorkDialog/, 'the row owns the dialog it opens');
});

/**
 * A guard verdict has to be able to draw over a closed dialog. If the dialog waited
 * for `runAction` before unmounting, a blocked action would stack `GuardDialog` on
 * top of it, which is the one thing the phase calls out by name.
 */
test('the dialog unmounts before it awaits the action', () => {
  const src = read('src/webview/StartWorkDialog.tsx');
  const submit = src.slice(src.indexOf('const submit'), src.indexOf('return ('));
  const closed = submit.indexOf('onDone()');
  const ran = submit.indexOf('runAction(');
  assert.ok(closed > 0, 'the submit path closes the dialog');
  assert.ok(ran > 0, 'the submit path runs the action');
  assert.ok(closed < ran, 'closing comes first');
});

test('a successful start leaves the route alone, so the Changes view can show the new branch', () => {
  const src = read('src/webview/IssuesView.tsx');
  const after = src.slice(src.indexOf('onDone='), src.indexOf('onDone=') + 400);
  assert.doesNotMatch(after, /navigate\(/, 'P09 does not auto-navigate');
});

test('the close button is labelled as closing, not as cancelling', () => {
  const src = read('src/webview/StartWorkDialog.tsx');
  assert.match(src, /strings\.startWork\.closeAria/);
  assert.doesNotMatch(
    src,
    /aria-label=\{strings\.guard\.cancelButton\}/,
    'an X labelled Cancel is a different promise from the Cancel button',
  );
});
