/**
 * Actions store slice (P13).
 *
 * Pins the things a component cannot: the branch and workflow choice survives a
 * reload through `saveState`, jobs are fetched once per run, the nav dot follows
 * the newest completed run on the current branch, and the bounded dot request
 * never fires while signed out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridge, loadState, saveState } from '../src/webview/bridge';
import { useActionsStore, useGitHubStore, useNavStore, useRepoStore } from '../src/webview/store';
import type { GitHubLinkage, RepoStatus, WorkflowInfo, WorkflowRunInfo } from '../src/messages';

const LINKED: GitHubLinkage = {
  available: true,
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  webUrl: 'https://github.com/o/r',
  commitUrlTemplate: 'https://github.com/o/r/commit/{hash}',
  apiUrl: 'https://api.github.com',
};

const RATE = { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false };

function run(patch: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo {
  return {
    id: 1,
    workflowId: 12,
    name: 'CI',
    title: 'fix(graph): cull nodes',
    runNumber: 482,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    branch: 'main',
    sha: '9f8e7d6'.padEnd(40, '0'),
    url: 'https://github.com/o/r/actions/runs/1',
    createdAt: '2026-11-01T10:00:00Z',
    startedAt: '2026-11-01T10:00:05Z',
    updatedAt: '2026-11-01T10:03:57Z',
    attempt: 1,
    ...patch,
  };
}

const WORKFLOWS: WorkflowInfo[] = [
  { id: 12, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
];

interface Call {
  kind: string;
  payload: unknown;
}

function stub(reply: (kind: string, payload: unknown) => unknown): { calls: Call[]; restore(): void } {
  const calls: Call[] = [];
  const original = bridge.request;
  bridge.request = (async (kind: string, payload: unknown): Promise<unknown> => {
    calls.push({ kind, payload });
    return reply(kind, payload);
  }) as typeof bridge.request;
  return {
    calls,
    restore() {
      bridge.request = original;
    },
  };
}

/** Only the fields the dot reads; the store treats the status as opaque otherwise. */
const BASE_STATUS = { branch: 'main' } as unknown as RepoStatus;

function resetAll(): void {
  // The dot is computed against the repository's branch, not the list filter.
  useRepoStore.setState({ status: BASE_STATUS });
  useGitHubStore.setState({
    auth: { connected: true, login: 'me', scopes: ['repo'] },
    linkage: LINKED,
    rateLimit: null,
    loading: false,
    error: null,
  });
  useActionsStore.getState().reset();
  // `reset()` deliberately keeps the persisted filter, so clear it explicitly:
  // otherwise one case's selection leaks into the next.
  useActionsStore.setState({ branch: null, workflowId: null });
  useNavStore.setState({ failing: false });
}

test('load fetches runs and the workflow list', async () => {
  resetAll();
  const s = stub((kind) =>
    kind === 'github/actionsRuns'
      ? { runs: [run()], workflows: WORKFLOWS, rateLimit: RATE }
      : { connected: true, login: 'me', scopes: [] },
  );
  try {
    await useActionsStore.getState().load({ branch: 'main' });
  } finally {
    s.restore();
  }
  const state = useActionsStore.getState();
  assert.deepEqual(state.runs.map((r) => r.id), [1]);
  assert.deepEqual(state.workflows, WORKFLOWS);
  assert.equal(s.calls.filter((c) => c.kind === 'github/actionsRuns').length, 1);
});

test('load sends the selected branch and workflow together', async () => {
  resetAll();
  const s = stub(() => ({ runs: [], workflows: [], rateLimit: RATE }));
  try {
    await useActionsStore.getState().load({ branch: 'feat/a', workflowId: 12 });
  } finally {
    s.restore();
  }
  const call = s.calls.find((c) => c.kind === 'github/actionsRuns');
  assert.deepEqual(call?.payload, {
    owner: 'o',
    repo: 'r',
    branch: 'feat/a',
    workflowId: 12,
    perPage: 30,
  });
});

test('load without filters asks for every run', async () => {
  resetAll();
  const s = stub(() => ({ runs: [], workflows: WORKFLOWS, rateLimit: RATE }));
  try {
    await useActionsStore.getState().load({});
  } finally {
    s.restore();
  }
  const call = s.calls.find((c) => c.kind === 'github/actionsRuns');
  assert.deepEqual(call?.payload, { owner: 'o', repo: 'r', perPage: 30 });
});

