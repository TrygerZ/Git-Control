import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ancestorPrefixes,
  buildTree,
  collectPaths,
  flattenTree,
  groupBySection,
  isSectionBulkDisabled,
  pruneSelection,
  sectionOf,
  stageableFrom,
  unstageableFrom,
  toggleNode,
  togglePath,
  triState,
  type FolderNode,
} from '../src/webview/tree';
import type { ChangeEntry } from '../src/messages';

/** Minimal entry factory; only the fields the tree cares about matter. */
function entry(path: string, overrides: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    path,
    indexStatus: 'M',
    worktreeStatus: ' ',
    staged: true,
    unstaged: false,
    untracked: false,
    additions: 1,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

const nested: ChangeEntry[] = [
  entry('src/webview/main.tsx'),
  entry('src/webview/store.ts'),
  entry('src/git.ts'),
  entry('README.md'),
];

test('buildTree nests folders and sorts folders before files', () => {
  const root = buildTree(nested);
  assert.deepEqual(
    root.children.map((c) => `${c.kind}:${c.name}`),
    ['folder:src', 'file:README.md'],
  );
  const src = root.children[0] as FolderNode;
  assert.deepEqual(
    src.children.map((c) => `${c.kind}:${c.name}`),
    ['folder:webview', 'file:git.ts'],
  );
});

test('buildTree keeps deep paths addressable by prefix', () => {
  const root = buildTree(nested);
  const src = root.children[0] as FolderNode;
  const webview = src.children[0] as FolderNode;
  assert.equal(webview.path, 'src/webview');
  assert.deepEqual(collectPaths(webview), ['src/webview/main.tsx', 'src/webview/store.ts']);
});

test('buildTree keys renames on the new path', () => {
  const root = buildTree([entry('new/name.ts', { origPath: 'old/name.ts', indexStatus: 'R' })]);
  const folder = root.children[0] as FolderNode;
  assert.equal(folder.name, 'new');
  assert.deepEqual(collectPaths(folder), ['new/name.ts']);
});

test('buildTree ignores empty paths', () => {
  const root = buildTree([entry('')]);
  assert.equal(root.children.length, 0);
});

test('triState of a nested folder reflects partial selection', () => {
  const root = buildTree(nested);
  const src = root.children[0] as FolderNode;
  const webview = src.children[0] as FolderNode;

  assert.equal(triState(webview, new Set()), 'unchecked');
  assert.equal(triState(webview, new Set(['src/webview/main.tsx'])), 'indeterminate');
  assert.equal(
    triState(webview, new Set(['src/webview/main.tsx', 'src/webview/store.ts'])),
    'checked',
  );
  // The parent is still partial because src/git.ts is unselected.
  assert.equal(
    triState(src, new Set(['src/webview/main.tsx', 'src/webview/store.ts'])),
    'indeterminate',
  );
  assert.equal(
    triState(src, new Set(['src/webview/main.tsx', 'src/webview/store.ts', 'src/git.ts'])),
    'checked',
  );
});

test('triState treats an empty folder as unchecked', () => {
  const empty: FolderNode = { kind: 'folder', path: 'a', name: 'a', children: [] };
  assert.equal(triState(empty, new Set(['a/x'])), 'unchecked');
});

test('toggleNode selects every descendant recursively', () => {
  const root = buildTree(nested);
  const src = root.children[0] as FolderNode;
  const selected = toggleNode(src, new Set());
  assert.deepEqual(
    [...selected].sort(),
    ['src/git.ts', 'src/webview/main.tsx', 'src/webview/store.ts'],
  );
});

test('toggleNode on a fully selected folder clears it', () => {
  const root = buildTree(nested);
  const src = root.children[0] as FolderNode;
  const full = toggleNode(src, new Set());
  const cleared = toggleNode(src, full);
  assert.equal(cleared.size, 0);
});

test('toggleNode on a partial folder selects the rest instead of clearing', () => {
  const root = buildTree(nested);
  const src = root.children[0] as FolderNode;
  const next = toggleNode(src, new Set(['src/git.ts']));
  assert.equal(next.size, 3);
});

test('toggleNode does not touch siblings outside the folder', () => {
  const root = buildTree(nested);
  const src = root.children[0] as FolderNode;
  const next = toggleNode(src, new Set(['README.md']));
  assert.ok(next.has('README.md'));
});

test('togglePath flips a single entry', () => {
  const on = togglePath('a.ts', new Set());
  assert.deepEqual([...on], ['a.ts']);
  assert.equal(togglePath('a.ts', on).size, 0);
});

test('pruneSelection drops paths that vanished after a refresh', () => {
  const pruned = pruneSelection(new Set(['gone.ts', 'README.md']), nested);
  assert.deepEqual([...pruned], ['README.md']);
});

test('sectionOf puts conflicts first, then untracked, staged, unstaged', () => {
  assert.equal(sectionOf(entry('a', { indexStatus: 'U' })), 'conflicted');
  assert.equal(sectionOf(entry('a', { worktreeStatus: 'U' })), 'conflicted');
  assert.equal(sectionOf(entry('a', { untracked: true, staged: false })), 'untracked');
  assert.equal(sectionOf(entry('a', { staged: true })), 'staged');
  assert.equal(sectionOf(entry('a', { staged: false, unstaged: true })), 'unstaged');
});

test('sectionOf never double-counts a conflicted staged file', () => {
  assert.equal(sectionOf(entry('a', { indexStatus: 'U', staged: true })), 'conflicted');
});

test('groupBySection preserves input order inside a group', () => {
  const groups = groupBySection([entry('b.ts'), entry('a.ts')]);
  assert.deepEqual(
    groups.staged.map((e) => e.path),
    ['b.ts', 'a.ts'],
  );
  assert.equal(groups.conflicted.length, 0);
});

test('ancestorPrefixes lists folders nearest last', () => {
  assert.deepEqual(ancestorPrefixes('a/b/c.ts'), ['a', 'a/b']);
  assert.deepEqual(ancestorPrefixes('top.ts'), []);
});

test('flattenTree hides children of collapsed folders', () => {
  const root = buildTree(nested);
  const open = flattenTree(root, new Set());
  const closed = flattenTree(root, new Set(['src']));
  assert.equal(open.length, 6); // src, webview, main, store, git, README
  assert.equal(closed.length, 2); // src (collapsed) + README
  assert.deepEqual(
    closed.map((r) => r.node.name),
    ['src', 'README.md'],
  );
});

test('flattenTree reports depth for indentation', () => {
  const rows = flattenTree(buildTree(nested), new Set());
  const main = rows.find((r) => r.node.name === 'main.tsx');
  assert.equal(main?.depth, 2);
});

test('stageableFrom keeps modified and untracked, drops ignored and unknown', () => {
  const entries: ChangeEntry[] = [
    entry('mod.ts', { indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true }),
    entry('new.ts', { indexStatus: '?', worktreeStatus: '?', staged: false, untracked: true }),
    entry('ignored.ts', { indexStatus: '!', worktreeStatus: '!' }),
  ];
  const selected = ['mod.ts', 'new.ts', 'ignored.ts', 'unknown.ts'];
  const res = stageableFrom(selected, entries);
  assert.deepEqual(res, ['mod.ts', 'new.ts']);
});

test('unstageableFrom keeps staged and conflicted, drops untracked and unknown', () => {
  const entries: ChangeEntry[] = [
    entry('staged.ts', { indexStatus: 'M', worktreeStatus: ' ', staged: true, unstaged: false }),
    entry('conflict.ts', { indexStatus: 'U', worktreeStatus: 'U', staged: false, unstaged: true }),
    entry('untracked.ts', { indexStatus: '?', worktreeStatus: '?', staged: false, untracked: true }),
  ];
  const conflicts = [{ path: 'conflict.ts' }];
  const selected = ['staged.ts', 'conflict.ts', 'untracked.ts', 'missing.ts'];
  const res = unstageableFrom(selected, entries, conflicts);
  assert.deepEqual(res, ['staged.ts', 'conflict.ts']);
});

test('isSectionBulkDisabled disables on busy, empty paths, or collapsed section', () => {
  assert.equal(isSectionBulkDisabled(false, 5, false), false);
  assert.equal(isSectionBulkDisabled(true, 5, false), true);
  assert.equal(isSectionBulkDisabled(false, 0, false), true);
  assert.equal(isSectionBulkDisabled(false, 5, true), true);
  assert.equal(isSectionBulkDisabled(true, 0, true), true);
});


