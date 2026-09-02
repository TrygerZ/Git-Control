import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as ts from 'typescript';
import { menuItemsFor } from '../src/webview/NodeContextMenu';
import type { GraphNode, RefInfo, RepoStatus, GitActionRequest } from '../src/messages';
import { makeRepo } from './fixture';

function node(patch: Partial<GraphNode> = {}): GraphNode {
  return { hash: '0123456789012345678901234567890123456789', shortHash: '0123456', x: 0, y: 0, lane: 0,
    isHead: false, isMerge: false, local: true, subject: 'subject', authorName: 'user', authoredAt: '', refNames: [], ...patch };
}

function ref(shortName: string, kind: RefInfo['kind'], objectName = node().hash): RefInfo {
  return { refName: kind === 'local' ? `refs/heads/${shortName}` : `refs/remotes/${shortName}`,
    shortName, kind, objectName, upstream: null, ahead: 0, behind: 0, isHead: false };
}

function status(patch: Partial<RepoStatus> = {}): RepoStatus {
  return { repoRoot: 'D:/repo', branch: 'main', head: node().hash, detached: false, upstream: null,
    ahead: 0, behind: 0, incoming: 0, outgoing: 0, dirty: false, staged: false, operation: 'idle',
    changes: [], conflicts: [], churnTruncated: false, statusToken: 'token', lastFetchedAt: null, lastFetchAt: null, ...patch };
}

