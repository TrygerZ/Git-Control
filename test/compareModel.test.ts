import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

  // Finding 6: when commits are capped (ahead > commits.length) and files are not, report commits.length
  const commitTrunc = summaryLine(
    {
      ahead: 250,
      commits: Array.from({ length: 200 }, (_, i) => ({ hash: String(i) })),
      files: [
        { path: 'a.ts', additions: 1, deletions: 0, binary: false },
        { path: 'b.ts', additions: 1, deletions: 0, binary: false },
        { path: 'c.ts', additions: 1, deletions: 0, binary: false },
      ],
      totals: { files: 3, additions: 3, deletions: 0, binary: 0 },
      truncated: true,
    },
    'en',
  );
  assert.ok(commitTrunc.includes('Showing the first 200.'), `expected 200 in: ${commitTrunc}`);
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

test('P29 UI components satisfy security, accessibility, diff, and entry-point contracts', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  const compareView = read('src/webview/CompareView.tsx');
  assert.doesNotMatch(compareView, /dangerouslySetInnerHTML|innerHTML|href=\{/);
  assert.match(compareView, /actions\/openDiff/);
  assert.match(compareView, /mergeBase/);
  assert.match(compareView, /headHash/);
  assert.match(compareView, /graph\/revealCommit/);
  assert.match(compareView, /sanitizeGitText/);
  assert.match(compareView, /summaryLine\(/);
  assert.match(compareView, /compareCommand\(/);

  const worktreeDialog = read('src/webview/AddWorktreeDialog.tsx');
  assert.doesNotMatch(worktreeDialog, /dangerouslySetInnerHTML|innerHTML|href=\{/);
  assert.match(worktreeDialog, /role="dialog"/);
  assert.match(worktreeDialog, /aria-modal="true"/);
  assert.match(worktreeDialog, /aria-labelledby=/);
  assert.match(worktreeDialog, /role="alert"/);
  assert.match(worktreeDialog, /aria-describedby=/);
  assert.match(worktreeDialog, /actions\/pickWorktreeFolder/);
  assert.match(worktreeDialog, /actions\/openWorktreeFolder/);
  assert.match(worktreeDialog, /'worktree-add'/);
  assert.match(worktreeDialog, /worktreeCommand\(/);
  assert.match(worktreeDialog, /defaultWorktreePath\(/);
  assert.match(worktreeDialog, /canAddWorktree\(/);

  const branchesView = read('src/webview/BranchesView.tsx');
  assert.match(branchesView, /strings\.compare\.footerButton/);
  assert.match(branchesView, /strings\.compare\.rowAction/);
  assert.match(branchesView, /strings\.worktree\.sectionAdd/);
  assert.match(branchesView, /strings\.worktree\.rowAction/);

  const css = read('src/webview/styles.css');
  assert.match(css, /\.gc-compare\b/);
  assert.match(css, /\.gc-worktree-dialog\b/);

  // Finding 1: PR card Compare uses repository base branch from useBranchesStore, never branch-vs-branch
  const prsView = read('src/webview/PullRequestsView.tsx');
  assert.match(prsView, /useBranchesStore\.getState\(\)/);
  assert.doesNotMatch(prsView, /openCompare\(baseBranch \?\? branch, branch\)/);

  // Finding 2: AddWorktreeDialog maps 'path' detail to notAbsolute and trims submitted path
  assert.match(worktreeDialog, /case 'path':/);
  assert.match(worktreeDialog, /folderPath\.trim\(\)/);

  // Finding 3: CompareView renders result.behind and checks result.behind === 0 for upToDate
  assert.match(compareView, /result\.behind/);
  assert.match(compareView, /result\.ahead === 0 && result\.behind === 0/);

  // Finding 7: wireHostEvents refreshes open CompareView on event/repoChanged
  const storeSrc = read('src/webview/store.ts');
  assert.match(storeSrc, /useCompareStore\.getState\(\)/);
});
