/**
 * P25 merge and review UI, source-level contract.
 *
 * There is no DOM renderer in this suite, so this file pins the three things
 * that can be wrong without one: the accessibility contract the phase file
 * states, the wiring the panel needs, and the source rules that keep a second
 * modal, a force flag, and a rebase option out of the build.
 *
 * Everything behavioural lives elsewhere: `pullMerge.test.ts` for the block
 * reasons and the command list, `pullMergeStore.test.ts` for the state machine,
 * `bridge.test.ts` and `github.test.ts` for the order and restraint of the
 * writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'src', 'webview', 'PullRequestApp.tsx');
const DIALOG = path.join(ROOT, 'src', 'webview', 'MergePullDialog.tsx');
const REVIEW = path.join(ROOT, 'src', 'webview', 'ReviewDialog.tsx');
const STORE = path.join(ROOT, 'src', 'webview', 'pullStore.ts');
const CSS = path.join(ROOT, 'src', 'webview', 'styles.css');

function source(file: string): string {
  assert.ok(fs.existsSync(file), `${path.basename(file)} must exist`);
  return fs.readFileSync(file, 'utf8');
}

test('the merge dialog is a labelled modal that reuses the shared focus trap', () => {
  const src = source(DIALOG);
  assert.match(src, /role="dialog"/);
  assert.match(src, /aria-modal/);
  assert.match(src, /aria-labelledby=\{/);
  assert.match(src, /useDialogFocusTrap\(/);
});

test('the merge method control is a radiogroup with arrow-key handling', () => {
  const src = source(DIALOG);
  assert.match(src, /role="radiogroup"|role="radio"/);
  assert.match(src, /ArrowRight|ArrowDown|onKeyDown/);
});

test('the merge dialog lists the exact commands it will run', () => {
  const src = source(DIALOG);
  assert.match(src, /mergeCommands\(/);
  // The list is read-only display: no control inside it may invoke anything.
  assert.doesNotMatch(src, /<button[^>]*>\s*\{command\}/);
});

test('the merge dialog names its risk in text, not colour alone', () => {
  const src = source(DIALOG);
  assert.match(src, /prMerge\.risky|risk/);
});

test('the merging state is announced politely', () => {
  const src = source(DIALOG) + source(APP);
  assert.match(src, /aria-live="polite"|role="status"/);
});

test('a blocked merge button explains itself through aria-describedby', () => {
  const src = source(APP);
  assert.match(src, /blocked/);
  assert.match(src, /aria-describedby|title=/);
});

test('the review dialog posts one event and reuses the shared focus trap', () => {
  const src = source(REVIEW);
  assert.match(src, /role="dialog"/);
  assert.match(src, /useDialogFocusTrap\(/);
  for (const event of ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']) {
    assert.ok(src.includes(event), event);
  }
});

/**
 * QA-02: the form survives its request, so the store must refuse a repeat and
 * the button must say it is busy. The phase's idempotency row names this control
 * ("the disabled-while-pending button prevents second sends"); at `a9d76da` the
 * unmounting dialog provided it by accident.
 */
test('the review submit is disabled while a review is in flight', () => {
  const review = source(REVIEW);
  const app = source(APP);
  // The dialog takes the state and refuses the submit itself...
  assert.match(review, /sending/);
  // ...and the panel passes the store's state in.
  assert.match(app, /sending=\{/);
});

test('the panel never renders untrusted text as markup after P25', () => {
  for (const file of [APP, DIALOG, REVIEW]) {
    const src = source(file);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/, path.basename(file));
    assert.doesNotMatch(src, /<a\s[^>]*href=/, path.basename(file));
  }
});

/**
 * The More menu is one tab stop with arrow keys, like the Explorer header's menu
 * (`ExplorerHeaderActions.tsx`). Without roving focus a keyboard user tabs through
 * four rows and no arrow key moves between them, which is not a menu.
 */
