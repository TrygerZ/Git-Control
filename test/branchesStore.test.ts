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
import { remoteForBranch, useBranchesStore, useOperationStore, useRouteStore, wireHostEvents } from '../src/webview/store';
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
    assert.deepEqual(result, { ok: 2, failed: [], remoteFailed: [] });
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
    assert.deepEqual(result, { ok: 1, failed: ['fix/b'], remoteFailed: [] });
  } finally {
    useOperationStore.setState({ runAction: original });
    useBranchesStore.setState({ load: originalLoad });
  }
});

test('deleteBranches with the remote flag follows each local delete with a remote one', async () => {
  const calls: string[] = [];
  const original = useOperationStore.getState().runAction;
  const originalLoad = useBranchesStore.getState().load;
  useBranchesStore.setState({
    load: async () => undefined,
    refs: [ref({ shortName: 'feat/a' }), ref({ shortName: 'origin/feat/a', kind: 'remote', refName: 'refs/remotes/origin/feat/a' })],
  });
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
 * The dialog the user pressed IS the level 1 confirmation, so the local delete
 * carries `confirm: true`. The level 2 acknowledgement is NOT carried: it belongs
 * to the guard dialog, which shows the target and the command before asking for
 * the checkbox. Pre-answering it would make frame 62 unreachable.
 */
test('deleteBranches confirms the local delete but leaves the level 2 gate to the dialog', async () => {
  const extras: Array<Record<string, unknown>> = [];
  const original = useOperationStore.getState().runAction;
  const originalLoad = useBranchesStore.getState().load;
  useBranchesStore.setState({
    load: async () => undefined,
    refs: [ref({ shortName: 'feat/a' }), ref({ shortName: 'origin/feat/a', kind: 'remote', refName: 'refs/remotes/origin/feat/a' })],
  });
  useOperationStore.setState({
    runAction: async (_request, extra) => {
      extras.push(extra ?? {});
      return true;
    },
  });
  try {
    await useBranchesStore.getState().deleteBranches(['feat/a'], 'origin');
    assert.equal(extras.length, 2);
    assert.deepEqual(extras[0], { confirm: true }, 'the local delete is already confirmed by the dialog');
    // The remote request carries NO flags: the host answers 428 and the guard
    // dialog runs stage 2, which is frame 62. Anything here would skip it.
    assert.deepEqual(extras[1], {}, 'the webview must not answer the level 2 gate');
  } finally {
    useOperationStore.setState({ runAction: original });
    useBranchesStore.setState({ load: originalLoad });
  }
});

/**
 * A branch with no tracking ref has nothing to delete on the remote. Asking would
 * turn a plain local cleanup into a conflict toast for a branch the user never
 * expected to exist there.
 */
test('deleteBranches skips the remote delete for a branch that is not on the remote', async () => {
  const actions: string[] = [];
  const original = useOperationStore.getState().runAction;
  const originalLoad = useBranchesStore.getState().load;
  useBranchesStore.setState({
    load: async () => undefined,
    refs: [ref({ shortName: 'feat/local-only' })],
  });
  useOperationStore.setState({
    runAction: async (request) => {
      actions.push(request.action);
      return true;
    },
  });
  try {
    await useBranchesStore.getState().deleteBranches(['feat/local-only'], 'origin');
    assert.deepEqual(actions, ['branch-delete'], 'no remote delete was attempted');
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

/**
 * Gate finding. Two refusals in one run used to overwrite each other's dialog and
 * leave the user with only the last message, and a run where nothing succeeded
 * reported nothing at all. The run must stop at the first parked verdict and
 * report the branches it never attempted.
 */
test('deleteBranches stops at the first parked verdict and reports the rest', async () => {
  const attempted: string[] = [];
  const original = useOperationStore.getState().runAction;
  const originalLoad = useBranchesStore.getState().load;
  useBranchesStore.setState({ load: async () => undefined });
  useOperationStore.setState({
    pendingGuard: null,
    runAction: async (request) => {
      if (!('branch' in request) || request.branch === undefined) return true;
      attempted.push(request.branch);
      // The first refusal parks a verdict; the user has not answered it yet.
      useOperationStore.setState({ pendingGuard: { request, error: {} as never, retry: async () => undefined } });
      return false;
    },
  });
  try {
    const result = await useBranchesStore.getState().deleteBranches(['feat/a', 'fix/b', 'spike/c'], null);
    // The count is the assertion that bites: continuing would attempt all three
    // and overwrite the first verdict with the third.
    assert.deepEqual(attempted, ['feat/a'], 'the run stopped at the first refusal');
    assert.deepEqual(result.failed, ['feat/a', 'fix/b', 'spike/c'], 'and every branch not removed is reported');
    assert.equal(result.ok, 0);
  } finally {
    useOperationStore.setState({ runAction: original, pendingGuard: null });
    useBranchesStore.setState({ load: originalLoad });
  }
});

/**
 * A remote delete that failed without a verdict (a protected branch, a hook) used
 * to be counted as removed, so the run printed "Deleted N" beside the error.
 */
test('deleteBranches separates a failed remote delete from a local one', async () => {
  const original = useOperationStore.getState().runAction;
  const originalLoad = useBranchesStore.getState().load;
  useBranchesStore.setState({
    load: async () => undefined,
    refs: [ref({ shortName: 'feat/a' }), ref({ shortName: 'origin/feat/a', kind: 'remote', refName: 'refs/remotes/origin/feat/a' })],
  });
  useOperationStore.setState({
    pendingGuard: null,
    runAction: async (request) => request.action !== 'branch-delete-remote',
  });
  try {
    const result = await useBranchesStore.getState().deleteBranches(['feat/a'], 'origin');
    assert.equal(result.ok, 1, 'the local branch really is gone');
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.remoteFailed, ['feat/a'], 'and the remote copy is still there');
  } finally {
    useOperationStore.setState({ runAction: original, pendingGuard: null });
    useBranchesStore.setState({ load: originalLoad });
  }
});

/**
 * Two remotes: the ticked one wins, but a branch that lives only on the other is
 * still cleaned up rather than silently left behind.
 */
test('remoteForBranch prefers the chosen remote and falls back to whichever has the branch', () => {
  const refs = [
    ref({ shortName: 'origin/feat/a', kind: 'remote', refName: 'refs/remotes/origin/feat/a' }),
    ref({ shortName: 'upstream/feat/b', kind: 'remote', refName: 'refs/remotes/upstream/feat/b' }),
  ];
  assert.equal(remoteForBranch(refs, 'origin', 'feat/a'), 'origin');
  assert.equal(remoteForBranch(refs, 'origin', 'feat/b'), 'upstream', 'the branch lives elsewhere');
  assert.equal(remoteForBranch(refs, null, 'feat/b'), 'upstream');
  assert.equal(remoteForBranch(refs, 'origin', 'feat/none'), null, 'nothing to delete anywhere');
});
