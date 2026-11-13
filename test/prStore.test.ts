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

// ------------------------------------------------- in-flight guard (QA finding 2)

test('two overlapping load() calls send one auth, linkage and pulls request', async () => {
  resetStore();
  useGitHubStore.setState({ auth: null, linkage: null });
  let pulls = 0;
  const s = stub((kind) => {
    if (kind === 'github/pullRequests') {
      pulls += 1;
      return { pullRequests: [pr(1)], rateLimit: RATE };
    }
    if (kind === 'github/auth') return { connected: true, login: 'me', scopes: [] };
    return LINKED;
  });
  try {
    await Promise.all([useGitHubStore.getState().load(), useGitHubStore.getState().load()]);
  } finally {
    s.restore();
  }
  assert.equal(pulls, 1, 'the sidebar mounts the shell and the view in one tick, so both would ask');
  assert.equal(s.calls.filter((c) => c.kind === 'github/auth').length, 1);
  assert.equal(s.calls.filter((c) => c.kind === 'github/linkage').length, 1);
});

test('a second load after the first settled asks again', async () => {
  resetStore();
  const s = stub((kind) => {
    if (kind === 'github/pullRequests') return { pullRequests: [pr(1)], rateLimit: RATE };
    if (kind === 'github/auth') return { connected: true, login: 'me', scopes: [] };
    return LINKED;
  });
  try {
    await useGitHubStore.getState().load();
    await useGitHubStore.getState().load();
  } finally {
    s.restore();
  }
  assert.equal(s.calls.filter((c) => c.kind === 'github/pullRequests').length, 2, 'a settled load is not cached');
});

test('two overlapping loadClosedPullRequests calls send one closed request', async () => {
  resetStore();
  let closed = 0;
  const s = stub((kind, payload) => {
    if (kind !== 'github/pullRequests') return { connected: true, login: 'me', scopes: [] };
    assert.equal((payload as { state?: string }).state, 'closed');
    closed += 1;
    return { pullRequests: [pr(4, 'closed')], rateLimit: RATE };
  });
  try {
    await Promise.all([
      useGitHubStore.getState().loadClosedPullRequests(),
      useGitHubStore.getState().loadClosedPullRequests(),
    ]);
  } finally {
    s.restore();
  }
  assert.equal(closed, 1, 'collapse and re-expand inside one request must not spend a second unit');
});

test('a refresh load asks the host to revalidate instead of replaying the cache', async () => {
  resetStore();
  const payloads: Array<Record<string, unknown>> = [];
  const s = stub((kind, payload) => {
    if (kind !== 'github/pullRequests') return { connected: true, login: 'me', scopes: [] };
    payloads.push(payload as Record<string, unknown>);
    return { pullRequests: [pr(1)], rateLimit: RATE };
  });
  try {
    await useGitHubStore.getState().loadPullRequests();
    await useGitHubStore.getState().loadPullRequests({ refresh: true });
  } finally {
    s.restore();
  }
  assert.equal(payloads[0]?.refresh, undefined, 'a plain load keeps the host default');
  assert.equal(payloads[1]?.refresh, true, 'Reload revalidates');
  assert.equal(payloads[1]?.state, 'open');
});

test('switching to another repository drops the previous pull request lists', async () => {
  resetStore();
  useGitHubStore.setState({
    pullRequests: [pr(1)],
    pullRequestsLoadedAt: 999,
    closedPullRequests: [pr(4, 'closed')],
    closedLoaded: true,
  });
  const other: GitHubLinkage = { ...LINKED, owner: 'other', repo: 'project' };
  const s = stub((kind) => {
    if (kind === 'github/auth') return { connected: true, login: 'me', scopes: [] };
    if (kind === 'github/linkage') return other;
    return { pullRequests: [pr(7)], rateLimit: RATE };
  });
  try {
    await useGitHubStore.getState().load();
  } finally {
    s.restore();
  }
  const state = useGitHubStore.getState();
  assert.deepEqual(state.closedPullRequests, [], 'the old repository closed rows are gone');
  assert.equal(state.closedLoaded, false, 'and the latch is released so the new repo can fetch');
  assert.deepEqual(
    state.pullRequests.map((p) => p.number),
    [7],
    'the new repository list replaces the old one',
  );
});

