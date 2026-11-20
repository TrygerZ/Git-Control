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
import { useGitHubStore, useIssuesStore, useNavStore, useOperationStore } from '../src/webview/store';
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
  useOperationStore.setState({ toasts: [], lastError: null, state: 'idle' });
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

// ------------------------------------------------------ write actions (P26)

test('P26: comment posts trimmed draft once, clears draft on success, and keeps draft on failure', async () => {
  resetAll();
  useIssuesStore.setState({
    issues: [issue(97)],
    issuesByFilter: {
      assigned: { open: [issue(97)], closed: [] },
      created: { open: [], closed: [] },
      mentioned: { open: [], closed: [] },
    },
  });

  // Blank draft is refused without a bridge call
  useIssuesStore.getState().setCommentDraft(97, '   ');
  const s0 = stub(() => ({ commentId: 1, htmlUrl: 'https://github.com/o/r/issues/97#issuecomment-1' }));
  try {
    const refused = await useIssuesStore.getState().comment(97);
    assert.equal(refused, false);
    assert.equal(s0.calls.length, 0);
  } finally {
    s0.restore();
  }

  // In-flight guard + happy path
  useIssuesStore.getState().setCommentDraft(97, '  Fixed in branch  ');
  let resolveComment: ((v: unknown) => void) | undefined;
  const commentPromise = new Promise<unknown>((resolve) => {
    resolveComment = resolve;
  });
  const s1 = stub((kind) => {
    if (kind === 'github/commentIssue') return commentPromise;
    return { issues: [{ ...issue(97), comments: 1 }], rateLimit: RATE };
  });
  try {
    const p1 = useIssuesStore.getState().comment(97);
    const p2 = useIssuesStore.getState().comment(97);
    assert.equal(await p2, false, 'second comment call while in flight is refused');
    resolveComment?.({ commentId: 10, htmlUrl: 'https://github.com/o/r/issues/97#issuecomment-10' });
    assert.equal(await p1, true);
    assert.equal(
      s1.calls.filter((c) => c.kind === 'github/commentIssue').length,
      1,
      'only one commentIssue request sent',
    );
    assert.equal(useIssuesStore.getState().commentDraft[97] ?? '', '', 'draft cleared on success');
    assert.equal(useOperationStore.getState().toasts.at(-1)?.message, 'Comment posted');
  } finally {
    s1.restore();
  }

  // Failure preserves draft and maps 403 to needScope / 410 to issuesDisabled
  useIssuesStore.getState().setCommentDraft(97, 'Preserved text');
  const sFail = stub(() => {
    const err = new Error('Forbidden') as Error & { body?: unknown };
    err.name = 'BridgeRequestError';
    return Promise.reject(
      Object.assign(err, {
        body: { status: 403, code: 'FORBIDDEN', message: 'The token needs the "repo" permission.' },
      }),
    );
  });
  try {
    const ok = await useIssuesStore.getState().comment(97);
    assert.equal(ok, false);
    assert.equal(useIssuesStore.getState().commentDraft[97], 'Preserved text');
    assert.match(useOperationStore.getState().toasts.at(-1)?.message ?? '', /cannot write issues/);
  } finally {
    sFail.restore();
  }
});

test('P26: close optimistically moves issue to closed, lowers badge, and Undo toast reopens it', async () => {
  resetAll();
  const openList = [issue(97), issue(98)];
  useIssuesStore.setState({
    issues: openList,
    issuesByFilter: {
      assigned: { open: openList, closed: [] },
      created: { open: [], closed: [] },
      mentioned: { open: [], closed: [] },
    },
    loadedAt: {
      assigned: { open: Date.now(), closed: null },
      created: { open: null, closed: null },
      mentioned: { open: null, closed: null },
    },
  });
  useNavStore.getState().setCount('issues', 2);

  let resolveClose: ((v: unknown) => void) | undefined;
  const closePromise = new Promise<unknown>((resolve) => {
    resolveClose = resolve;
  });
  const s = stub((kind, payload) => {
    if (kind === 'github/setIssueState') {
      const p = payload as { state: 'open' | 'closed' };
      if (p.state === 'closed') return closePromise;
      return { number: 97, state: 'open' };
    }
    return { issues: useIssuesStore.getState().issuesByFilter.assigned.open, rateLimit: RATE };
  });
  try {
    const closing = useIssuesStore.getState().close(97);
    // Optimistic state is applied immediately before the request resolves
    assert.deepEqual(
      useIssuesStore.getState().issuesByFilter.assigned.open.map((i) => i.number),
      [98],
      'issue removed from open list optimistically',
    );
    assert.deepEqual(
      useIssuesStore.getState().issuesByFilter.assigned.closed.map((i) => i.number),
      [97],
      'issue moved to Recently closed optimistically',
    );
    assert.equal(useNavStore.getState().counts.issues, 1, 'nav badge lowered from 2 to 1');

    resolveClose?.({ number: 97, state: 'closed' });
    assert.equal(await closing, true);

    const closeToast = useOperationStore.getState().toasts.at(-1);
    assert.ok(closeToast !== undefined);
    assert.equal(closeToast.message, 'Closed #97 as completed');
    assert.equal(closeToast.action?.label, 'Undo');

    // Trigger Undo from the toast action
    closeToast.action?.run();
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(
      useIssuesStore.getState().issuesByFilter.assigned.open.map((i) => i.number),
      [97, 98],
      'Undo restores issue to open list',
    );
    assert.deepEqual(
      useIssuesStore.getState().issuesByFilter.assigned.closed.map((i) => i.number),
      [],
      'Undo removes issue from Recently closed',
    );
    assert.equal(useNavStore.getState().counts.issues, 2, 'Undo restores nav badge to 2');
    assert.equal(useOperationStore.getState().toasts.at(-1)?.message, 'Reopened #97');
  } finally {
    s.restore();
  }
});