test('a signed-out store sends no request at all', async () => {
  resetAll();
  useGitHubStore.setState({ auth: { connected: false, login: null, scopes: [] } });
  const s = stub(() => {
    throw new Error('must not be called');
  });
  try {
    await useActionsStore.getState().load({ branch: 'main' });
  } finally {
    s.restore();
  }
  assert.equal(s.calls.length, 0);
});

test('a failed read keeps the previous rows and records the error', async () => {
  resetAll();
  useActionsStore.setState({ runs: [run()] });
  const s = stub(() => {
    throw new Error('boom');
  });
  try {
    await useActionsStore.getState().load({ branch: 'main' });
  } finally {
    s.restore();
  }
  assert.deepEqual(useActionsStore.getState().runs.map((r) => r.id), [1], 'stale rows survive');
  assert.ok(useActionsStore.getState().error !== null);
});

test('the branch and workflow choice is persisted through saveState', () => {
  resetAll();
  useActionsStore.getState().selectBranch('feat/a');
  useActionsStore.getState().selectWorkflow(12);
  const persisted = loadState();
  assert.equal(persisted.actionsBranch, 'feat/a');
  assert.equal(persisted.actionsWorkflow, 12);
  assert.equal(useActionsStore.getState().branch, 'feat/a');
  assert.equal(useActionsStore.getState().workflowId, 12);
  saveState({ actionsBranch: null, actionsWorkflow: null });
  useActionsStore.getState().reset();
});

test('loadJobs caches by run id and does not refetch a loaded run', async () => {
  resetAll();
  const s = stub((kind, payload) => {
    if (kind !== 'github/actionsJobs') return { runs: [], workflows: [], rateLimit: RATE };
    const p = payload as { runId: number };
    return {
      jobs: [
        {
          id: p.runId * 10,
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          startedAt: null,
          completedAt: null,
          url: '',
          steps: [],
        },
      ],
      rateLimit: RATE,
    };
  });
  try {
    await useActionsStore.getState().loadJobs(482);
    await useActionsStore.getState().loadJobs(482);
  } finally {
    s.restore();
  }
  assert.equal(
    s.calls.filter((c) => c.kind === 'github/actionsJobs').length,
    1,
    'second expand is cached',
  );
  assert.equal(useActionsStore.getState().jobsByRun[482]?.[0]?.id, 4820);
});

test('toggling a run expands and collapses it', () => {
  resetAll();
  useActionsStore.getState().toggleRun(482);
  assert.equal(useActionsStore.getState().expanded.has(482), true);
  useActionsStore.getState().toggleRun(482);
  assert.equal(useActionsStore.getState().expanded.has(482), false);
});

test('the failing dot follows the newest completed run on the current branch', async () => {
  resetAll();
  const fail = stub(() => ({
    runs: [run({ status: 'completed', conclusion: 'failure' })],
    workflows: [],
    rateLimit: RATE,
  }));
  try {
    await useActionsStore.getState().load({});
  } finally {
    fail.restore();
  }
  assert.equal(useNavStore.getState().failing, true);

  const pass = stub(() => ({
    runs: [run({ status: 'completed', conclusion: 'success' })],
    workflows: [],
    rateLimit: RATE,
  }));
  try {
    // `force` because the first read is still inside the 60 s cache window and a
    // cached hit correctly returns the old verdict without a request.
    await useActionsStore.getState().load({ force: true });
  } finally {
    pass.restore();
  }
  assert.equal(useNavStore.getState().failing, false);
});

test('a filter on another branch leaves an existing failing dot intact', async () => {
  resetAll();
  useNavStore.setState({ failing: true });
  const pass = stub(() => ({
    runs: [run({ branch: 'feat/a', status: 'completed', conclusion: 'success' })],
    workflows: [],
    rateLimit: RATE,
  }));
  try {
    await useActionsStore.getState().load({ branch: 'feat/a' });
  } finally {
    pass.restore();
  }
  assert.equal(useNavStore.getState().failing, true);
});