test('the More menu moves with the arrow keys and keeps one tab stop', () => {
  const src = source(APP);
  const start = src.indexOf('function PullMoreMenu(');
  assert.ok(start > 0, 'the More menu exists');
  const body = src.slice(start, src.indexOf('\nfunction ', start + 10));
  assert.match(body, /ArrowDown/);
  assert.match(body, /ArrowUp/);
  assert.match(body, /\.focus\(\)/);
  assert.match(body, /tabIndex=\{/);
});

/**
 * A fork pull request's head branch lives in the fork, not in the cloned
 * repository, so there is no local branch to delete. The phase file states the
 * rule; `PullDetail` cannot answer it (it carries no head repository), so the
 * dialog is told.
 */
test('the merge dialog hides delete-branch for a fork', () => {
  const dialog = source(DIALOG);
  assert.match(dialog, /isFork/);
  assert.match(dialog, /!isFork/);
});

test('the panel reads isFork from PullDetail so closed and older-than-50 PRs keep the fork rule', () => {
  const app = source(APP);
  assert.match(app, /detail\.isFork/);
  assert.match(app, /closeSending/);
});

/**
 * The reply row posts to the parent comment and refreshes the thread. It was
 * declared and passed through without a control; the phase scope includes
 * replying to review threads.
 */
test('the conversation offers a reply input for review comments', () => {
  const src = source(APP);
  // Both strings were defined and unused; the panel is where they are read.
  assert.match(src, /prMerge\.replyPlaceholder/);
  assert.match(src, /prMerge\.replySend/);
  // The reply goes to the store, never straight to a request.
  assert.match(src, /onReply\(/);
});

test('the merged panel offers Show in graph and reports the deletion outcome', () => {
  const src = source(APP);
  assert.match(src, /graph\/revealCommit/);
  assert.match(src, /branchDeleted|warnings/);
});

test('Rebase and merge appears nowhere in the P25 sources or the store', () => {
  for (const file of [APP, DIALOG, REVIEW, STORE]) {
    assert.doesNotMatch(source(file), /[Rr]ebase and merge/, path.basename(file));
  }
});

test('no P25 source constructs a force flag or a shell', () => {
  for (const file of [APP, DIALOG, REVIEW, STORE]) {
    const src = source(file);
    assert.doesNotMatch(src, /--force-with-lease|shell:\s*true/, path.basename(file));
    assert.doesNotMatch(src, /refspec[^\n]*\+/, path.basename(file));
  }
});

test('the Close pull request row is in the More menu, after the tools group', () => {
  const src = source(APP);
  const menu = src.indexOf('gc-menu');
  assert.ok(menu > 0, 'the panel draws a menu');
  const body = src.slice(menu);
  assert.match(body, /closePull|closePr|close pull request/i);
  // Copy uses the clipboard, never an href.
  assert.match(src, /navigator\.clipboard|clipboard\.writeText/);
});

test('the merge box uses only theme tokens', () => {
  const css = fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = css.match(/\.gc-prmerge[^{]*\{[^}]*\}/g) ?? [];
  assert.ok(blocks.length > 0, 'the merge box has its own block');
  for (const block of blocks) {
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/, block);
  }
});

test('every catalogue key the dialogs read exists in both catalogs', () => {
  const en = source(path.join(ROOT, 'src', 'webview', 'i18n.en.ts'));
  const id = source(path.join(ROOT, 'src', 'webview', 'i18n.id.ts'));
  const keys = new Set<string>();
  for (const file of [DIALOG, REVIEW, APP]) {
    for (const match of source(file).matchAll(/strings\.prMerge\.([A-Za-z]+)/g)) {
      keys.add(match[1] as string);
    }
  }
  assert.ok(keys.size > 0, 'the dialogs read the prMerge namespace');
  for (const key of keys) {
    assert.match(en, new RegExp(`\\b${key}\\b`), `en.${key}`);
    assert.match(id, new RegExp(`\\b${key}\\b`), `id.${key}`);
  }
});
