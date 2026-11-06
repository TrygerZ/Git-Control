/**
 * Sidebar GitHub gate (P07).
 *
 * One pure function decides which of four views every GitHub-backed tab shows,
 * and which single banner rides above it. The cases here pin the two that are
 * easy to get wrong: the PR view is readable while signed out on a public
 * repository, and a cached list must survive every banner state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_REQUIRED,
  PR_STALE_MS,
  githubGate,
  isStale,
  type GateInput,
} from '../src/webview/githubGate';
import type {
  ErrorBody,
  GitHubAuthState,
  GitHubLinkage,
  GitHubRateLimit,
} from '../src/messages';

const LINKED: GitHubLinkage = {
  available: true,
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  webUrl: 'https://github.com/o/r',
  commitUrlTemplate: 'https://github.com/o/r/commit/{hash}',
  apiUrl: 'https://api.github.com',
};

const NO_REMOTE: GitHubLinkage = {
  available: false,
  host: null,
  owner: null,
  repo: null,
  webUrl: null,
  commitUrlTemplate: null,
  apiUrl: null,
};

const SIGNED_IN: GitHubAuthState = { connected: true, login: 'me', scopes: ['repo'] };
const SIGNED_OUT: GitHubAuthState = { connected: false, login: null, scopes: [] };

const QUOTA: GitHubRateLimit = { limit: 5000, remaining: 4812, resetAt: null, cached: false, offline: false };
const EXHAUSTED: GitHubRateLimit = {
  limit: 60,
  remaining: 0,
  resetAt: 1_800_000_000_000,
  cached: true,
  offline: false,
};

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    view: 'prs',
    auth: SIGNED_IN,
    linkage: LINKED,
    rateLimit: QUOTA,
    error: null,
    loading: false,
    hasData: true,
    ...over,
  };
}

function error(code: ErrorBody['code']): ErrorBody {
  return { status: 401, code, message: 'nope' };
}

// ------------------------------------------------------------------- views

test('AUTH_REQUIRED keeps the PR view readable without a token', () => {
  assert.equal(AUTH_REQUIRED.prs, false);
  assert.equal(AUTH_REQUIRED.issues, true);
  assert.equal(AUTH_REQUIRED.actions, true);
});

test('the gate stays loading while the snapshot is still in flight', () => {
  assert.equal(githubGate(input({ auth: null, loading: true })).view, 'loading');
  assert.equal(githubGate(input({ linkage: null, loading: true })).view, 'loading');
});

test('a settled failure to read auth or linkage offers Connect, not a forever skeleton', () => {
  // `github/auth` or `github/linkage` rejecting leaves both null with `loading` false.
  // The view must be able to retry, so the gate falls back to the Connect affordance.
  assert.equal(githubGate(input({ auth: null, loading: false })).view, 'signed-out');
  assert.equal(githubGate(input({ linkage: null, loading: false })).view, 'signed-out');
});

test('a repository without a GitHub remote is no-remote, before any auth check', () => {
  assert.equal(githubGate(input({ linkage: NO_REMOTE, auth: SIGNED_OUT })).view, 'no-remote');
});

test('Issues and Actions demand a token', () => {
  for (const view of ['issues', 'actions'] as const) {
    const gate = githubGate(input({ view, auth: SIGNED_OUT }));
    assert.equal(gate.view, 'signed-out', view);
    assert.equal(gate.banner, null);
  }
});

test('the PR view lists anonymously on a public repository', () => {
  const gate = githubGate(input({ auth: SIGNED_OUT }));
  assert.equal(gate.view, 'ready');
  assert.deepEqual(gate.banner, { kind: 'sign-in' });
});

test('the PR view is signed-out when a tokenless read is refused', () => {
  for (const code of ['NOT_FOUND', 'FORBIDDEN', 'AUTH_ERROR'] as const) {
    const gate = githubGate(input({ auth: SIGNED_OUT, error: error(code), hasData: false }));
    assert.equal(gate.view, 'signed-out', code);
  }
});

test('the PR view stays ready once a cached list exists, whatever the error', () => {
  const gate = githubGate(input({ auth: SIGNED_OUT, error: error('NOT_FOUND'), hasData: true }));
  assert.equal(gate.view, 'ready');
});

test('a signed-in PR view carries no sign-in banner', () => {
  assert.deepEqual(githubGate(input()), { view: 'ready', banner: null });
});

// ----------------------------------------------------------------- banners

test('an exhausted quota outranks the sign-in banner and offers Connect', () => {
  const gate = githubGate(input({ auth: SIGNED_OUT, rateLimit: EXHAUSTED }));
  assert.equal(gate.view, 'ready', 'the cached list stays visible');
  assert.deepEqual(gate.banner, {
    kind: 'rate-limited',
    resetAt: 1_800_000_000_000,
    canConnect: true,
  });
});

test('rate-limited without a reset time still reports the banner', () => {
  const gate = githubGate(input({ rateLimit: { ...EXHAUSTED, resetAt: null } }));
  assert.deepEqual(gate.banner, { kind: 'rate-limited', resetAt: null, canConnect: false });
});

test('banner priority is invalid-token, rate-limited, offline, scope, metadata, sign-in', () => {
  const both = githubGate(
    input({ auth: { ...SIGNED_IN, invalidToken: true }, rateLimit: EXHAUSTED }),
  );
  assert.deepEqual(both.banner, { kind: 'invalid-token' });

  const offline = githubGate(input({ rateLimit: { ...QUOTA, offline: true } }));
  assert.deepEqual(offline.banner, { kind: 'offline' });

  const scope = githubGate(input({ auth: { ...SIGNED_IN, scopeWarning: 'need repo' } }));
  assert.deepEqual(scope.banner, { kind: 'scope-warning', text: 'need repo' });

  const metadata = githubGate(input({ error: { ...error('SERVER_ERROR'), message: 'boom' } }));
  assert.deepEqual(metadata.banner, { kind: 'metadata-incomplete', text: 'boom' });

  const signIn = githubGate(input({ auth: SIGNED_OUT }));
  assert.deepEqual(signIn.banner, { kind: 'sign-in' });
});

test('a healthy signed-in view carries no banner', () => {
  assert.equal(githubGate(input({ hasData: false })).banner, null);
});

// ------------------------------------------------------------------- stale

test('isStale uses the 60 s host cache TTL, boundary inclusive', () => {
  assert.equal(PR_STALE_MS, 60_000);
  assert.equal(isStale(null, 1_000_000), true, 'never loaded counts as stale');
  assert.equal(isStale(1_000_000, 1_059_999), false);
  assert.equal(isStale(1_000_000, 1_060_000), false, 'inclusive');
  assert.equal(isStale(1_000_000, 1_060_001), true);
  assert.equal(isStale(1_000_000, 1_000_001, 0), true, 'explicit TTL wins');
});

// ------------------------------------------------ quota failures (QA finding 1)

test('a RATE_LIMITED error raises the rate-limited banner, not metadata-incomplete', () => {
  // The API refuses the read before a successful response can report `remaining: 0`,
  // so the failure is the ONLY signal the real quota wall produces. The store keeps
  // the last successful snapshot, which still says 42 remaining.
  const gate = githubGate(
    input({
      auth: SIGNED_OUT,
      rateLimit: QUOTA,
      error: { status: 429, code: 'RATE_LIMITED', message: 'GitHub API rate limit reached.', detail: 'resetAt=1800000000000' },
    }),
  );
  assert.equal(gate.view, 'ready', 'the cached list stays visible');
  assert.deepEqual(gate.banner, {
    kind: 'rate-limited',
    resetAt: 1_800_000_000_000,
    canConnect: true,
  });
});

test('a RATE_LIMITED error without a reset time still reports the banner', () => {
  const gate = githubGate(
    input({ error: { status: 429, code: 'RATE_LIMITED', message: 'limited' } }),
  );
  assert.deepEqual(gate.banner, { kind: 'rate-limited', resetAt: null, canConnect: false });
});

test('a malformed resetAt detail is not trusted as a timestamp', () => {
  const gate = githubGate(
    input({ error: { status: 429, code: 'RATE_LIMITED', message: 'limited', detail: 'resetAt=soon' } }),
  );
  assert.deepEqual(gate.banner, { kind: 'rate-limited', resetAt: null, canConnect: false });
});