test('the dot request is bounded and only sent when signed in', async () => {
  resetAll();
  const s = stub(() => ({ runs: [run()], workflows: [], rateLimit: RATE }));
  try {
    await useActionsStore.getState().refreshDot('main');
  } finally {
    s.restore();
  }
  const call = s.calls.find((c) => c.kind === 'github/actionsRuns');
  assert.deepEqual(call?.payload, { owner: 'o', repo: 'r', branch: 'main', perPage: 5 });

  useGitHubStore.setState({ auth: { connected: false, login: null, scopes: [] } });
  const off = stub(() => {
    throw new Error('must not be called');
  });
  try {
    await useActionsStore.getState().refreshDot('main');
  } finally {
    off.restore();
  }
  assert.equal(off.calls.length, 0);
});

test('reset drops runs, jobs, and the dot', () => {
  resetAll();
  useActionsStore.setState({ runs: [run()], expanded: new Set([1]) });
  useNavStore.setState({ failing: true });
  useActionsStore.getState().reset();
  assert.deepEqual(useActionsStore.getState().runs, []);
  assert.equal(useActionsStore.getState().expanded.size, 0);
  assert.equal(useNavStore.getState().failing, false);
});

test('a repository switch clears the actions slice through linkage change', async () => {
  resetAll();
  useActionsStore.setState({ runs: [run()] });
  const s = stub((kind) => {
    if (kind === 'github/auth') return { connected: true, login: 'me', scopes: ['repo'] };
    if (kind === 'github/linkage') return { ...LINKED, owner: 'other-owner' };
    if (kind === 'github/pullRequests') return { pullRequests: [], rateLimit: RATE };
    if (kind === 'github/issues') return { issues: [], rateLimit: RATE };
    return {};
  });
  try {
    await useGitHubStore.getState().load();
  } finally {
    s.restore();
  }
  assert.deepEqual(useActionsStore.getState().runs, []);
});

test('refreshLinkage re-reads auth and linkage and clears a changed repository only', async () => {
  resetAll();
  useActionsStore.setState({ runs: [run()] });
  useGitHubStore.setState({ linkage: { ...LINKED, owner: 'old', repo: 'r' } });
  const s = stub((kind) => {
    if (kind === 'github/auth') return { connected: true, login: 'me', scopes: [] };
    if (kind === 'github/linkage') return { ...LINKED, owner: 'new' };
    return { pullRequests: [], issues: [], rateLimit: RATE };
  });
  try {
    await useGitHubStore.getState().refreshLinkage();
  } finally {
    s.restore();
  }
  assert.deepEqual(useActionsStore.getState().runs, [], 'the old repository rows are gone');
  assert.deepEqual(
    s.calls.map((c) => c.kind),
    ['github/auth', 'github/linkage'],
    'the watcher path must not fetch any list: every save burst would cost a request',
  );
});

test('refreshLinkage keeps the rows when the repository did not change', async () => {
  resetAll();
  useActionsStore.setState({ runs: [run()] });
  const s = stub((kind) => {
    if (kind === 'github/auth') return { connected: true, login: 'me', scopes: [] };
    if (kind === 'github/linkage') return LINKED;
    return { pullRequests: [], issues: [], rateLimit: RATE };
  });
  try {
    await useGitHubStore.getState().refreshLinkage();
  } finally {
    s.restore();
  }
  assert.deepEqual(useActionsStore.getState().runs.map((r) => r.id), [1]);
});

test('a dot probe that answers after a repository switch does not repaint the dot', async () => {
  resetAll();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = bridge.request;
  bridge.request = (async (kind: string) => {
    if (kind === 'github/actionsRuns') {
      await gate;
      return { runs: [run({ conclusion: 'failure' })], workflows: [], rateLimit: RATE };
    }
    return { connected: true, login: 'me', scopes: [] };
  }) as typeof bridge.request;
  try {
    const probe = useActionsStore.getState().refreshDot('main');
    // The repository switches while the probe is still in flight.
    useActionsStore.getState().reset();
    useNavStore.setState({ failing: false });
    release?.();
    await probe;
  } finally {
    bridge.request = original;
  }
  assert.equal(useNavStore.getState().failing, false, 'the stale reply is dropped');
});

test('a list reply from the previous repository is discarded after a switch', async () => {
  resetAll();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const original = bridge.request;
  bridge.request = (async (kind: string) => {
    if (kind !== 'github/actionsRuns') return { connected: true, login: 'me', scopes: [] };
    if (first) {
      first = false;
      await gate;
      return { runs: [run({ id: 111 })], workflows: [], rateLimit: RATE };
    }
    return { runs: [run({ id: 222 })], workflows: [], rateLimit: RATE };
  }) as typeof bridge.request;
  try {
    const stale = useActionsStore.getState().load({});
    // The repository switches while the old read is still in flight.
    useActionsStore.getState().reset();
    release?.();
    await stale;
    await useActionsStore.getState().load({ force: true });
  } finally {
    bridge.request = original;
  }
  assert.deepEqual(
    useActionsStore.getState().runs.map((r) => r.id),
    [222],
    'the old repository reply must not repaint the new one',
  );
});