test('P26: failed close restores optimistic state and nav count and pushes error toast', async () => {
  resetAll();
  const openList = [issue(97), issue(98)];
  useIssuesStore.setState({
    issues: openList,
    issuesByFilter: {
      assigned: { open: openList, closed: [] },
      created: { open: [], closed: [] },
      mentioned: { open: [], closed: [] },
    },
    loadedAt: {
      assigned: { open: Date.now(), closed: null },
      created: { open: null, closed: null },
      mentioned: { open: null, closed: null },
    },
  });
  useNavStore.getState().setCount('issues', 2);

  const s = stub((kind) => {
    if (kind === 'github/setIssueState') {
      return Promise.reject(new Error('GitHub refused state change'));
    }
    return { issues: openList, rateLimit: RATE };
  });
  try {
    const ok = await useIssuesStore.getState().close(97);
    assert.equal(ok, false);
    assert.deepEqual(
      useIssuesStore.getState().issuesByFilter.assigned.open.map((i) => i.number),
      [97, 98],
      'open list restored after failure',
    );
    assert.deepEqual(useIssuesStore.getState().issuesByFilter.assigned.closed, []);
    assert.equal(useNavStore.getState().counts.issues, 2, 'nav badge restored after failure');
    assert.equal(useOperationStore.getState().toasts.at(-1)?.level, 'error');
  } finally {
    s.restore();
  }
});

test('P26: loadLabels caches labels and create posts new issue and shows it at the top of Created', async () => {
  resetAll();
  useIssuesStore.setState({
    issues: [issue(10)],
    issuesByFilter: {
      assigned: { open: [], closed: [] },
      created: { open: [issue(10)], closed: [] },
      mentioned: { open: [], closed: [] },
    },
  });

  const s = stub((kind) => {
    if (kind === 'github/repoLabels') {
      return {
        labels: [
          { name: 'bug', colorKey: 'red' },
          { name: 'ui', colorKey: 'blue' },
        ],
        rateLimit: RATE,
      };
    }
    if (kind === 'github/createIssue') {
      return { number: 105, htmlUrl: 'https://github.com/o/r/issues/105' };
    }
    return { issues: [issue(10)], rateLimit: RATE };
  });
  try {
    await useIssuesStore.getState().loadLabels();
    assert.equal(useIssuesStore.getState().labels.length, 2);
    await useIssuesStore.getState().loadLabels();
    assert.equal(
      s.calls.filter((c) => c.kind === 'github/repoLabels').length,
      1,
      'labels cached within 300 s TTL',
    );

    const created = await useIssuesStore.getState().create({
      title: 'New sidebar bug',
      body: 'Steps to reproduce',
      labels: ['bug'],
    });
    assert.deepEqual(created, { number: 105, htmlUrl: 'https://github.com/o/r/issues/105' });
    assert.equal(useIssuesStore.getState().filter, 'created');
    assert.equal(useIssuesStore.getState().issues[0]?.number, 105, 'new issue shown at the top of Created');
    assert.equal(useIssuesStore.getState().issues[0]?.title, 'New sidebar bug');
    assert.equal(useIssuesStore.getState().issues[0]?.labels[0]?.colorKey, 'red');
    assert.equal(useOperationStore.getState().toasts.at(-1)?.message, 'Created #105');
  } finally {
    s.restore();
  }
});

test('P26: slow post-close refetch resolving after Undo reopen is dropped by generation guard', async () => {
  resetAll();
  const openList = [issue(97), issue(98)];
  useIssuesStore.setState({
    issues: openList,
    issuesByFilter: {
      assigned: { open: openList, closed: [] },
      created: { open: [], closed: [] },
      mentioned: { open: [], closed: [] },
    },
    loadedAt: {
      assigned: { open: Date.now(), closed: null },
      created: { open: null, closed: null },
      mentioned: { open: null, closed: null },
    },
  });
  useNavStore.getState().setCount('issues', 2);

  const issueReads: Array<(v: unknown) => void> = [];
  const s = stub((kind, payload) => {
    if (kind === 'github/setIssueState') {
      const p = payload as { state: 'open' | 'closed' };
      return { number: 97, state: p.state };
    }
    if (kind === 'github/issues') {
      return new Promise<unknown>((resolve) => {
        issueReads.push(resolve);
      });
    }
    return { issues: [], rateLimit: RATE };
  });
  try {
    // 1. Close #97: starts post-close load (issueReads[0])
    const closed = await useIssuesStore.getState().close(97);
    assert.equal(closed, true);
    assert.equal(issueReads.length, 1, 'post-close load is in flight');

    // 2. User immediately clicks Undo while issueReads[0] is still in flight
    const closeToast = useOperationStore.getState().toasts.at(-1);
    closeToast?.action?.run();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(issueReads.length, 2, 'reopen starts a fresh forced load instead of joining stale in-flight load');

    // 3. Post-reopen load resolves first with [97, 98], then stale post-close load resolves late with [98]
    issueReads[1]?.({ issues: [issue(97), issue(98)], rateLimit: RATE });
    await new Promise((r) => setTimeout(r, 10));
    issueReads[0]?.({ issues: [issue(98)], rateLimit: RATE });
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(
      useIssuesStore.getState().issuesByFilter.assigned.open.map((i) => i.number),
      [97, 98],
      'late post-close refetch was dropped and did not overwrite reopened #97',
    );
    assert.equal(useNavStore.getState().counts.issues, 2, 'nav badge kept at 2');
  } finally {
    s.restore();
  }
});
