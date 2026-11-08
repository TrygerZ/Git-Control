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
    await useActionsStore.getState().load({ branch: 'main' });
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
    await useActionsStore.getState().load({ branch: 'main', force: true });
  } finally {
    pass.restore();
  }
  assert.equal(useNavStore.getState().failing, false);
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