test('a stale list reply does not seed the cache or move the dot', async () => {
  resetAll();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = bridge.request;
  bridge.request = (async () => {
    await gate;
    return { runs: [run({ conclusion: 'failure' })], workflows: [], rateLimit: RATE };
  }) as typeof bridge.request;
  try {
    const stale = useActionsStore.getState().load({});
    useActionsStore.getState().reset();
    release?.();
    await stale;
  } finally {
    bridge.request = original;
  }
  assert.deepEqual(useActionsStore.getState().loadedAt, {}, 'no cache entry from the old repo');
  assert.equal(useNavStore.getState().failing, false, 'no dot from the old repo');
});
// ------------------------------------------------------------- job log (P14)

function logEntry(patch: Partial<{ state: string; lines: unknown[]; headCut: boolean }> = {}): unknown {
  return {
    state: 'ok',
    lines: [{ text: 'line', tone: 'normal' }],
    headCut: false,
    rateLimit: RATE,
    ...patch,
  };
}

test('loadLog requests a job once and stores the tail', async () => {
  resetAll();
  const s = stub((kind) => (kind === 'github/actionsLog' ? logEntry() : {}));
  try {
    await useActionsStore.getState().loadLog(77);
    await useActionsStore.getState().loadLog(77);
  } finally {
    s.restore();
  }
  const calls = s.calls.filter((c) => c.kind === 'github/actionsLog');
  assert.equal(calls.length, 1, 'second call is answered from the store');
  assert.deepEqual(calls[0]?.payload, { owner: 'o', repo: 'r', jobId: 77 });
  const entry = useActionsStore.getState().logs[77];
  assert.equal(entry?.state, 'ok');
  assert.deepEqual(entry?.lines, [{ text: 'line', tone: 'normal' }]);
});

test('loadLog records a failed read and allows a retry', async () => {
  resetAll();
  let fail = true;
  const s = stub((kind) => {
    if (kind !== 'github/actionsLog') return {};
    if (fail) throw new Error('nope');
    return logEntry();
  });
  try {
    await useActionsStore.getState().loadLog(5);
    assert.equal(useActionsStore.getState().logs[5]?.state, 'error');
    fail = false;
    await useActionsStore.getState().loadLog(5);
  } finally {
    s.restore();
  }
  assert.equal(s.calls.filter((c) => c.kind === 'github/actionsLog').length, 2);
  assert.equal(useActionsStore.getState().logs[5]?.state, 'ok');
});

test('loadLog keeps the expired and tooLarge states without a retry loop', async () => {
  resetAll();
  const s = stub((kind) => (kind === 'github/actionsLog' ? logEntry({ state: 'expired', lines: [] }) : {}));
  try {
    await useActionsStore.getState().loadLog(9);
    await useActionsStore.getState().loadLog(9);
  } finally {
    s.restore();
  }
  assert.equal(s.calls.filter((c) => c.kind === 'github/actionsLog').length, 1);
  assert.equal(useActionsStore.getState().logs[9]?.state, 'expired');
});

test('loadLog is a no-op while signed out', async () => {
  resetAll();
  useGitHubStore.setState({ auth: { connected: false, login: null, scopes: [] } });
  const s = stub(() => logEntry());
  try {
    await useActionsStore.getState().loadLog(1);
  } finally {
    s.restore();
  }
  assert.equal(s.calls.filter((c) => c.kind === 'github/actionsLog').length, 0);
  assert.equal(useActionsStore.getState().logs[1], undefined);
});

test('a repository reset clears every cached log', async () => {
  resetAll();
  const s = stub((kind) => (kind === 'github/actionsLog' ? logEntry() : {}));
  try {
    await useActionsStore.getState().loadLog(3);
  } finally {
    s.restore();
  }
  assert.ok(useActionsStore.getState().logs[3] !== undefined);
  useActionsStore.getState().reset();
  assert.deepEqual(useActionsStore.getState().logs, {});
});