// ------------------------------------------------------------- checks (P21)

function sha(n: number): string {
  return `${n}`.padStart(40, 'a');
}

function summary(state: 'none' | 'passing' | 'failing' | 'pending', total = 1) {
  return {
    state,
    total,
    passed: state === 'passing' ? total : 0,
    failing: state === 'failing' ? total : 0,
    pending: state === 'pending' ? total : 0,
    failingNames: state === 'failing' ? ['Lint'] : [],
  };
}

function resetChecks(): void {
  useGitHubStore.setState({
    auth: { connected: true, login: 'me', scopes: ['repo'] },
    linkage: LINKED,
    checks: {},
    commitPullRequests: {},
  });
}

test('P21: loadChecks stores one summary per sha and asks once for the batch', async () => {
  resetChecks();
  const asked: string[][] = [];
  const s = stub((kind, payload) => {
    if (kind !== 'github/checkRuns') return { connected: true, login: 'me', scopes: [] };
    const shas = [(payload as { sha: string }).sha];
    asked.push(shas);
    return { checks: [], summary: summary('passing'), rateLimit: RATE };
  });
  try {
    await useGitHubStore.getState().loadChecks([sha(1), sha(2)]);
  } finally {
    s.restore();
  }
  assert.deepEqual(asked.flat().sort(), [sha(1), sha(2)].sort(), 'one request per sha');
  const checks = useGitHubStore.getState().checks;
  assert.equal(checks[sha(1)]?.state, 'passing');
  assert.equal(checks[sha(2)]?.state, 'passing');
});

test('P21: a second call inside 30 s sends nothing for a sha already asked about', async () => {
  resetChecks();
  let calls = 0;
  const s = stub((kind) => {
    if (kind !== 'github/checkRuns') return { connected: true, login: 'me', scopes: [] };
    calls += 1;
    return { checks: [], summary: summary('passing'), rateLimit: RATE };
  });
  try {
    await useGitHubStore.getState().loadChecks([sha(3)]);
    await useGitHubStore.getState().loadChecks([sha(3)]);
  } finally {
    s.restore();
  }
  assert.equal(calls, 1, 'the ledger answers the repeat, not the network');
});

test('P21: the ledger forgets a sha after 30 s so a scrolled row can refresh', async () => {
  resetChecks();
  let calls = 0;
  const realNow = Date.now;
  let clock = 1_700_000_000_000;
  Date.now = () => clock;
  const s = stub((kind) => {
    if (kind !== 'github/checkRuns') return { connected: true, login: 'me', scopes: [] };
    calls += 1;
    return { checks: [], summary: summary('passing'), rateLimit: RATE };
  });
  try {
    await useGitHubStore.getState().loadChecks([sha(4)]);
    clock += 29_000;
    await useGitHubStore.getState().loadChecks([sha(4)]);
    assert.equal(calls, 1, 'still inside the window');
    clock += 2_000;
    await useGitHubStore.getState().loadChecks([sha(4)]);
  } finally {
    Date.now = realNow;
    s.restore();
  }
  assert.equal(calls, 2, 'past the window the next scroll may ask again');
});

