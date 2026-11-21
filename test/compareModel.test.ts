import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAddWorktree,
  canOfferAddWorktree,
  compareCommand,
  defaultWorktreePath,
  summaryLine,
  swapSides,
  worktreeCommand,
} from '../src/webview/compareModel';
import { useCompareStore } from '../src/webview/store';

test('summaryLine formats counts in en and id and appends truncated note when truncated', () => {
  const base = {
    ahead: 2,
    files: [{ path: 'a.ts', additions: 10, deletions: 3, binary: false }],
    totals: { files: 1, additions: 10, deletions: 3, binary: 0 },
    truncated: false,
  };
  assert.equal(summaryLine(base, 'en'), '2 commits, 1 files, +10 -3');
  assert.equal(summaryLine(base, 'id'), '2 commit, 1 file, +10 -3');

  const truncEn = summaryLine({ ...base, truncated: true }, 'en');
  assert.ok(truncEn.includes('2 commits, 1 files, +10 -3'));
  assert.ok(truncEn.includes('Showing the first 1.'));

  const truncId = summaryLine({ ...base, truncated: true }, 'id');
  assert.ok(truncId.includes('2 commit, 1 file, +10 -3'));
  assert.ok(truncId.includes('Menampilkan 1 pertama.'));
});

test('swapSides swaps base and head without mutating input', () => {
  const input = { base: 'main', head: 'feat/x' };
  assert.deepEqual(swapSides(input), { base: 'feat/x', head: 'main' });
  assert.deepEqual(input, { base: 'main', head: 'feat/x' });
});

test('defaultWorktreePath replaces slashes in branch names and handles POSIX and Windows roots', () => {
  assert.equal(
    defaultWorktreePath('git-control', 'fix/graph-edges', '/home/dev/git-control'),
    '/home/dev/git-control-fix-graph-edges',
  );
  assert.equal(
    defaultWorktreePath('git-control', 'fix/graph-edges', 'D:\\Work\\git-control'),
    'D:\\Work\\git-control-fix-graph-edges',
  );
  assert.equal(
    defaultWorktreePath('repo', 'feat/a/b', 'C:\\repo\\'),
    'C:\\repo-feat-a-b',
  );
  assert.equal(
    defaultWorktreePath('repo', 'feature', '/repo'),
    '/repo-feature',
  );
});

test('canAddWorktree requires non-empty path and branch and blocks existing worktree paths', () => {
  assert.equal(canAddWorktree({ path: '/tmp/wt-1', branch: 'feature' }, ['/tmp/repo']), true);
  assert.equal(canAddWorktree({ path: '', branch: 'feature' }, ['/tmp/repo']), false);
  assert.equal(canAddWorktree({ path: '/tmp/wt-1', branch: '' }, ['/tmp/repo']), false);
  assert.equal(canAddWorktree({ path: '/tmp/repo', branch: 'feature' }, ['/tmp/repo']), false);
  assert.equal(canAddWorktree({ path: 'c:/work/repo', branch: 'feature' }, ['C:\\Work\\Repo']), false);
});

test('canOfferAddWorktree offers local unchecked-out branches even with a single worktree and hides remote or checked-out rows', () => {
  const singleWorktree = [{ branch: 'main' }];
  assert.equal(canOfferAddWorktree({ kind: 'local', name: 'feature' }, singleWorktree), true);
  assert.equal(canOfferAddWorktree({ kind: 'local', name: 'main' }, singleWorktree), false);
  assert.equal(canOfferAddWorktree({ kind: 'remote', name: 'origin/feature' }, singleWorktree), false);

  const multiWorktree = [{ branch: 'main' }, { branch: 'feature' }, { branch: null }];
  assert.equal(canOfferAddWorktree({ kind: 'local', name: 'feature' }, multiWorktree), false);
  assert.equal(canOfferAddWorktree({ kind: 'local', name: 'other' }, multiWorktree), true);
});

test('compareCommand and worktreeCommand format exact command previews', () => {
  assert.equal(compareCommand('main', 'feature'), 'git diff main...feature');
  assert.equal(
    worktreeCommand('D:\\Work\\git-control-fix-edges', 'fix/edges'),
    'git worktree add -- D:\\Work\\git-control-fix-edges fix/edges',
  );
});

test('useCompareStore manages open, base, head, swap, and reset state', () => {
  useCompareStore.getState().reset();
  assert.equal(useCompareStore.getState().open, false);

  useCompareStore.setState({ base: 'main', head: 'feature', open: true });
  assert.equal(useCompareStore.getState().base, 'main');
  assert.equal(useCompareStore.getState().head, 'feature');

  useCompareStore.getState().closeCompare();
  assert.equal(useCompareStore.getState().open, false);
});
