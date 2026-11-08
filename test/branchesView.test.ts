/**
 * Branches destination (P11).
 *
 * Source-level contract plus the pure helpers it must route through. The
 * project has no DOM harness, so behaviour is pinned in `branchesModel.test.ts`
 * and `branchesStore.test.ts`; this file pins the wiring the phase requires and
 * the controls it must NOT ship yet (R2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { navRegistry } from '../src/webview/navRegistry';
import '../src/webview/NavStrip';
import '../src/webview/BranchesView';

const ROOT = path.join(__dirname, '..', '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** Source with block and line comments stripped, so prose cannot trip a scan. */
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('the view exists and routes its decisions through the pure helpers', () => {
  const src = code('src/webview/BranchesView.tsx');
  for (const helper of [
    'branchRow',
    'canCheckout',
    'sortLocals',
    'filterRows',
    'groupRemotes',
    'tagRows',
    'visibleWorktrees',
  ]) {
    assert.match(src, new RegExp(`\\b${helper}\\b`), helper);
  }
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
});

test('the view loads through the store and never calls the bridge itself', () => {
  const src = read('src/webview/BranchesView.tsx');
  assert.doesNotMatch(src, /bridge\.request\(/, 'every read is a store action');
  assert.match(src, /useBranchesStore/);
});

test('untrusted names go through the sanitizer', () => {
  const src = read('src/webview/BranchesView.tsx');
  assert.match(src, /sanitizeGitText/);
});

test('the view reuses the existing checkout, merge, and create payloads instead of rebuilding them', () => {
  const src = read('src/webview/BranchesView.tsx');
  assert.match(src, /checkoutActionPayload/);
  assert.match(src, /mergeActionPayload/);
  assert.match(src, /'create-branch'/);
  assert.match(src, /runAction/);
});

test('the view does not mount a second guard dialog, because the shell already hosts one', () => {
  // Two hosts read the same `pendingGuard`, so one dirty-tree checkout would
  // render two aria-modal dialogs with two focus traps.
  const src = read('src/webview/BranchesView.tsx');
  assert.doesNotMatch(src, /<GuardDialog/);
  assert.match(read('src/webview/PendingChanges.tsx'), /<GuardDialog \/>/, 'the shell keeps its single host');
});

test('the controls owned by later phases are absent', () => {
  // Checked against the rendered strings and the action payloads, not the
  // component's prose, so a comment naming a deferred control is not a failure.
  const src = code('src/webview/BranchesView.tsx');
  for (const forbidden of ['branchDelete', 'deleteBranch', 'newTag', 'addWorktree', 'compareRange']) {
    assert.doesNotMatch(src, new RegExp(forbidden), forbidden);
  }
  const actions = [...src.matchAll(/action:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(actions)].sort(),
    ['create-branch'],
    'the only inline action is branch creation; checkout and merge ride the shared payload helpers',
  );
  assert.doesNotMatch(src, /'delete-branch'|'delete-tag'|'worktree-add'|'compare'/);
});

test('remote rows offer no checkout control', () => {
  // D-P11-3 lives in the pure model, so the rule is testable instead of being a
  // property of how one component happens to be written.
  const src = read('src/webview/BranchesView.tsx');
  assert.match(src, /canCheckout\(/, 'the row menu asks the model before offering Checkout');
});

test('every row carries a menu, because Copy name is offered on every row', () => {
  // The Current row is the one a user most often pastes, so it must not be the
  // one row without a copy affordance. Checkout and Merge stay gated inside.
  const src = code('src/webview/BranchesView.tsx');
  assert.doesNotMatch(src, /const showMenu/, 'the menu is unconditional');
  assert.match(src, /const mutable = canCheckout\(ref_\) && !isCurrent/);
  assert.match(src, /item\(strings\.branches\.menuCopyName/, 'copy is outside the mutable gate');
});

test('a worktree path is sanitised everywhere it reaches the DOM', () => {
  const src = read('src/webview/BranchesView.tsx');
  assert.match(src, /const safePath = sanitizeGitText\(worktree\.path\)/);
  assert.match(src, /title=\{safePath\}/);
  assert.match(src, /worktreePathAria\(safePath\)/);
  assert.doesNotMatch(src, /title=\{worktree\.path\}|worktreePathAria\(worktree\.path\)/);
});

test('the sort trigger keeps its visible label in its accessible name', () => {
  const src = read('src/webview/BranchesView.tsx');
  const trigger = src.slice(src.indexOf('className="gc-branches__sort"'), src.indexOf('onClick={() => setSortOpen'));
  assert.doesNotMatch(trigger, /aria-label=/, 'an aria-label would replace the visible text');
  assert.match(trigger, /title=\{strings\.branches\.sortAria\}/);
});

test('copy goes through the clipboard and reports a toast', () => {
  const src = read('src/webview/BranchesView.tsx');
  assert.match(src, /navigator\.clipboard\s*\.?\s*writeText|navigator\.clipboard\.writeText/);
  assert.match(src, /pushToast\(/);
});

test('the nav destination registers as branches with no badge and no GitHub requirement', () => {
  const branches = navRegistry.list().find((d) => d.id === 'branches');
  assert.ok(branches !== undefined, 'branches must be registered');
  assert.equal(branches.requiresGitHub, false, 'Branches works without a token');
  assert.equal(branches.icon, 'git-branch');
  assert.deepEqual(
    navRegistry.list().map((d) => d.id),
    ['changes', 'prs', 'issues', 'branches'],
    'order is the strip order',
  );
});

test('the sidebar shell renders the view on the branches route and keeps its own sub-tabs', () => {
  const src = read('src/webview/PendingChanges.tsx');
  assert.match(src, /BranchesView/);
  assert.match(src, /route\.id === 'branches'/);
  assert.doesNotMatch(
    src,
    /route\.id === 'prs' \|\| route\.id === 'issues'\)\s*\?\s*\[\]/,
    'the sub-tab row must also stand down for branches, which owns its own sub-tabs',
  );
});

test('the view declares its own sub-tabs through the shared Tablist', () => {
  const src = read('src/webview/BranchesView.tsx');
  assert.match(src, /<Tablist/);
  assert.match(src, /BRANCHES_TABS/);
});

test('the manifest contributes the open branches command with a title', () => {
  const manifest = JSON.parse(read('package.json')) as {
    contributes: { commands: Array<{ command: string; title?: string }> };
  };
  const command = manifest.contributes.commands.find((c) => c.command === 'gitControl.openBranches');
  assert.ok(command !== undefined, 'gitControl.openBranches must be contributed');
  assert.equal(command.title, 'Git Control: Open Branches');
});

test('the host registers the command and routes it through navigate', () => {
  const src = read('src/extension.ts');
  assert.match(src, /register\('gitControl\.openBranches',\s*\(\)\s*=>\s*this\.navigate\('branches'\)\)/);
});
