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
import { useBranchesStore, useOperationStore, useRouteStore, wireHostEvents } from '../src/webview/store';
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
    sort: 'recent',
    filter: '',
    collapsed: new Set(),
    loading: false,
    error: null,
  });
}

// ------------------------------------------------------------- persistence

test('loadState defaults the Branches sort to recent activity with nothing folded', () => {
  saveState({
    branchSort: undefined as unknown as 'recent',
    collapsedBranchSections: undefined as unknown as [],
  });
  const state = loadState();
  assert.equal(state.branchSort, 'recent');
  assert.deepEqual(state.collapsedBranchSections, []);
});

test('loadState keeps the known sort and the folded sections', () => {
  saveState({ branchSort: 'aheadBehind', collapsedBranchSections: ['local', 'tags'] });
  const state = loadState();
  assert.equal(state.branchSort, 'aheadBehind');
  assert.deepEqual(state.collapsedBranchSections, ['local', 'tags']);
});

test('loadState rejects an unknown sort and unknown section keys', () => {
  saveState({
    branchSort: 'oldest' as unknown as 'recent',
    collapsedBranchSections: ['local', 7, 'nope'] as unknown as ['local'],
  });
  const state = loadState();
  assert.equal(state.branchSort, 'recent', 'an unknown sort falls back to recent activity');
  assert.deepEqual(state.collapsedBranchSections, ['local'], 'only known section keys survive');
});

// --------------------------------------------------------------- selection

test('setSort updates the slice and persists, so a rebuild restores it', () => {
  reset();
  useBranchesStore.getState().setSort('name');
  assert.equal(useBranchesStore.getState().sort, 'name');
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

// ------------------------------------------------------- cleanup (P20)

/**
 * Deleting N branches is N mutations, not one: each has its own guard verdict
 * and its own git refusal. The store runs them in order and reports what
 * happened, because a partial run is the normal case when one branch turned out
 * to be unmerged.
 */
test('deleteBranches runs one action per branch and reports the tally', async () => {
  const calls: Array<{ action: string; branch?: string }> = [];
  const original = useOperationStore.getState().runAction;
  const originalLoad = useBranchesStore.getState().load;
  useBranchesStore.setState({ load: async () => undefined });
  useOperationStore.setState({
    runAction: async (request) => {
      calls.push({ action: request.action, ...('branch' in request ? { branch: request.branch } : {}) });
      return true;
    },
  });
  try {
    const result = await useBranchesStore.getState().deleteBranches(['feat/a', 'fix/b'], null);
    assert.deepEqual(calls, [
      { action: 'branch-delete', branch: 'feat/a' },
      { action: 'branch-delete', branch: 'fix/b' },
    ]);
    assert.deepEqual(result, { ok: 2, failed: [] });
  } finally {
    useOperationStore.setState({ runAction: original });
    useBranchesStore.setState({ load: originalLoad });
  }
});

test('deleteBranches collects each skipped branch by name', async () => {
  const original = useOperationStore.getState().runAction;
  const originalLoad = useBranchesStore.getState().load;
  useBranchesStore.setState({ load: async () => undefined });
  useOperationStore.setState({
    runAction: async (request) => ('branch' in request ? request.branch !== 'fix/b' : true),
  });
  try {
    const result = await useBranchesStore.getState().deleteBranches(['feat/a', 'fix/b'], null);
    assert.deepEqual(result, { ok: 1, failed: ['fix/b'] });
  } finally {
    useOperationStore.setState({ runAction: original });
    useBranchesStore.setState({ load: originalLoad });
  }
});

test('deleteBranches with the remote flag follows each local delete with a remote one', async () => {
  const calls: string[] = [];
  const original = useOperationStore.getState().runAction;
  const originalLoad = useBranchesStore.getState().load;
  useBranchesStore.setState({ load: async () => undefined });
  useOperationStore.setState({
    runAction: async (request) => {
      calls.push(request.action);
      return true;
    },
  });
  try {
    await useBranchesStore.getState().deleteBranches(['feat/a'], 'origin');
    assert.deepEqual(calls, ['branch-delete', 'branch-delete-remote']);
  } finally {
    useOperationStore.setState({ runAction: original });
    useBranchesStore.setState({ load: originalLoad });
  }
});

/**
 * The dialog the user pressed IS the level 1 confirmation, so each delete must
 * carry `confirm: true`. Without it every branch parks in the guard dialog
 * instead of being deleted, and the run reports a tally that never happened.
 */
test('deleteBranches confirms each delete and asks for the level 2 acknowledgement', async () => {
  const extras: Array<Record<string, unknown>> = [];
  const original = useOperationStore.getState().runAction;
  const originalLoad = useBranchesStore.getState().load;
  useBranchesStore.setState({ load: async () => undefined });
  useOperationStore.setState({
    runAction: async (_request, extra) => {
      extras.push(extra ?? {});
      return true;
    },
  });
  try {
    await useBranchesStore.getState().deleteBranches(['feat/a'], 'origin');
    assert.equal(extras.length, 2);
    assert.equal(extras[0]?.confirm, true, 'the local delete is already confirmed by the dialog');
    assert.equal(extras[1]?.confirm, true);
    assert.equal(extras[1]?.forceAcknowledgement, true, 'the remote delete needs the level 2 flag');
  } finally {
    useOperationStore.setState({ runAction: original });
    useBranchesStore.setState({ load: originalLoad });
  }
});

/**
 * Criterion 2: the branch disappears from the view without a manual refresh, so
 * a run that removed at least one branch must reload the list. A run that
 * removed nothing must not, or a refused delete would cost a refetch for nothing.
 */
test('deleteBranches reloads the list only when something was actually removed', async () => {
  const original = useOperationStore.getState().runAction;
  const originalLoad = useBranchesStore.getState().load;
  let loads = 0;
  useBranchesStore.setState({ load: async () => { loads += 1; } });
  try {
    useOperationStore.setState({ runAction: async () => true });
    await useBranchesStore.getState().deleteBranches(['feat/a'], null);
    assert.equal(loads, 1);

    useOperationStore.setState({ runAction: async () => false });
    await useBranchesStore.getState().deleteBranches(['fix/b'], null);
    assert.equal(loads, 1, 'a run that removed nothing has nothing to reload');
  } finally {
    useOperationStore.setState({ runAction: original });
    useBranchesStore.setState({ load: originalLoad });
  }
});
