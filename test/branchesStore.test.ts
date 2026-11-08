/**
 * Branches store slice and its persisted keys (P11).
 *
 * The view rebuilds on every sidebar reveal, so the sub-tab, the sort, and the
 * folded sections must survive a rebuild through webview state, and a reply that
 * arrives for a repo the user has already left must not repaint the list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridge, loadState, saveState } from '../src/webview/bridge';
import { useBranchesStore, useRouteStore, wireHostEvents } from '../src/webview/store';
import type { BranchRef, RefsResult, WorktreeInfo } from '../src/messages';

function ref(over: Partial<BranchRef> & { shortName: string }): BranchRef {
  return {
    ...over,
    refName: over.refName ?? `refs/heads/${over.shortName}`,
    shortName: over.shortName,
    kind: over.kind ?? 'local',
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

const REFS: RefsResult = {
  refs: [ref({ shortName: 'main', isHead: true }), ref({ shortName: 'feat/a' })],
  head: '0123456789abcdef0123456789abcdef01234567',
  currentBranch: 'main',
  base: 'main',
};

const WORKTREES: WorktreeInfo[] = [
  {
    path: '/repo',
    head: '0123456789abcdef0123456789abcdef01234567',
    branch: 'main',
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    isCurrent: true,
  },
];

interface Call {
  kind: string;
  payload: unknown;
}

function stub(reply: (kind: string) => unknown): { calls: Call[]; restore(): void } {
  const calls: Call[] = [];
  const original = bridge.request;
  bridge.request = (async (kind: string, payload: unknown): Promise<unknown> => {
    calls.push({ kind, payload });
    return reply(kind);
  }) as typeof bridge.request;
  return {
    calls,
    restore() {
      bridge.request = original;
    },
  };
}

function reset(): void {
  useBranchesStore.setState({
    refs: [],
    base: null,
    worktrees: [],
    tab: 'local',
    sort: 'recent',
    filter: '',
    collapsed: new Set(),
    loading: false,
    error: null,
  });
}

// ------------------------------------------------------------- persistence

test('loadState defaults the Branches view to the Local tab, recent sort, nothing folded', () => {
  saveState({
    branchesTab: undefined as unknown as 'local',
    branchSort: undefined as unknown as 'recent',
    collapsedBranchSections: undefined as unknown as [],
  });
  const state = loadState();
  assert.equal(state.branchesTab, 'local');
  assert.equal(state.branchSort, 'recent');
  assert.deepEqual(state.collapsedBranchSections, []);
});

test('loadState keeps the three known values', () => {
  saveState({ branchesTab: 'tags', branchSort: 'aheadBehind', collapsedBranchSections: ['local', 'tags'] });
  const state = loadState();
  assert.equal(state.branchesTab, 'tags');
  assert.equal(state.branchSort, 'aheadBehind');
  assert.deepEqual(state.collapsedBranchSections, ['local', 'tags']);
});

test('loadState rejects an unknown tab, an unknown sort, and unknown section keys', () => {
  saveState({
    branchesTab: 'stashes' as unknown as 'local',
    branchSort: 'oldest' as unknown as 'recent',
    collapsedBranchSections: ['local', 7, 'nope'] as unknown as ['local'],
  });
  const state = loadState();
  assert.equal(state.branchesTab, 'local', 'an unknown sub-tab falls back to Local');
  assert.equal(state.branchSort, 'recent', 'an unknown sort falls back to recent activity');
  assert.deepEqual(state.collapsedBranchSections, ['local'], 'only known section keys survive');
});

// --------------------------------------------------------------- selection

test('setTab and setSort update the slice and persist, so a rebuild restores them', () => {
  reset();
  useBranchesStore.getState().setTab('remote');
  useBranchesStore.getState().setSort('name');
  assert.equal(useBranchesStore.getState().tab, 'remote');
  assert.equal(useBranchesStore.getState().sort, 'name');
  assert.equal(loadState().branchesTab, 'remote');
  assert.equal(loadState().branchSort, 'name');
});

test('toggleSection folds and unfolds one section and persists the set as a list', () => {
  reset();
  useBranchesStore.getState().toggleSection('worktrees');
  assert.deepEqual([...useBranchesStore.getState().collapsed], ['worktrees']);
  assert.deepEqual(loadState().collapsedBranchSections, ['worktrees']);

  useBranchesStore.getState().toggleSection('tags');
  assert.deepEqual([...useBranchesStore.getState().collapsed].sort(), ['tags', 'worktrees']);

  useBranchesStore.getState().toggleSection('worktrees');
  assert.deepEqual([...useBranchesStore.getState().collapsed], ['tags']);
  assert.deepEqual(loadState().collapsedBranchSections, ['tags']);
});

test('setFilter narrows what is drawn and never persists', () => {
  reset();
  useBranchesStore.getState().setFilter('feat');
  assert.equal(useBranchesStore.getState().filter, 'feat');
  assert.equal(loadState().prQuery, '', 'the Branches filter has no persisted key');
});

// -------------------------------------------------------------------- load

test('load reads refs and worktrees together and keeps the base branch', async () => {
  reset();
  const s = stub((kind) => (kind === 'repos/refs' ? REFS : { worktrees: WORKTREES }));
  try {
    await useBranchesStore.getState().load();
  } finally {
    s.restore();
  }
  assert.deepEqual(
    s.calls.map((c) => c.kind).sort(),
    ['repos/refs', 'repos/worktrees'],
  );
  const state = useBranchesStore.getState();
  assert.deepEqual(state.refs, REFS.refs);
  assert.equal(state.base, 'main');
  assert.deepEqual(state.worktrees, WORKTREES);
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
});

test('load keeps the last good list and reports the error when a read fails', async () => {
  reset();
  useBranchesStore.setState({ refs: REFS.refs, base: 'main', worktrees: WORKTREES });
  const s = stub(() => {
    throw Object.assign(new Error('boom'), { body: { status: 500, code: 'SERVER_ERROR', message: 'boom' } });
  });
  try {
    await useBranchesStore.getState().load();
  } finally {
    s.restore();
  }
  const state = useBranchesStore.getState();
  assert.equal(state.error?.message, 'boom');
  assert.deepEqual(state.refs, REFS.refs, 'a failed refresh does not blank the list');
  assert.equal(state.loading, false, 'the spinner always stops');
});

test('a second load while one is in flight reuses it instead of sending another pair', async () => {
  reset();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = bridge.request;
  const calls: string[] = [];
  bridge.request = (async (kind: string): Promise<unknown> => {
    calls.push(kind);
    await gate;
    return kind === 'repos/refs' ? REFS : { worktrees: WORKTREES };
  }) as typeof bridge.request;
  try {
    const first = useBranchesStore.getState().load();
    const second = useBranchesStore.getState().load();
    release?.();
    await Promise.all([first, second]);
  } finally {
    bridge.request = original;
  }
  assert.deepEqual(calls.sort(), ['repos/refs', 'repos/worktrees'], 'one pair of reads, not two');
});

// ------------------------------------------------------- event-driven reload

test('a repo change reloads the list only while the Branches route is active', async () => {
  reset();
  useRouteStore.setState({ route: { id: 'branches', sub: 'local' } });
  const s = stub((kind) => (kind === 'repos/refs' ? REFS : { worktrees: WORKTREES }));
  const off = wireHostEvents('pending');
  try {
    // The bridge dispatches to its listeners; this is the same payload the host pushes.
    (bridge as unknown as { receive(raw: unknown): void }).receive({
      kind: 'event/repoChanged',
      payload: { reason: 'fs', statusToken: 'tok' },
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
  } finally {
    off();
    s.restore();
  }
  assert.ok(s.calls.some((c) => c.kind === 'repos/refs'), 'the open view refreshed its refs');
});
