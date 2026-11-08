/**
 * Branches view model (P11).
 *
 * Every decision the Branches destination makes about order, grouping, chips,
 * and filtering lives in one pure module, so it is pinned here without a DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  branchRow,
  chipsFor,
  filterRows,
  groupRemotes,
  sortLocals,
  tagRows,
  visibleWorktrees,
  type BranchRowModel,
} from '../src/webview/branchesModel';
import type { BranchRef, WorktreeInfo } from '../src/messages';

function ref(over: Partial<BranchRef> & { shortName: string }): BranchRef {
  // A slash in the name is common for local branches too (`feat/x`), so the kind
  // is never guessed from it.
  const kind = over.kind ?? 'local';
  const prefix = kind === 'remote' ? 'refs/remotes/' : kind === 'tag' ? 'refs/tags/' : 'refs/heads/';
  return {
    ...over,
    refName: over.refName ?? `${prefix}${over.shortName}`,
    shortName: over.shortName,
    kind,
    objectName: over.objectName ?? '0123456789abcdef0123456789abcdef01234567',
    upstream: over.upstream ?? null,
    ahead: over.ahead ?? 0,
    behind: over.behind ?? 0,
    isHead: over.isHead ?? false,
    gone: over.gone ?? false,
    committedAt: over.committedAt ?? null,
    merged: over.merged ?? false,
  };
}

function row(over: Partial<BranchRowModel> & { shortName: string }): BranchRowModel {
  return {
    ...over,
    key: over.key ?? `refs/heads/${over.shortName}`,
    shortName: over.shortName,
    isCurrent: over.isCurrent ?? false,
    ahead: over.ahead ?? 0,
    behind: over.behind ?? 0,
    chips: over.chips ?? [],
    committedAt: over.committedAt ?? null,
  };
}

function worktree(over: Partial<WorktreeInfo> & { path: string }): WorktreeInfo {
  return {
    ...over,
    path: over.path,
    head: over.head ?? null,
    branch: over.branch ?? null,
    detached: over.detached ?? false,
    bare: over.bare ?? false,
    locked: over.locked ?? false,
    prunable: over.prunable ?? false,
    isCurrent: over.isCurrent ?? false,
  };
}

// ------------------------------------------------------------------- chips

test('a branch whose upstream was deleted shows upstream gone', () => {
  assert.deepEqual(chipsFor(ref({ shortName: 'spike/x', gone: true, upstream: 'refs/remotes/o/spike/x' })), [
    'upstreamGone',
  ]);
});

test('a merged local branch shows merged, and a branch with no upstream shows local only', () => {
  assert.deepEqual(chipsFor(ref({ shortName: 'old', merged: true })), ['merged']);
  assert.deepEqual(chipsFor(ref({ shortName: 'fresh', upstream: null })), ['localOnly']);
});

test('a plain branch with an upstream and no merge shows no chip', () => {
  assert.deepEqual(chipsFor(ref({ shortName: 'main', upstream: 'refs/remotes/origin/main' })), []);
});

test('a row never carries two chips, so gone wins over merged', () => {
  assert.deepEqual(
    chipsFor(ref({ shortName: 'x', gone: true, merged: true, upstream: 'refs/remotes/o/x' })),
    ['upstreamGone'],
  );
});

test('the current branch never claims merged, and remote refs get no chips', () => {
  assert.deepEqual(chipsFor(ref({ shortName: 'main', isHead: true, merged: true })), []);
  assert.deepEqual(chipsFor(ref({ shortName: 'main', isHead: true })), []);
  assert.deepEqual(
    chipsFor(ref({ shortName: 'origin/x', kind: 'remote', upstream: 'refs/remotes/origin/x' })),
    [],
  );
});

test('a tag gets no chip', () => {
  assert.deepEqual(chipsFor(ref({ shortName: 'v1.0', kind: 'tag', refName: 'refs/tags/v1.0' })), []);
});

// -------------------------------------------------------------- branchRow

test('branchRow copies the facts the row draws and keeps the ref name as the key', () => {
  const source = ref({
    shortName: 'feat/a',
    refName: 'refs/heads/feat/a',
    isHead: true,
    ahead: 3,
    behind: 2,
    committedAt: '2026-11-01T10:00:00+07:00',
  });
  assert.deepEqual(branchRow(source), {
    key: 'refs/heads/feat/a',
    shortName: 'feat/a',
    isCurrent: true,
    ahead: 3,
    behind: 2,
    chips: [],
    committedAt: '2026-11-01T10:00:00+07:00',
  });
});

// --------------------------------------------------------------- sortLocals

const DATED = [
  row({ shortName: 'b-old', committedAt: '2026-10-01T00:00:00Z' }),
  row({ shortName: 'a-new', committedAt: '2026-11-01T00:00:00Z' }),
  row({ shortName: 'c-none', committedAt: null }),
];

test('recent puts the newest first, missing dates last, and breaks ties by name', () => {
  assert.deepEqual(
    sortLocals(DATED, 'recent').map((r) => r.shortName),
    ['a-new', 'b-old', 'c-none'],
  );
  const tie = [
    row({ shortName: 'zeta', committedAt: '2026-11-01T00:00:00Z' }),
    row({ shortName: 'Alpha', committedAt: '2026-11-01T00:00:00Z' }),
  ];
  assert.deepEqual(
    sortLocals(tie, 'recent').map((r) => r.shortName),
    ['Alpha', 'zeta'],
    'ties fall back to a case-insensitive name order',
  );
});

test('name sorts case-insensitively and never depends on the date', () => {
  assert.deepEqual(
    sortLocals(DATED, 'name').map((r) => r.shortName),
    ['a-new', 'b-old', 'c-none'],
  );
  assert.deepEqual(
    sortLocals([row({ shortName: 'beta' }), row({ shortName: 'Alpha' }), row({ shortName: 'gamma' })], 'name').map(
      (r) => r.shortName,
    ),
    ['Alpha', 'beta', 'gamma'],
  );
});

test('aheadBehind puts the largest divergence first and breaks ties by name', () => {
  const rows = [
    row({ shortName: 'flat' }),
    row({ shortName: 'busy', ahead: 4, behind: 3 }),
    row({ shortName: 'some', ahead: 2 }),
    row({ shortName: 'also-busy', ahead: 3, behind: 4 }),
  ];
  assert.deepEqual(
    sortLocals(rows, 'aheadBehind').map((r) => r.shortName),
    ['also-busy', 'busy', 'some', 'flat'],
  );
});

test('sortLocals returns a new array and leaves the input untouched', () => {
  const input = [row({ shortName: 'b' }), row({ shortName: 'a' })];
  const snapshot = input.map((r) => r.shortName);
  const sorted = sortLocals(input, 'name');
  assert.notEqual(sorted, input);
  assert.deepEqual(input.map((r) => r.shortName), snapshot);
  assert.deepEqual(sorted.map((r) => r.shortName), ['a', 'b']);
});

// --------------------------------------------------------------- filterRows

test('filterRows matches a case-insensitive substring of the displayed name', () => {
  const rows = [row({ shortName: 'feat/login' }), row({ shortName: 'fix/LOGOUT' })];
  assert.deepEqual(
    filterRows(rows, 'log').map((r) => r.shortName),
    ['feat/login', 'fix/LOGOUT'],
  );
});

test('filterRows returns the input for an empty or blank query and nothing when nothing matches', () => {
  const rows = [row({ shortName: 'main' })];
  assert.equal(filterRows(rows, ''), rows);
  assert.equal(filterRows(rows, '   '), rows);
  assert.deepEqual(filterRows(rows, 'nope'), []);
});

test('filterRows also reads a tag row name', () => {
  const tags = [
    { key: 'k1', name: 'v2.7.0', shortHash: 'aaaaaaa', committedAt: null },
    { key: 'k2', name: 'v1.0.0', shortHash: 'bbbbbbb', committedAt: null },
  ];
  assert.deepEqual(filterRows(tags, '2.').map((r) => r.name), ['v2.7.0']);
});

// -------------------------------------------------------------- groupRemotes

test('groupRemotes groups by the segment before the first slash and puts origin first', () => {
  const refs = [
    ref({ shortName: 'upstream/main', kind: 'remote' }),
    ref({ shortName: 'origin/main', kind: 'remote' }),
    ref({ shortName: 'upstream/release', kind: 'remote' }),
    ref({ shortName: 'zeta/x', kind: 'remote' }),
  ];
  const groups = groupRemotes(refs);
  assert.deepEqual(
    groups.map((g) => g.remote),
    ['origin', 'upstream', 'zeta'],
  );
  assert.deepEqual(
    groups[1]?.rows.map((r) => r.shortName),
    ['upstream/main', 'upstream/release'],
  );
});

test('groupRemotes skips the symbolic remote head and non-remote refs', () => {
  const groups = groupRemotes([
    ref({ shortName: 'origin/HEAD', kind: 'remote', refName: 'refs/remotes/origin/HEAD' }),
    ref({ shortName: 'origin/main', kind: 'remote' }),
    ref({ shortName: 'main', kind: 'local' }),
    ref({ shortName: 'v1.0', kind: 'tag', refName: 'refs/tags/v1.0' }),
  ]);
  assert.deepEqual(groups.map((g) => g.remote), ['origin']);
  assert.deepEqual(groups[0]?.rows.map((r) => r.shortName), ['origin/main']);
});

test('groupRemotes keeps a remote branch literally named HEAD', () => {
  const groups = groupRemotes([ref({ shortName: 'origin/feature/HEAD', kind: 'remote' })]);
  assert.deepEqual(groups.map((g) => g.remote), ['origin']);
  assert.deepEqual(groups[0]?.rows.map((r) => r.shortName), ['origin/feature/HEAD']);
});

// ---------------------------------------------------------------- tagRows

test('tagRows orders newest first, missing dates last, and reports the short hash', () => {
  const refs = [
    ref({ shortName: 'v1.0.0', kind: 'tag', refName: 'refs/tags/v1.0.0', committedAt: '2026-10-01T00:00:00Z', objectName: 'aaaaaaa111' }),
    ref({ shortName: 'v2.0.0', kind: 'tag', refName: 'refs/tags/v2.0.0', committedAt: '2026-11-01T00:00:00Z', objectName: 'bbbbbbb222' }),
    ref({ shortName: 'v0.1.0', kind: 'tag', refName: 'refs/tags/v0.1.0', committedAt: null, objectName: 'ccccccc333' }),
  ];
  assert.deepEqual(tagRows(refs), [
    { key: 'refs/tags/v2.0.0', name: 'v2.0.0', shortHash: 'bbbbbbb', committedAt: '2026-11-01T00:00:00Z' },
    { key: 'refs/tags/v1.0.0', name: 'v1.0.0', shortHash: 'aaaaaaa', committedAt: '2026-10-01T00:00:00Z' },
    { key: 'refs/tags/v0.1.0', name: 'v0.1.0', shortHash: 'ccccccc', committedAt: null },
  ]);
});

test('tagRows honours a limit and ignores non-tag refs', () => {
  const refs = [
    ref({ shortName: 'v1.0.0', kind: 'tag', refName: 'refs/tags/v1.0.0', committedAt: '2026-11-01T00:00:00Z' }),
    ref({ shortName: 'v2.0.0', kind: 'tag', refName: 'refs/tags/v2.0.0', committedAt: '2026-10-01T00:00:00Z' }),
    ref({ shortName: 'main', kind: 'local' }),
  ];
  assert.deepEqual(tagRows(refs, 1).map((r) => r.name), ['v1.0.0']);
  assert.deepEqual(tagRows(refs).map((r) => r.name), ['v1.0.0', 'v2.0.0']);
});

// --------------------------------------------------------- visibleWorktrees

test('visibleWorktrees hides the section when only the current worktree exists', () => {
  assert.deepEqual(visibleWorktrees([worktree({ path: '/repo', isCurrent: true })]), []);
  assert.deepEqual(visibleWorktrees([]), []);
});

test('visibleWorktrees lists every worktree once a second one exists', () => {
  const list = [
    worktree({ path: '/repo', isCurrent: true, branch: 'main' }),
    worktree({ path: '/repo-feat', branch: 'feat/a' }),
  ];
  assert.deepEqual(visibleWorktrees(list), list);
});
