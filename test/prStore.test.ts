/**
 * Pull request store slice (P07).
 *
 * The list, the chips, and the nav badge all read one array, so the store has to
 * say when that array was loaded and must not refetch the closed list on every
 * expand. These cases pin both, plus the reset on disconnect.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridge } from '../src/webview/bridge';
import { useGitHubStore } from '../src/webview/store';
import type { GitHubLinkage, PullRequestInfo } from '../src/messages';

const LINKED: GitHubLinkage = {
  available: true,
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  webUrl: 'https://github.com/o/r',
  commitUrlTemplate: 'https://github.com/o/r/commit/{hash}',
  apiUrl: 'https://api.github.com',
};

function pr(number: number, state: PullRequestInfo['state'] = 'open'): PullRequestInfo {
  return {
    number,
    title: `PR ${number}`,
    state,
    url: `https://github.com/o/r/pull/${number}`,
    headRef: 'feat/a',
    baseRef: 'main',
    draft: false,
    author: 'someone',
    updatedAt: '2026-11-01T00:00:00Z',
    requestedReviewers: [],
  };
}

const RATE = { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false };

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

function resetStore(): void {
  useGitHubStore.setState({
    auth: { connected: true, login: 'me', scopes: ['repo'] },
    linkage: LINKED,
    pullRequests: [],
    rateLimit: null,
    loading: false,
    error: null,
    pullRequestsLoadedAt: null,
    closedPullRequests: [],
    closedLoaded: false,
  });
}

test('loadPullRequests stamps the load time the gate compares against', async () => {
  resetStore();
  const before = Date.now();
  const s = stub((kind) =>
    kind === 'github/pullRequests'
      ? { pullRequests: [pr(1)], rateLimit: RATE }
      : { connected: true, login: 'me', scopes: [] },
  );
  try {
    await useGitHubStore.getState().loadPullRequests();
  } finally {
    s.restore();
  }
  const after = Date.now();
  const loadedAt = useGitHubStore.getState().pullRequestsLoadedAt;
  assert.ok(loadedAt !== null && loadedAt >= before && loadedAt <= after, 'a real timestamp');
  assert.deepEqual(
    useGitHubStore.getState().pullRequests.map((p) => p.number),
    [1],
  );
});

test('a failed load keeps the previous list and does not claim a fresh load', async () => {
  resetStore();
  useGitHubStore.setState({ pullRequests: [pr(9)], pullRequestsLoadedAt: 1234 });
  const s = stub(() => {
    throw new Error('boom');
  });
  try {
    await useGitHubStore.getState().loadPullRequests();
  } finally {
    s.restore();
  }
  assert.deepEqual(
    useGitHubStore.getState().pullRequests.map((p) => p.number),
    [9],
    'stale rows beat an empty list',
  );
  assert.equal(useGitHubStore.getState().pullRequestsLoadedAt, 1234, 'the failed read is not a load');
  assert.ok(useGitHubStore.getState().error !== null);
});

test('loadClosedPullRequests asks once and remembers it did', async () => {
  resetStore();
  const s = stub((kind, payload) => {
    if (kind !== 'github/pullRequests') return { connected: true, login: 'me', scopes: [] };
    assert.equal((payload as { state?: string }).state, 'closed');
    return { pullRequests: [pr(4, 'closed')], rateLimit: RATE };
  });
  try {
    await useGitHubStore.getState().loadClosedPullRequests();
    assert.equal(useGitHubStore.getState().closedLoaded, true);
    assert.deepEqual(
      useGitHubStore.getState().closedPullRequests.map((p) => p.number),
      [4],
    );

    const sent = s.calls.length;
    await useGitHubStore.getState().loadClosedPullRequests();
    assert.equal(s.calls.length, sent, 'a second expand sends nothing');
  } finally {
    s.restore();
  }
});

test('disconnect forgets the closed list and the load stamp', async () => {
  resetStore();
  useGitHubStore.setState({
    pullRequests: [pr(1)],
    closedPullRequests: [pr(4, 'closed')],
    closedLoaded: true,
    pullRequestsLoadedAt: 999,
  });
  const s = stub((kind) =>
    kind === 'github/disconnect'
      ? { connected: false, login: null, scopes: [] }
      : { connected: false, login: null, scopes: [] },
  );
  try {
    await useGitHubStore.getState().disconnect();
  } finally {
    s.restore();
  }
  const state = useGitHubStore.getState();
  assert.deepEqual(state.closedPullRequests, []);
  assert.equal(state.closedLoaded, false);
  assert.equal(state.pullRequestsLoadedAt, null);
});

test('loadPullRequests without a GitHub remote sends nothing', async () => {
  resetStore();
  useGitHubStore.setState({ linkage: { ...LINKED, available: false, owner: null, repo: null } });
  const s = stub(() => ({}));
  try {
    await useGitHubStore.getState().loadPullRequests();
  } finally {
    s.restore();
  }
  assert.deepEqual(s.calls, []);
});