test('context-menu scenarios produce every command kind, and every kind has an ExplorerApp case', async () => {
  const refs = [ref('main', 'local'), ref('feature', 'local'), ref('origin/main', 'remote')];
  const kinds = new Set(menuItemsFor(node(), status(), refs, 'https://github.com/a/b').map((i) => i.command.kind));
  assert.deepEqual([...kinds].sort(), ['action', 'copy', 'createBranch', 'mergeInto', 'openGitHub', 'viewDiff'].sort());

  const root = path.resolve(process.cwd(), 'src');
  const menuSource = await fs.readFile(path.join(root, 'webview', 'NodeContextMenu.tsx'), 'utf8');
  const appSource = await fs.readFile(path.join(root, 'webview', 'ExplorerApp.tsx'), 'utf8');
  const menuAst = ts.createSourceFile('NodeContextMenu.tsx', menuSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const appAst = ts.createSourceFile('ExplorerApp.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const produced = new Set<string>();
  const handled = new Set<string>();
  function walk(n: ts.Node, out: Set<string>, field: 'kind' | 'case'): void {
    if (field === 'kind' && ts.isPropertyAssignment(n) && n.name.getText() === 'kind' && ts.isStringLiteral(n.initializer)) out.add(n.initializer.text);
    if (field === 'case' && ts.isCaseClause(n) && n.expression && ts.isStringLiteral(n.expression)) out.add(n.expression.text);
    n.forEachChild((child) => walk(child, out, field));
  }
  walk(menuAst, produced, 'kind'); walk(appAst, handled, 'case');
  assert.deepEqual([...new Set([...kinds])].sort(), [...produced].filter((k) => ['action','copy','createBranch','mergeInto','openGitHub','viewDiff'].includes(k)).sort());
  assert.deepEqual([...kinds].sort(), [...handled].sort());
});

const VALID_ACTIONS: Record<GitActionRequest['action'], GitActionRequest> = {
  'checkout-branch': { action: 'checkout-branch', branch: 'main' },
  'checkout-commit': { action: 'checkout-commit', hash: node().hash },
  'create-branch': { action: 'create-branch', name: 'new-branch', startPoint: node().hash },
  merge: { action: 'merge', branch: 'main' },
  'merge-into': { action: 'merge-into', target: 'main', source: 'main' },
  revert: { action: 'revert', hash: node().hash },
  'reset-soft': { action: 'reset-soft', hash: node().hash },
  'reset-hard': { action: 'reset-hard', hash: node().hash },
  push: { action: 'push', remote: 'origin', branch: 'main' },
  'push-up-to': { action: 'push-up-to', remote: 'origin', branch: 'main', hash: node().hash },
  fetch: { action: 'fetch' },
  stash: { action: 'stash', message: 'audit' },
  'stash-pop': { action: 'stash-pop' },
  'merge-continue': { action: 'merge-continue' },
  'merge-abort': { action: 'merge-abort' },
};

const INVALID_ACTIONS: Record<GitActionRequest['action'], GitActionRequest> = {
  ...VALID_ACTIONS,
  'checkout-branch': { action: 'checkout-branch', branch: '-bad' },
  'checkout-commit': { action: 'checkout-commit', hash: 'bad' },
  'create-branch': { action: 'create-branch', name: '-bad', startPoint: 'bad' },
  merge: { action: 'merge', branch: '-bad' },
  'merge-into': { action: 'merge-into', target: '-bad', source: 'bad' },
  revert: { action: 'revert', hash: 'bad' },
  'reset-soft': { action: 'reset-soft', hash: 'bad' },
  'reset-hard': { action: 'reset-hard', hash: 'bad' },
  push: { action: 'push', remote: '-bad', branch: 'main' },
  'push-up-to': { action: 'push-up-to', remote: '-bad', branch: 'main', hash: 'bad' },
  fetch: { action: 'fetch', remote: '-bad' },
  stash: { action: 'stash', message: 1 as unknown as string },
  'stash-pop': { action: 'stash-pop' },
  'merge-continue': { action: 'merge-continue' },
  'merge-abort': { action: 'merge-abort' },
};

test('validateAction accepts every union member and rejects every invalid table row', async (t) => {
  const repo = await makeRepo({ label: 'menu-validation' });
  const h = repo.harness();
  t.after(() => { h.dispose(); return repo.cleanup(); });
  for (const action of Object.keys(VALID_ACTIONS) as GitActionRequest['action'][]) {
    const payload = { ...VALID_ACTIONS[action], idempotencyKey: `valid-${action}`, confirm: true, forceAcknowledgement: true };
    const response = await h.send('actions/git', payload);
    if (!response.ok) assert.notEqual(response.error.code, 'VALIDATION_ERROR', action);
  }
  for (const action of Object.keys(INVALID_ACTIONS) as GitActionRequest['action'][]) {
    const invalid = ['stash-pop', 'merge-continue', 'merge-abort'].includes(action)
      ? { action: 'not-an-action' }
      : INVALID_ACTIONS[action];
    const response = await h.send('actions/git', { ...invalid, idempotencyKey: `invalid-${action}` });
    assert.equal(response.ok, false, action);
    if (!response.ok) assert.equal(response.error.code, 'VALIDATION_ERROR', action);
  }
});

test('dirty revert fails at git level as DIRTY_TREE while dirty reset-soft succeeds after confirmation', async (t) => {
  const repo = await makeRepo({ commits: 2, label: 'menu-dirty-rewrite' });
  const h = repo.harness();
  t.after(() => { h.dispose(); return repo.cleanup(); });
  await fs.writeFile(path.join(repo.dir, 'c2.txt'), 'work\n', 'utf8');
  const current = await h.repo.status();
  const revert = await h.send('actions/git', { action: 'revert', hash: current.head, confirm: true, statusToken: current.statusToken, idempotencyKey: 'dirty-revert' });
  assert.equal(revert.ok, false);
  if (!revert.ok) {
    assert.equal(revert.error.code, 'DIRTY_TREE');
    assert.equal(revert.error.status, 412);
    assert.ok(revert.error.remedies?.includes('stash'));
    assert.ok(revert.error.remedies?.includes('commit'));
  }
  h.repo.invalidate();
  const before = await h.repo.status();
  const reset = await h.send('actions/git', { action: 'reset-soft', hash: before.head, confirm: true, statusToken: before.statusToken, idempotencyKey: 'dirty-reset' });
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal((await h.repo.status()).dirty, true);
});

test('dirty revert rejected with DIRTY_TREE succeeds after stash remedy', async (t) => {
  const repo = await makeRepo({ commits: 2, label: 'menu-dirty-revert-stash' });
  const h = repo.harness();
  t.after(() => { h.dispose(); return repo.cleanup(); });
  await fs.writeFile(path.join(repo.dir, 'c2.txt'), 'work\n', 'utf8');
  const current = await h.repo.status();
  const headBefore = current.head;
  const revert = await h.send('actions/git', { action: 'revert', hash: current.head, confirm: true, statusToken: current.statusToken, idempotencyKey: 'revert-key' });
  assert.equal(revert.ok, false);
  if (!revert.ok) assert.equal(revert.error.code, 'DIRTY_TREE');
  const stashed = await h.send('actions/git', { action: 'stash', message: 'auto stash', includeUntracked: true, idempotencyKey: 'stash-for-revert' });
  assert.equal(stashed.ok, true, JSON.stringify(stashed));
  h.repo.invalidate();
  const retried = await h.send('actions/git', { action: 'revert', hash: headBefore, confirm: true, idempotencyKey: 'revert-key' });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  const after = await h.repo.status();
  assert.notEqual(after.head, headBefore);
});

test('checkout branch retry with same key works after stash remedy', async (t) => {
  const repo = await makeRepo({ label: 'menu-stash-retry' });
  const h = repo.harness();
  t.after(() => { h.dispose(); return repo.cleanup(); });
  await repo.fork('feature');
  await fs.writeFile(path.join(repo.dir, 'dirty.txt'), 'work\n', 'utf8');
  h.repo.invalidate();
  const token = (await h.repo.status()).statusToken;
  const blocked = await h.send('actions/git', { action: 'checkout-branch', branch: 'feature', statusToken: token, idempotencyKey: 'checkout-stash' });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, 'DIRTY_TREE');
  const stashed = await h.send('actions/git', { action: 'stash', message: 'auto stash', includeUntracked: true, idempotencyKey: 'stash-remedy' });
  assert.equal(stashed.ok, true, JSON.stringify(stashed));
  h.repo.invalidate();
  const retried = await h.send('actions/git', { action: 'checkout-branch', branch: 'feature', idempotencyKey: 'checkout-stash' });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal((await repo.git.currentBranch()).branch, 'feature');
});

test('merge-into conflict leaves target branch in resolvable merge state', async (t) => {
  const repo = await makeRepo({ label: 'menu-merge-into-conflict' });
  const h = repo.harness();
  t.after(() => { h.dispose(); return repo.cleanup(); });
  await repo.conflict('side');
  await repo.git.mergeAbort();
  h.repo.invalidate();
  const before = await repo.git.headHash();
  const current = await h.repo.status();
  const response = await h.send('actions/git', { action: 'merge-into', target: 'main', source: 'side', confirm: true, statusToken: current.statusToken, idempotencyKey: 'merge-into-conflict' });
  assert.equal(response.ok, false);
  if (!response.ok) assert.ok(['SERVER_ERROR', 'CONFLICT'].includes(response.error.code));
  assert.equal((await repo.git.currentBranch()).branch, 'main');
  const conflicted = await h.repo.status();
  assert.equal(conflicted.operation, 'merge');
  assert.ok(conflicted.conflicts.length > 0);
  await repo.git.mergeAbort();
  assert.equal(await repo.git.headHash(), before);
  h.repo.invalidate();
  assert.equal((await h.repo.status()).operation, 'idle');
});
