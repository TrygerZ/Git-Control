/**
 * Issues store slice (P08).
 *
 * Each chip filter loads on demand and stamps its own load time (D-P08-1),
 * while the nav badge reflects the Assigned count without an extra request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridge, loadState, saveState } from '../src/webview/bridge';
import { useGitHubStore, useIssuesStore, useNavStore } from '../src/webview/store';
import type { GitHubLinkage, IssueInfo } from '../src/messages';

const LINKED: GitHubLinkage = {
  available: true,
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  webUrl: 'https://github.com/o/r',
  commitUrlTemplate: 'https://github.com/o/r/commit/{hash}',
  apiUrl: 'https://api.github.com',
};

function issue(number: number, state: IssueInfo['state'] = 'open'): IssueInfo {
  return {
    number,
    title: `Issue ${number}`,
    state,
    stateReason: null,
    url: `https://github.com/o/r/issues/${number}`,
    author: 'someone',
    assignees: [],
    labels: [],
    comments: 0,
    bodyExcerpt: '',
    updatedAt: '2026-11-01T00:00:00Z',
    closedAt: null,
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

function resetAll(): void {
  useGitHubStore.setState({
    auth: { connected: true, login: 'me', scopes: ['repo'] },
    linkage: LINKED,
    pullRequests: [],
    rateLimit: null,
    loading: false,
    error: null,
  });
  useIssuesStore.getState().reset();
}

test('load fetches issues for the requested filter, stamps loadedAt, and updates nav count', async () => {
  resetAll();
  const before = Date.now();
  const s = stub((kind, payload) => {
    if (kind === 'github/issues') {
      const p = payload as { filter?: string };
      assert.equal(p.filter, 'assigned');
      return { issues: [issue(1), issue(2)], rateLimit: RATE };
    }
    return { connected: true, login: 'me', scopes: [] };
  });
  try {
    await useIssuesStore.getState().load('assigned');
  } finally {
    s.restore();
  }
  const after = Date.now();
  const loadedAt = useIssuesStore.getState().loadedAt.assigned;
  assert.ok(loadedAt !== null && loadedAt >= before && loadedAt <= after, 'a real timestamp');
  assert.deepEqual(
    useIssuesStore.getState().issues.map((i) => i.number),
    [1, 2],
  );
  assert.equal(useNavStore.getState().counts.issues, 2, 'nav count is updated from Assigned');
});

test('load is cached within TTL per filter and switching filters requests on demand', async () => {
  resetAll();
  const s = stub((kind, payload) => {
    const p = payload as { filter?: string };
    if (p.filter === 'created') return { issues: [issue(10)], rateLimit: RATE };
    return { issues: [issue(1)], rateLimit: RATE };
  });
  try {
    await useIssuesStore.getState().load('assigned');
    assert.equal(s.calls.length, 1);

    // Second call for assigned does not hit network
    await useIssuesStore.getState().load('assigned');
    assert.equal(s.calls.length, 1, 'cached within TTL');

    // Switch to created: issues a separate request
    await useIssuesStore.getState().load('created');
    assert.equal(s.calls.length, 2);
    assert.deepEqual(
      useIssuesStore.getState().issues.map((i) => i.number),
      [10],
    );
  } finally {
    s.restore();
  }
});

test('a failed load preserves previous issues and records error', async () => {
  resetAll();
  useIssuesStore.setState({
    issues: [issue(99)],
    loadedAt: { assigned: 1234, created: null, mentioned: null },
  });
  const s = stub(() => {
    throw new Error('network down');
  });
  try {
    await useIssuesStore.getState().load('assigned', true);
  } finally {
    s.restore();
  }
  assert.deepEqual(
    useIssuesStore.getState().issues.map((i) => i.number),
    [99],
    'stale issues beat an empty list',
  );
  assert.equal(useIssuesStore.getState().loadedAt.assigned, 1234, 'failed read does not stamp load time');
  assert.ok(useIssuesStore.getState().error !== null);
});

test('loadClosed fetches closed issues once and caches', async () => {
  resetAll();
  const s = stub((kind, payload) => {
    const p = payload as { state?: string };
    assert.equal(p.state, 'closed');
    return { issues: [issue(42, 'closed')], rateLimit: RATE };
  });
  try {
    await useIssuesStore.getState().loadClosed();
    assert.equal(useIssuesStore.getState().closedLoaded, true);
    assert.deepEqual(
      useIssuesStore.getState().closed.map((i) => i.number),
      [42],
    );

    const count = s.calls.length;
    await useIssuesStore.getState().loadClosed();
    assert.equal(s.calls.length, count, 'second expand sends nothing');
  } finally {
    s.restore();
  }
});

test('disconnect clears issues and nav badge', async () => {
  resetAll();
  useIssuesStore.setState({
    issues: [issue(5)],
    loadedAt: { assigned: 9999, created: null, mentioned: null },
  });
  useNavStore.getState().setCount('issues', 1);

  const s = stub(() => ({ connected: false, login: null, scopes: [] }));
  try {
    await useGitHubStore.getState().disconnect();
  } finally {
    s.restore();
  }
  assert.deepEqual(useIssuesStore.getState().issues, []);
  assert.equal(useIssuesStore.getState().loadedAt.assigned, null);
  assert.equal(useNavStore.getState().counts.issues, null);
});

test('loadState restores persisted issue filter, query, and label', () => {
  saveState({ issueFilter: 'mentioned', issueQuery: 'bug', issueLabel: 'auth' });
  const restored = loadState();
  assert.equal(restored.issueFilter, 'mentioned');
  assert.equal(restored.issueQuery, 'bug');
  assert.equal(restored.issueLabel, 'auth');
});
