/**
 * Issues store slice (P08).
 *
 * The chip and the state menu are the only selection, and both live in the store
 * so a background reply for a selection the user has left can never repaint the
 * list under the wrong heading. Each `(filter, state)` pair caches independently.
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

test('load fetches the requested filter and state, stamps loadedAt, and updates the nav count', async () => {
  resetAll();
  const before = Date.now();
  const s = stub((kind, payload) => {
    if (kind === 'github/issues') {
      const p = payload as { filter?: string; state?: string };
      assert.equal(p.filter, 'assigned');
      assert.equal(p.state, 'open');
      return { issues: [issue(1), issue(2)], rateLimit: RATE };
    }
    return { connected: true, login: 'me', scopes: [] };
  });
  try {
    await useIssuesStore.getState().load('assigned', 'open');
  } finally {
    s.restore();
  }
  const after = Date.now();
  const loadedAt = useIssuesStore.getState().loadedAt.assigned.open;
  assert.ok(loadedAt !== null && loadedAt >= before && loadedAt <= after, 'a real timestamp');
  assert.deepEqual(
    useIssuesStore.getState().issues.map((i) => i.number),
    [1, 2],
  );
  assert.equal(useNavStore.getState().counts.issues, 2, 'nav count comes from Assigned open');
});

test('the cache is keyed by filter and state, and switching either requests on demand', async () => {
  resetAll();
  const s = stub((kind, payload) => {
    const p = payload as { filter?: string; state?: string };
    if (p.filter === 'created') return { issues: [issue(10)], rateLimit: RATE };
    if (p.state === 'closed') return { issues: [issue(7, 'closed')], rateLimit: RATE };
    return { issues: [issue(1)], rateLimit: RATE };
  });
  try {
    await useIssuesStore.getState().load('assigned', 'open');
    assert.equal(s.calls.length, 1);

    await useIssuesStore.getState().load('assigned', 'open');
    assert.equal(s.calls.length, 1, 'cached within TTL');

    await useIssuesStore.getState().load('created', 'open');
    assert.equal(s.calls.length, 2, 'a different chip is a different cache entry');

    await useIssuesStore.getState().load('assigned', 'closed');
    assert.equal(s.calls.length, 3, 'a different state is a different cache entry');
    assert.equal(useIssuesStore.getState().issuesByFilter.assigned.closed[0]?.number, 7);
    assert.equal(
      useIssuesStore.getState().issuesByFilter.assigned.open[0]?.number,
      1,
      'the open rows survive',
    );
  } finally {
    s.restore();
  }
});

test('a reply for a selection the user has left fills the cache but never the rendered list', async () => {
  resetAll();
  let resolveAssigned: ((value: unknown) => void) | undefined;
  const assignedReply = new Promise<unknown>((resolve) => {
    resolveAssigned = resolve;
  });
  const s = stub((kind, payload) => {
    const p = payload as { filter?: string };
    if (p.filter === 'assigned') return assignedReply;
    return { issues: [issue(50)], rateLimit: RATE };
  });
  try {
    // The shell prefetches Assigned for the badge; the user is on Mentioned.
    const slow = useIssuesStore.getState().load('assigned', 'open');
    useIssuesStore.getState().select('mentioned', 'open');
    await useIssuesStore.getState().load('mentioned', 'open');

    resolveAssigned?.({ issues: [issue(99)], rateLimit: RATE });
    await slow;

    assert.equal(useIssuesStore.getState().filter, 'mentioned', 'the chip the user chose stays selected');
    assert.deepEqual(
      useIssuesStore.getState().issues.map((i) => i.number),
      [50],
      'the late Assigned reply does not repaint the Mentioned list',
    );
    assert.equal(
      useIssuesStore.getState().issuesByFilter.assigned.open[0]?.number,
      99,
      'the reply is still cached for the badge and a later switch',
    );
  } finally {
    s.restore();
  }
});

test('select switches to cached rows without a request', async () => {
  resetAll();
  const s = stub((kind, payload) => {
    const p = payload as { filter?: string };
    if (p.filter === 'created') return { issues: [issue(10)], rateLimit: RATE };
    return { issues: [issue(1)], rateLimit: RATE };
  });
  try {
    await useIssuesStore.getState().load('assigned', 'open');
    await useIssuesStore.getState().load('created', 'open');
    const sent = s.calls.length;

    useIssuesStore.getState().select('assigned', 'open');
    assert.equal(s.calls.length, sent, 'a cached switch sends nothing');
    assert.deepEqual(useIssuesStore.getState().issues.map((i) => i.number), [1]);

    useIssuesStore.getState().select('mentioned', 'open');
    assert.deepEqual(useIssuesStore.getState().issues, [], 'an unloaded selection starts empty');
  } finally {
    s.restore();
  }
});

test('a failed load preserves previous issues and records error', async () => {
  resetAll();
  useIssuesStore.setState({
    issues: [issue(99)],
    loadedAt: {
      assigned: { open: 1234, closed: null },
      created: { open: null, closed: null },
      mentioned: { open: null, closed: null },
    },
  });
  const s = stub(() => {
    throw new Error('network down');
  });
  try {
    await useIssuesStore.getState().load('assigned', 'open', true);
  } finally {
    s.restore();
  }
  assert.deepEqual(
    useIssuesStore.getState().issues.map((i) => i.number),
    [99],
    'stale issues beat an empty list',
  );
  assert.equal(
    useIssuesStore.getState().loadedAt.assigned.open,
    1234,
    'failed read does not stamp load time',
  );
  assert.ok(useIssuesStore.getState().error !== null);
});

test('the closed state is its own cache entry, so the Recently closed group costs one request', async () => {
  resetAll();
  const s = stub((kind, payload) => {
    const p = payload as { filter?: string; state?: string };
    assert.equal(p.state, 'closed');
    return { issues: [issue(p.filter === 'created' ? 43 : 42, 'closed')], rateLimit: RATE };
  });
  try {
    await useIssuesStore.getState().load('assigned', 'closed');
    assert.equal(useIssuesStore.getState().issuesByFilter.assigned.closed[0]?.number, 42);

    const count = s.calls.length;
    await useIssuesStore.getState().load('assigned', 'closed');
    assert.equal(s.calls.length, count, 'a second expand sends nothing');

    await useIssuesStore.getState().load('created', 'closed');
    assert.equal(
      useIssuesStore.getState().issuesByFilter.created.closed[0]?.number,
      43,
      'each chip has its own closed rows',
    );
  } finally {
    s.restore();
  }
});

test('disconnect clears the cache and the nav badge', async () => {
  resetAll();
  useIssuesStore.setState({
    issues: [issue(5)],
    loadedAt: {
      assigned: { open: 9999, closed: null },
      created: { open: null, closed: null },
      mentioned: { open: null, closed: null },
    },
  });
  useNavStore.getState().setCount('issues', 1);

  const s = stub(() => ({ connected: false, login: null, scopes: [] }));
  try {
    await useGitHubStore.getState().disconnect();
  } finally {
    s.restore();
  }
  assert.deepEqual(useIssuesStore.getState().issues, []);
  assert.equal(useIssuesStore.getState().loadedAt.assigned.open, null);
  assert.deepEqual(useIssuesStore.getState().issuesByFilter.assigned.closed, []);
  assert.equal(useNavStore.getState().counts.issues, null);
});

test('load does not fetch when signed out', async () => {
  resetAll();
  useGitHubStore.setState({ auth: { connected: false, login: null, scopes: [] } });
  const s = stub(() => ({ issues: [issue(1)], rateLimit: RATE }));
  try {
    await useIssuesStore.getState().load('assigned', 'open');
    assert.equal(s.calls.length, 0, 'no request sent when signed out');
    await useIssuesStore.getState().load('assigned', 'closed');
    assert.equal(s.calls.length, 0, 'no closed request sent when signed out');
  } finally {
    s.restore();
  }
});

test('loadState restores persisted issue filter, query, and label', () => {
  saveState({ issueFilter: 'mentioned', issueQuery: 'bug', issueLabel: 'auth' });
  const restored = loadState();
  assert.equal(restored.issueFilter, 'mentioned');
  assert.equal(restored.issueQuery, 'bug');
  assert.equal(restored.issueLabel, 'auth');
});