test('P21: loadChecks keeps ten requests in flight and still answers every row', async () => {
  resetChecks();
  let inFlight = 0;
  let maxInFlight = 0;
  const asked: string[] = [];
  const pending: Array<() => void> = [];
  const s = stub((kind, payload) => {
    if (kind !== 'github/checkRuns') return { connected: true, login: 'me', scopes: [] };
    asked.push((payload as { sha: string }).sha);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Hold the reply so the concurrency ceiling is observable, not a timing guess.
    return new Promise((resolve) => {
      pending.push(() => {
        inFlight -= 1;
        resolve({ checks: [], summary: summary('passing'), rateLimit: RATE });
      });
      if (pending.length >= 10) {
        for (const release of pending.splice(0)) release();
      }
    });
  });
  const shas = Array.from({ length: 12 }, (_, i) => sha(100 + i));
  const run = useGitHubStore.getState().loadChecks(shas);
  // Let the first batch reach the stub, then release everything.
  await new Promise((r) => setTimeout(r, 20));
  for (const release of pending.splice(0)) release();
  await run;
  // The second batch is only requested once the first settles.
  for (const release of pending.splice(0)) release();
  await new Promise((r) => setTimeout(r, 20));
  for (const release of pending.splice(0)) release();
  s.restore();

  assert.ok(maxInFlight <= 10, `ten in flight at most, saw ${maxInFlight}`);
  assert.equal(new Set(asked).size, asked.length, 'no sha is asked twice');
  assert.equal(
    Object.keys(useGitHubStore.getState().checks).length,
    12,
    'a settle that brings twelve rows still answers all twelve, not just the first ten',
  );
});

test('P21: loadChecks sends nothing without a GitHub remote', async () => {
  resetChecks();
  useGitHubStore.setState({ linkage: { ...LINKED, available: false, owner: null, repo: null } });
  const s = stub(() => ({}));
  try {
    await useGitHubStore.getState().loadChecks([sha(5)]);
  } finally {
    s.restore();
  }
  assert.deepEqual(s.calls, []);
});

test('P21: a failed check read is remembered as unavailable, not retried on every scroll', async () => {
  resetChecks();
  let calls = 0;
  const s = stub((kind) => {
    if (kind !== 'github/checkRuns') return { connected: true, login: 'me', scopes: [] };
    calls += 1;
    throw new Error('boom');
  });
  try {
    await useGitHubStore.getState().loadChecks([sha(6)]);
    await useGitHubStore.getState().loadChecks([sha(6)]);
  } finally {
    s.restore();
  }
  assert.equal(calls, 1, 'a failure must not become a request per scroll frame');
  assert.equal(
    useGitHubStore.getState().checks[sha(6)],
    null,
    'a failed read is recorded as unavailable, so the badge can say so instead of loading forever',
  );
});

test('P21: loadCommitPullRequests stores the list under the commit hash', async () => {
  resetChecks();
  const s = stub((kind) => {
    if (kind !== 'github/commitPullRequests') return { connected: true, login: 'me', scopes: [] };
    return { pullRequests: [pr(142, 'merged')], rateLimit: RATE };
  });
  try {
    await useGitHubStore.getState().loadCommitPullRequests(sha(7));
  } finally {
    s.restore();
  }
  const stored = useGitHubStore.getState().commitPullRequests[sha(7)];
  assert.equal(stored?.length, 1);
  assert.equal(stored?.[0]?.number, 142);
});

test('P21: an empty commit pull request answer is remembered as "none", not retried', async () => {
  resetChecks();
  let calls = 0;
  const s = stub((kind) => {
    if (kind !== 'github/commitPullRequests') return { connected: true, login: 'me', scopes: [] };
    calls += 1;
    return { pullRequests: [], rateLimit: RATE };
  });
  try {
    await useGitHubStore.getState().loadCommitPullRequests(sha(8));
    await useGitHubStore.getState().loadCommitPullRequests(sha(8));
  } finally {
    s.restore();
  }
  assert.equal(calls, 1);
  assert.deepEqual(useGitHubStore.getState().commitPullRequests[sha(8)], []);
});

test('P21: disconnect drops the check and commit pull request slices', async () => {
  resetChecks();
  useGitHubStore.setState({
    checks: { [sha(9)]: summary('passing') },
    commitPullRequests: { [sha(9)]: [pr(1)] },
  });
  const s = stub(() => ({ connected: false, login: null, scopes: [] }));
  try {
    await useGitHubStore.getState().disconnect();
  } finally {
    s.restore();
  }
  const state = useGitHubStore.getState();
  assert.deepEqual(state.checks, {});
  assert.deepEqual(state.commitPullRequests, {});
});

