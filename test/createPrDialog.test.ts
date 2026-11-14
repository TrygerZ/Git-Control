/**
 * Create pull request dialog contract (P22).
 *
 * There is no DOM renderer in this suite, so this file pins the three things that
 * can be wrong without one: the accessibility contract the phase file states, the
 * wiring the view needs, and the source rules that keep a second modal and a second
 * command vocabulary out of the dialog.
 *
 * Everything behavioural is covered elsewhere and is not repeated here:
 * `pullRequestDraft.test.ts` for the draft and the validation, `prDraftStore.test.ts`
 * for the state machine, `prCreateBridge.test.ts` for the order of publish and
 * create, `format.test.ts` for the command previews.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const DIALOG = path.join(ROOT, 'src', 'webview', 'CreatePullRequest.tsx');
const VIEW = path.join(ROOT, 'src', 'webview', 'PullRequestsView.tsx');
const SHELL = path.join(ROOT, 'src', 'webview', 'PendingChanges.tsx');

function source(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

test('the dialog exists and is a component, not a second copy of the view', () => {
  const src = source(DIALOG);
  assert.match(src, /export function CreatePullRequest\(/);
  // One component serves both hosts; the variant is a class, never a branch that
  // duplicates the form.
  assert.match(src, /variant: 'sidebar' \| 'modal'/);
  assert.doesNotMatch(src, /variant === 'modal' \? \(/, 'no second form for the modal variant');
});

test('the dialog is a labelled modal that reuses the shared focus trap', () => {
  const src = source(DIALOG);
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal/);
  assert.match(src, /aria-labelledby=\{titleId\}/);
  assert.match(src, /useDialogFocusTrap\(/);
});

test('every field has a visible label bound to its control', () => {
  const src = source(DIALOG);
  // A wrapping label binds without an id; an aria-label is the fallback for a
  // control that has no visible text of its own.
  const controls = ['input', 'textarea', 'select'];
  for (const control of controls) {
    const opens = src.match(new RegExp(`<${control}[\\s>]`, 'g')) ?? [];
    assert.ok(opens.length > 0, `the dialog draws a ${control}`);
  }
  assert.match(src, /gc-field__label/, 'fields carry the shared label style');
  assert.doesNotMatch(src, /<input[^>]*placeholder="[^"]*"[^>]*\/>\s*\)/s, 'no placeholder-only field');
});

test('the title counter is announced only at the limit', () => {
  const src = source(DIALOG);
  // A live region on every keystroke reads the counter over the field the user is
  // typing into; the phase file asks for polite-at-the-limit.
  assert.match(src, /aria-live=\{title\.length >= TITLE_MAX \? 'polite' : 'off'\}/);
});

test('the draft toggle is a real switch', () => {
  const src = source(DIALOG);
  assert.match(src, /role="switch"/);
  assert.match(src, /aria-checked=\{draft\}/);
});

test('progress is a status region and the primary button reports busy', () => {
  const src = source(DIALOG);
  assert.match(src, /role="status"/);
  assert.match(src, /aria-busy=\{busy\}/);
  assert.match(src, /strings\.createPr\.creatingOnGitHub/);
});

test('the dialog never opens a second modal', () => {
  const src = source(DIALOG);
  // The store carries the confirmation the host guard wants, so a guard verdict
  // cannot stack a GuardDialog over this dialog.
  assert.doesNotMatch(src, /GuardDialog|pendingGuard|runAction/, 'no second modal path');
});

test('the dialog renders no untrusted HTML and no navigation', () => {
  const src = source(DIALOG);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
  assert.doesNotMatch(src, /href=/, 'links go through the host');
  assert.match(src, /sanitizeGitText\(/, 'git-sourced text goes through the sanitizer');
});

test('the command preview uses the shared formatters, not hand-built strings', () => {
  const src = source(DIALOG);
  assert.match(src, /gitCommandOf\(/);
  assert.match(src, /apiCommandOf\(/);
  assert.doesNotMatch(src, /`git push/, 'no hand-built git line');
  assert.doesNotMatch(src, /`POST \/repos/, 'no hand-built API line');
});

test('the four banners come from the shared primitive', () => {
  const src = source(DIALOG);
  assert.match(src, /InfoBanner/);
  // No new banner primitive: the dialog imports the one the rest of the panel uses.
  assert.doesNotMatch(src, /function \w*Banner\(/, 'no second banner component');
});

test('the pull requests view opens the dialog and hides the offer when a PR exists', () => {
  const src = source(VIEW);
  assert.match(src, /CreatePullRequest/, 'the view mounts the dialog');
  assert.match(src, /usePrDraftStore/, 'the view drives the draft store');
  assert.match(src, /branchHasPr/, 'the current-branch card already knows the answer');
});

test('the sidebar shell gives the dialog a place to render', () => {
  const src = source(SHELL);
  assert.match(src, /CreatePullRequest/, 'the shell mounts it for the sidebar route');
});