// ------------------------------------------- P21 gate findings: auth and retry

test('P21: no check or commit pull request request without a connected token', async () => {
  resetChecks();
  useGitHubStore.setState({ auth: { connected: false, login: null, scopes: [] } });
  const s = stub(() => ({}));
  try {
    await useGitHubStore.getState().loadChecks([sha(11)]);
    await useGitHubStore.getState().loadCommitPullRequests(sha(11));
  } finally {
    s.restore();
  }
  assert.deepEqual(s.calls, [], 'a signed-out user must not reach the API at all');
});

test('P21: a signed-out attempt does not burn the ledger, so connecting retries', async () => {
  resetChecks();
  useGitHubStore.setState({ auth: { connected: false, login: null, scopes: [] } });
  let calls = 0;
  const s = stub((kind) => {
    if (kind === 'github/commitPullRequests') {
      calls += 1;
      return { pullRequests: [pr(7)], rateLimit: RATE };
    }
    return { connected: true, login: 'me', scopes: [] };
  });
  try {
    await useGitHubStore.getState().loadCommitPullRequests(sha(12));
    assert.equal(calls, 0);
    useGitHubStore.setState({ auth: { connected: true, login: 'me', scopes: ['repo'] } });
    await useGitHubStore.getState().loadCommitPullRequests(sha(12));
  } finally {
    s.restore();
  }
  assert.equal(calls, 1, 'the ledger was never written while signed out');
  assert.equal(useGitHubStore.getState().commitPullRequests[sha(12)]?.[0]?.number, 7);
});

test('P21: connect clears the ledgers so a failed card can retry', async () => {
  resetChecks();
  let calls = 0;
  const s = stub((kind) => {
    if (kind === 'github/commitPullRequests') {
      calls += 1;
      throw new Error('transient');
    }
    if (kind === 'github/connect') return { connected: true, login: 'me', scopes: ['repo'] };
    if (kind === 'github/pullRequests') return { pullRequests: [], rateLimit: RATE };
    if (kind === 'github/auth') return { connected: true, login: 'me', scopes: ['repo'] };
    return LINKED;
  });
  try {
    await useGitHubStore.getState().loadCommitPullRequests(sha(13));
    assert.equal(calls, 1);
    await useGitHubStore.getState().connect();
    await useGitHubStore.getState().loadCommitPullRequests(sha(13));
  } finally {
    s.restore();
  }
  assert.equal(calls, 2, 'connecting is a new auth state, so the previous failure is not final');
});

test('P21: disconnect also forgets the check and commit pull request ledgers', async () => {
  resetChecks();
  let prCalls = 0;
  let checkCalls = 0;
  const s = stub((kind) => {
    if (kind === 'github/commitPullRequests') {
      prCalls += 1;
      return { pullRequests: [], rateLimit: RATE };
    }
    if (kind === 'github/checkRuns') {
      checkCalls += 1;
      return { checks: [], summary: summary('passing'), rateLimit: RATE };
    }
    if (kind === 'github/disconnect') return { connected: false, login: null, scopes: [] };
    return { connected: true, login: 'me', scopes: ['repo'] };
  });
  try {
    await useGitHubStore.getState().loadCommitPullRequests(sha(14));
    await useGitHubStore.getState().loadChecks([sha(14)]);
    await useGitHubStore.getState().disconnect();
    useGitHubStore.setState({ auth: { connected: true, login: 'me', scopes: ['repo'] } });
    await useGitHubStore.getState().loadCommitPullRequests(sha(14));
    await useGitHubStore.getState().loadChecks([sha(14)]);
  } finally {
    s.restore();
  }
  assert.equal(prCalls, 2, 'a reconnect is a fresh identity');
  assert.equal(checkCalls, 2);
});
