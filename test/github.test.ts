import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHOR_CACHE_MAX_ENTRIES,
  AUTHOR_ETAG_MAX_ENTRIES,
  CACHE_MAX_ENTRIES,
  ETAG_MAX_ENTRIES,
  GitHubClient,
  GitHubError,
  RUN_DETAIL_TTL_MS,
  WORKFLOW_FILE_MAX_BYTES,
  WORKFLOW_FILE_TTL_MS,
  hasPrivateScope,
  parseScopes,
  type FetchLike,
  type FetchResponseLike,
} from '../src/github';
import { hostText } from '../src/hostText';
import type { Lang } from '../src/messages';

/** Header bag with case-insensitive lookup, like a real `Headers`. */
function headers(map: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function response(
  status: number,
  body: unknown,
  headerMap: Record<string, string> = {},
): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headers(headerMap),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

interface Recorder {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; headers: Record<string, string> }>;
}

/** Stub fetch that replays a queue of responses (or throws for network errors). */
function recorder(queue: Array<FetchResponseLike | Error>): Recorder {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let index = 0;
  return {
    calls,
    fetchImpl: (url, init) => {
      calls.push({ url, headers: init.headers });
      const next = queue[Math.min(index, queue.length - 1)];
      index += 1;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next as FetchResponseLike);
    },
  };
}

/** Client wired to fake time and instant sleeps. */
function client(
  queue: Array<FetchResponseLike | Error>,
  opts: { token?: string | null; apiUrl?: string; lang?: () => Lang } = {},
): { gh: GitHubClient; calls: Recorder['calls']; sleeps: number[]; advance(ms: number): void } {
  const rec = recorder(queue);
  const sleeps: number[] = [];
  let clock = 1_700_000_000_000;
  const gh = new GitHubClient({
    apiUrl: opts.apiUrl ?? 'https://api.github.com',
    token: opts.token === undefined ? 'ghp_secrettoken0123456789abcdef' : opts.token,
    fetchImpl: rec.fetchImpl,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    lang: opts.lang,
  });
  return {
    gh,
    calls: rec.calls,
    sleeps,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const TOKEN = 'ghp_secrettoken0123456789abcdef';

// -------------------------------------------------------------------- headers

test('sends the documented headers and a bearer token', async () => {
  const h = client([response(200, { login: 'octocat' }, { 'x-oauth-scopes': 'repo, read:org' })]);
  const viewer = await h.gh.viewer();

  assert.equal(viewer.data.login, 'octocat');
  assert.deepEqual(viewer.data.scopes, ['repo', 'read:org']);
  const sent = h.calls[0]?.headers as Record<string, string>;
  assert.equal(sent.Accept, 'application/vnd.github+json');
  assert.equal(sent['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(sent.Authorization, `Bearer ${TOKEN}`);
});

test('a missing scope header reads as null, not as an empty grant', async () => {
  // Fine-grained PATs send no `x-oauth-scopes` at all, while a classic token with
  // nothing checked sends a present-but-empty one. The two must not collapse:
  // `null` means "this token cannot report", `[]` means "it reported nothing".
  const absent = client([response(200, { login: 'octocat' })]);
  const fineGrained = await absent.gh.viewer();
  assert.equal(fineGrained.data.scopes, null, 'no header is unknown, not empty');

  const empty = client([response(200, { login: 'octocat' }, { 'x-oauth-scopes': '' })]);
  const scopeless = await empty.gh.viewer();
  assert.deepEqual(scopeless.data.scopes, [], 'a present but empty header is a real answer');
});

test('anonymous requests omit Authorization but still work', async () => {
  const h = client([response(200, { default_branch: 'main', private: false, html_url: 'u' })], {
    token: null,
  });
  const repo = await h.gh.repo('owner', 'repo');
  assert.equal(repo.data.defaultBranch, 'main');
  assert.equal(h.calls[0]?.headers.Authorization, undefined);
  assert.equal(h.gh.hasToken, false);
});

test('viewer without a token fails as AUTH_ERROR without a request', async () => {
  const h = client([response(200, {})], { token: null });
  await assert.rejects(() => h.gh.viewer(), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'AUTH_ERROR');
    return true;
  });
  assert.equal(h.calls.length, 0);
});

// ---------------------------------------------------------------- rate limit

test('parses rate-limit headers into a snapshot with ms reset', async () => {
  const h = client([
    response(200, { default_branch: 'main', private: false, html_url: 'u' }, {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4987',
      'x-ratelimit-reset': '1700000600',
    }),
  ]);
  const result = await h.gh.repo('o', 'r');
  assert.deepEqual(result.rateLimit, {
    limit: 5000,
    remaining: 4987,
    resetAt: 1_700_000_600_000,
    cached: false,
    offline: false,
  });
});

test('403 with remaining 0 maps to RATE_LIMITED and carries the reset time', async () => {
  const h = client([
    response(403, { message: 'API rate limit exceeded' }, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1700000600',
    }),
  ]);
  await assert.rejects(() => h.gh.repo('o', 'r'), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.resetAt, 1_700_000_600_000);
    return true;
  });
});

test('403 with quota left maps to FORBIDDEN, not RATE_LIMITED', async () => {
  const h = client([response(403, { message: 'nope' }, { 'x-ratelimit-remaining': '42' })]);
  await assert.rejects(() => h.gh.repo('o', 'r'), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'FORBIDDEN');
    return true;
  });
});

// ------------------------------------------------------------- error mapping

test('401 maps to AUTH_ERROR with the PRD wording', async () => {
  const hId = client([response(401, { message: 'Bad credentials' })], { lang: () => 'id' });
  await assert.rejects(() => hId.gh.viewer(), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.status, 401);
    assert.equal(err.code, 'AUTH_ERROR');
    assert.equal(err.message, hostText('id').github.invalidToken);
    return true;
  });

  const hEn = client([response(401, { message: 'Bad credentials' })], { lang: () => 'en' });
  await assert.rejects(() => hEn.gh.viewer(), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.status, 401);
    assert.equal(err.code, 'AUTH_ERROR');
    assert.equal(err.message, hostText('en').github.invalidToken);
    return true;
  });
});

test('404 maps to NOT_FOUND with the PRD wording', async () => {
  const hId = client([response(404, { message: 'Not Found' })], { lang: () => 'id' });
  await assert.rejects(() => hId.gh.repo('o', 'r'), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'NOT_FOUND');
    assert.equal(err.message, hostText('id').github.notFound);
    return true;
  });

  const hEn = client([response(404, { message: 'Not Found' })], { lang: () => 'en' });
  await assert.rejects(() => hEn.gh.repo('o', 'r'), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'NOT_FOUND');
    assert.equal(err.message, hostText('en').github.notFound);
    return true;
  });
});

test('a network failure maps to UNAVAILABLE with the PRD wording', async () => {
  const hId = client([new Error('getaddrinfo ENOTFOUND api.github.com')], { lang: () => 'id' });
  await assert.rejects(() => hId.gh.repo('o', 'r'), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    assert.equal(err.message, hostText('id').github.unavailable);
    return true;
  });

  const hEn = client([new Error('getaddrinfo ENOTFOUND api.github.com')], { lang: () => 'en' });
  await assert.rejects(() => hEn.gh.repo('o', 'r'), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    assert.equal(err.message, hostText('en').github.unavailable);
    return true;
  });
});

// -------------------------------------------------------------------- retry

test('retries network errors three times with 500/1000/2000 ms backoff', async () => {
  const h = client([new Error('socket hang up')]);
  await assert.rejects(() => h.gh.repo('o', 'r'));
  assert.deepEqual(h.sleeps, [500, 1000, 2000]);
  assert.equal(h.calls.length, 4, 'one initial attempt plus three retries');
});

test('retries 503 then succeeds', async () => {
  const h = client([
    response(503, { message: 'unavailable' }),
    response(200, { default_branch: 'main', private: false, html_url: 'u' }),
  ]);
  // The queue replays its last entry, so attempt two returns the 200.
  const result = await h.gh.repo('o', 'r');
  assert.equal(result.data.defaultBranch, 'main');
  assert.deepEqual(h.sleeps, [500]);
});

test('never retries a 4xx that is not 429', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const h = client([response(status, { message: 'no' })]);
    await assert.rejects(() => h.gh.repo('o', 'r'));
    assert.deepEqual(h.sleeps, [], `status ${status} must not be retried`);
    assert.equal(h.calls.length, 1, `status ${status} must be attempted once`);
  }
});

test('retries 429 because it is a throttle, not a client mistake', async () => {
  const h = client([response(429, { message: 'slow down' }, { 'x-ratelimit-remaining': '10' })]);
  await assert.rejects(() => h.gh.repo('o', 'r'));
  assert.deepEqual(h.sleeps, [500, 1000, 2000]);
});

// ------------------------------------------------------------------ breaker

test('the breaker opens after five failures in the window and then fails fast', async () => {
  const h = client([response(500, { message: 'boom' })]);
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(() => h.gh.repo(`o${i}`, 'r'));
  }
  assert.equal(h.gh.circuitOpen, true);

  const before = h.calls.length;
  await assert.rejects(() => h.gh.repo('fresh', 'r'), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    return true;
  });
  assert.equal(h.calls.length, before, 'no request is made while the circuit is open');
  assert.equal(h.gh.rateLimit().offline, true);
});

test('while open the breaker serves cached data instead of failing', async () => {
  const ok = response(200, { default_branch: 'main', private: false, html_url: 'u' });
  const queue: Array<FetchResponseLike | Error> = [ok];
  const rec = recorder(queue);
  let clock = 1_700_000_000_000;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    fetchImpl: rec.fetchImpl,
    now: () => clock,
    sleep: () => Promise.resolve(),
  });

  await gh.repo('o', 'r');
  // Force the breaker open with five server failures on other paths.
  queue[0] = response(500, { message: 'boom' });
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => gh.repo(`x${i}`, 'r'));
  assert.equal(gh.circuitOpen, true);

  // The cached repo is stale (TTL is 5 min) but still served while offline.
  clock += 600_000;
  const cached = await gh.repo('o', 'r');
  assert.equal(cached.cached, true);
  assert.equal(cached.data.defaultBranch, 'main');
  assert.equal(cached.rateLimit.offline, true);
});

test('a successful probe closes the breaker', async () => {
  const queue: Array<FetchResponseLike | Error> = [response(500, { message: 'boom' })];
  const rec = recorder(queue);
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    fetchImpl: rec.fetchImpl,
    sleep: () => Promise.resolve(),
  });
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => gh.repo(`o${i}`, 'r'));
  assert.equal(gh.circuitOpen, true);

  queue[0] = response(200, { rate: { remaining: 4999 } });
  assert.equal(await gh.probe(), true);
  assert.equal(gh.circuitOpen, false);
});

// -------------------------------------------------------------------- cache

test('a repeated read inside the TTL is served from cache without a request', async () => {
  const h = client([response(200, { default_branch: 'main', private: true, html_url: 'u' })]);
  const first = await h.gh.repo('o', 'r');
  const second = await h.gh.repo('o', 'r');

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.rateLimit.cached, true);
  assert.equal(h.calls.length, 1);
});

test('the cache expires: repo metadata after 5 minutes, PR lists after 60 seconds', async () => {
  const repoQueue = client([response(200, { default_branch: 'main', private: false, html_url: 'u' })]);
  await repoQueue.gh.repo('o', 'r');
  repoQueue.advance(299_000);
  assert.equal((await repoQueue.gh.repo('o', 'r')).cached, true);
  repoQueue.advance(2_000);
  assert.equal((await repoQueue.gh.repo('o', 'r')).cached, false);

  const prs = client([response(200, [])]);
  await prs.gh.pullRequests('o', 'r');
  prs.advance(59_000);
  assert.equal((await prs.gh.pullRequests('o', 'r')).cached, true);
  prs.advance(2_000);
  assert.equal((await prs.gh.pullRequests('o', 'r')).cached, false);
});

test('clearCache forces the next read back onto the network', async () => {
  const h = client([response(200, { default_branch: 'main', private: false, html_url: 'u' })]);
  await h.gh.repo('o', 'r');
  h.gh.clearCache();
  assert.equal((await h.gh.repo('o', 'r')).cached, false);
  assert.equal(h.calls.length, 2);
});

// ------------------------------------------------------------------- SEC-013

test('the cache is bounded and evicts in insertion order (SEC-013)', async () => {
  // `commitPulls:` is the one key generator that grows per commit, so it is the
  // realistic path to an unbounded map.
  const h = client([response(200, [])]);
  assert.equal(h.gh.cacheSize, 0);

  for (let i = 0; i < CACHE_MAX_ENTRIES; i += 1) {
    await h.gh.pullRequestsForCommit('o', 'r', `${i}`.padStart(40, '0'));
  }
  assert.equal(h.gh.cacheSize, CACHE_MAX_ENTRIES);

  // The first key is still present, so nothing was evicted prematurely.
  const firstHash = '0'.repeat(40);
  const callsBefore = h.calls.length;
  assert.equal((await h.gh.pullRequestsForCommit('o', 'r', firstHash)).cached, true);
  assert.equal(h.calls.length, callsBefore, 'served from cache, no request');

  // One past the cap evicts exactly one entry and holds the bound.
  for (let i = 0; i < 50; i += 1) {
    await h.gh.pullRequestsForCommit('o', 'r', `${1000 + i}`.padStart(40, '0'));
  }
  assert.equal(h.gh.cacheSize, CACHE_MAX_ENTRIES, 'the bound holds under continued growth');

  // And the oldest keys are the ones that went. The very first hash was refreshed
  // by the cached read above, which re-inserts it, so probe an untouched early one.
  const early = '1'.padStart(40, '0');
  const before = h.calls.length;
  await h.gh.pullRequestsForCommit('o', 'r', early);
  assert.equal(h.calls.length, before + 1, 'an evicted key goes back to the network');
});

test('a refreshed entry is not evicted as if it were the oldest (SEC-013)', async () => {
  const h = client([response(200, { default_branch: 'main', private: false, html_url: 'u' })]);
  // `repo:` first, so it is the insertion-order head.
  await h.gh.repo('o', 'r');
  // Re-reading past the TTL must move it to the back of the eviction queue,
  // otherwise the repository the user is looking at is the first thing dropped.
  h.advance(600_000);
  await h.gh.repo('o', 'r');

  for (let i = 0; i < CACHE_MAX_ENTRIES; i += 1) {
    await h.gh.pullRequestsForCommit('o', 'r', `${i}`.padStart(40, '0'));
  }
  assert.equal(h.gh.cacheSize, CACHE_MAX_ENTRIES);
});

test('the breaker can still serve a stale cached entry under the cap (SEC-013)', async () => {
  const queue: Array<FetchResponseLike | Error> = [
    response(200, { default_branch: 'main', private: false, html_url: 'u' }),
  ];
  const rec = recorder(queue);
  let clock = 1_700_000_000_000;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    fetchImpl: rec.fetchImpl,
    now: () => clock,
    sleep: () => Promise.resolve(),
  });

  await gh.repo('o', 'r');
  queue[0] = response(500, { message: 'boom' });
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => gh.repo(`x${i}`, 'r'));
  assert.equal(gh.circuitOpen, true);

  // The cap must not have evicted the entry the offline path depends on.
  clock += 600_000;
  const cached = await gh.repo('o', 'r');
  assert.equal(cached.cached, true);
  assert.equal(cached.data.defaultBranch, 'main');
});

// ----------------------------------------------------------- pull requests

test('pull requests default to open and are mapped to the DTO', async () => {
  const h = client([
    response(200, [
      {
        number: 7,
        title: 'Tambah panel',
        state: 'open',
        html_url: 'https://github.com/o/r/pull/7',
        head: {
          ref: 'fitur/panel',
          repo: { full_name: 'o/r', fork: false },
          sha: 'a'.repeat(40),
        },
        base: { ref: 'main' },
        draft: true,
        user: { login: 'octocat' },
        updated_at: '2026-08-01T10:00:00Z',
        maintainer_can_modify: true,
      },
      {
        number: 6,
        title: 'Sudah digabung',
        state: 'closed',
        html_url: 'https://github.com/o/r/pull/6',
        head: { ref: 'fix/a' },
        base: { ref: 'main' },
        user: { login: 'hubot' },
        updated_at: '2026-07-01T10:00:00Z',
        merged_at: '2026-07-02T10:00:00Z',
      },
    ]),
  ]);
  const result = await h.gh.pullRequests('o', 'r');
  assert.ok(h.calls[0]?.url.includes('state=open'));
  assert.deepEqual(result.data[0], {
    number: 7,
    title: 'Tambah panel',
    state: 'open',
    url: 'https://github.com/o/r/pull/7',
    headRef: 'fitur/panel',
    baseRef: 'main',
    draft: true,
    author: 'octocat',
    updatedAt: '2026-08-01T10:00:00Z',
    requestedReviewers: [],
    headRepo: 'o/r',
    isFork: false,
    maintainerCanModify: true,
    headSha: 'a'.repeat(40),
  });
  // `merged_at` wins over `state: closed` so the chip can say "merged".
  assert.equal(result.data[1]?.state, 'merged');
  // A payload that carries none of the fork fields still maps to a usable row.
  assert.deepEqual(
    { headRepo: result.data[1]?.headRepo, isFork: result.data[1]?.isFork, canModify: result.data[1]?.maintainerCanModify },
    { headRepo: null, isFork: true, canModify: false },
    'an absent head repository is a deleted fork, which is read only',
  );
});

test('a fork pull request carries its head repository and is marked read only', async () => {
  const h = client([
    response(200, [
      {
        number: 9,
        title: 'From a fork',
        state: 'open',
        html_url: 'https://github.com/o/r/pull/9',
        head: {
          ref: 'patch-1',
          sha: 'b'.repeat(40),
          repo: { full_name: 'someone/r', fork: true },
        },
        base: { ref: 'main' },
        user: { login: 'someone' },
        updated_at: '2026-08-02T10:00:00Z',
        maintainer_can_modify: false,
      },
    ]),
  ]);
  const pr = (await h.gh.pullRequests('o', 'r')).data[0];
  assert.equal(pr?.headRepo, 'someone/r');
  assert.equal(pr?.isFork, true);
  assert.equal(pr?.maintainerCanModify, false);
  assert.equal(pr?.headSha, 'b'.repeat(40));
});

test('pull requests map requested reviewers to logins only', async () => {
  const h = client([
    response(200, [
      { number: 1, requested_reviewers: [{ login: 'ann' }, { login: 'bob' }, { login: 42 }] },
      { number: 2, requested_reviewers: [{ slug: 'team-only' }] },
      { number: 3 },
      { number: 4, requested_reviewers: 'nope' },
    ]),
  ]);
  const result = await h.gh.pullRequests('o', 'r');
  assert.deepEqual(
    result.data.map((pr) => pr.requestedReviewers),
    [['ann', 'bob'], [], [], []],
    'teams carry no login, so they never match a viewer',
  );
});

test('pullRequestsForCommit hits the commit pulls endpoint', async () => {
  const h = client([response(200, [])]);
  await h.gh.pullRequestsForCommit('o', 'r', 'a'.repeat(40));
  assert.ok(h.calls[0]?.url.endsWith(`/repos/o/r/commits/${'a'.repeat(40)}/pulls`));
});

test('a malformed body degrades to an empty list instead of throwing', async () => {
  const h = client([response(200, 'not json')]);
  assert.deepEqual((await h.gh.pullRequests('o', 'r')).data, []);
});

// ------------------------------------------------------------------- pure

test('commitUrl is pure and derives the web host from the API base', async () => {
  const gh = new GitHubClient({ apiUrl: 'https://api.github.com', token: null });
  assert.equal(gh.commitUrl('o', 'r', 'abc1234'), 'https://github.com/o/r/commit/abc1234');

  const enterprise = new GitHubClient({ apiUrl: 'https://git.acme.example/api/v3', token: null });
  assert.equal(
    enterprise.commitUrl('team', 'tooling', 'abc1234'),
    'https://git.acme.example/team/tooling/commit/abc1234',
  );
});

test('parseScopes and hasPrivateScope implement the repo:status rule', () => {
  assert.deepEqual(parseScopes(null), []);
  assert.deepEqual(parseScopes(''), []);
  assert.deepEqual(parseScopes('repo, read:org , '), ['repo', 'read:org']);
  assert.equal(hasPrivateScope(['repo']), true);
  assert.equal(hasPrivateScope(['repo:status']), true);
  assert.equal(hasPrivateScope(['gist', 'read:user']), false);
});

// -------------------------------------------------------------- redaction

test('a thrown error never contains the token in message or detail', async () => {
  // Every failure shape: auth, not found, rate limit, server, and transport.
  const shapes: Array<FetchResponseLike | Error> = [
    response(401, { message: `Bad credentials for ${TOKEN}` }),
    response(404, { message: `no repo ${TOKEN}` }),
    response(403, { message: TOKEN }, { 'x-ratelimit-remaining': '0' }),
    response(500, { message: TOKEN }),
    new Error(`connect failed while sending Authorization: Bearer ${TOKEN}`),
  ];

  for (const shape of shapes) {
    const h = client([shape]);
    await assert.rejects(() => h.gh.repo('o', 'r'), (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      const serialized = `${err.message} ${err.detail ?? ''} ${err.stack ?? ''}`;
      assert.ok(!serialized.includes(TOKEN), `token leaked: ${serialized}`);
      return true;
    });
  }
});

test('returned data never carries the token', async () => {
  const h = client([response(200, { login: 'octocat' }, { 'x-oauth-scopes': 'repo' })]);
  const viewer = await h.gh.viewer();
  assert.ok(!JSON.stringify(viewer).includes(TOKEN));
});

// ----------------------------------------------------------- commit authors

test('commitAuthors returns author login and avatar URL', async () => {
  const h = client([
    response(200, {
      author: {
        login: 'octocat',
        avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
      },
    }),
  ]);
  const hash = 'a'.repeat(40);
  const result = await h.gh.commitAuthors('owner', 'repo', [hash]);
  assert.equal(result.cached, false);
  assert.deepEqual(result.data, [
    {
      hash,
      login: 'octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4&s=64',
    },
  ]);
  assert.ok(h.calls[0]?.url.endsWith(`/repos/owner/repo/commits/${hash}`));
});

test('commitAuthors serves second identical hash from cache without new request', async () => {
  const h = client([
    response(200, {
      author: {
        login: 'octocat',
        avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
      },
    }),
  ]);
  const hash = 'b'.repeat(40);
  const first = await h.gh.commitAuthors('owner', 'repo', [hash]);
  assert.equal(first.cached, false);
  assert.equal(h.calls.length, 1);

  const second = await h.gh.commitAuthors('owner', 'repo', [hash]);
  assert.equal(second.cached, true);
  assert.equal(h.calls.length, 1, 'served from cache, no network request');
  assert.deepEqual(second.data, first.data);
});

test('commitAuthors handles a failed hash (404) without failing the whole batch', async () => {
  const hashGood = '1'.repeat(40);
  const hashBad = '2'.repeat(40);
  const h = client([
    response(404, { message: 'Not Found' }),
    response(200, {
      author: {
        login: 'goodauthor',
        avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4',
      },
    }),
  ]);

  const result = await h.gh.commitAuthors('owner', 'repo', [hashBad, hashGood]);
  assert.deepEqual(result.data, [
    { hash: hashBad, login: null, avatarUrl: null },
    {
      hash: hashGood,
      login: 'goodauthor',
      avatarUrl: 'https://avatars.githubusercontent.com/u/123?v=4&s=64',
    },
  ]);
});

test('commitAuthors rejects invalid hashes without making requests', async () => {
  const h = client([response(200, {})]);
  await assert.rejects(
    () => h.gh.commitAuthors('owner', 'repo', ['not-a-hash']),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.code, 'VALIDATION_ERROR');
      return true;
    },
  );
  assert.equal(h.calls.length, 0);

  // Batch size > 50 is also rejected
  const oversized = Array.from({ length: 51 }, (_, i) => `${i}`.padStart(40, '0'));
  await assert.rejects(
    () => h.gh.commitAuthors('owner', 'repo', oversized),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.code, 'VALIDATION_ERROR');
      return true;
    },
  );
  assert.equal(h.calls.length, 0);
});

test('commitAuthors handles commit.author === null with avatarUrl: null', async () => {
  const h = client([response(200, { author: null })]);
  const hash = 'c'.repeat(40);
  const result = await h.gh.commitAuthors('owner', 'repo', [hash]);
  assert.deepEqual(result.data, [
    { hash, login: null, avatarUrl: null },
  ]);
});

test('contributorIdentity returns login, avatarUrl with s=64, and htmlUrl', async () => {
  const h = client([
    response(200, [
      {
        sha: 'abc1234',
        author: {
          login: 'octocat',
          avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
          html_url: 'https://github.com/octocat',
        },
      },
    ]),
  ]);
  const result = await h.gh.contributorIdentity('owner', 'repo', 'octocat@github.com');
  assert.equal(result.cached, false);
  assert.deepEqual(result.data, {
    login: 'octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4&s=64',
    htmlUrl: 'https://github.com/octocat',
  });
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.calls[0]?.url,
    'https://api.github.com/repos/owner/repo/commits?author=octocat%40github.com&per_page=1',
  );
});

test('contributorIdentity serves second identical email from cache without network request', async () => {
  const h = client([
    response(200, [
      {
        sha: 'abc1234',
        author: {
          login: 'octocat',
          avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
          html_url: 'https://github.com/octocat',
        },
      },
    ]),
  ]);
  const first = await h.gh.contributorIdentity('owner', 'repo', 'octocat@github.com');
  assert.equal(first.cached, false);
  assert.equal(h.calls.length, 1);

  const second = await h.gh.contributorIdentity('owner', 'repo', 'octocat@github.com');
  assert.equal(second.cached, true);
  assert.equal(h.calls.length, 1, 'served from cache, no network request');
  assert.deepEqual(second.data, first.data);
});

test('contributorIdentity handles empty commit array with fallback nulls', async () => {
  const h = client([response(200, [])]);
  const result = await h.gh.contributorIdentity('owner', 'repo', 'unknown@example.com');
  assert.deepEqual(result.data, {
    login: null,
    avatarUrl: null,
    htmlUrl: null,
  });
});

test('contributorIdentity handles commit without author or author === null', async () => {
  const h = client([response(200, [{ sha: 'abc1234', author: null }])]);
  const result = await h.gh.contributorIdentity('owner', 'repo', 'noauthor@example.com');
  assert.deepEqual(result.data, {
    login: null,
    avatarUrl: null,
    htmlUrl: null,
  });
});

test('contributorIdentity handles API failure gracefully with fallback nulls', async () => {
  const h = client([response(404, { message: 'Not Found' })]);
  const result = await h.gh.contributorIdentity('owner', 'repo', 'error@example.com');
  assert.deepEqual(result.data, {
    login: null,
    avatarUrl: null,
    htmlUrl: null,
  });
});

test('contributorIdentity encodes special characters in author email', async () => {
  const h = client([response(200, [])]);
  await h.gh.contributorIdentity('owner', 'repo', 'dev+test@example.com');
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.calls[0]?.url,
    'https://api.github.com/repos/owner/repo/commits?author=dev%2Btest%40example.com&per_page=1',
  );
});

test('contributorIdentity handles empty or whitespace email without network request', async () => {
  const h = client([response(200, [])]);
  const result = await h.gh.contributorIdentity('owner', 'repo', '   ');
  assert.deepEqual(result.data, {
    login: null,
    avatarUrl: null,
    htmlUrl: null,
  });
  assert.equal(h.calls.length, 0);
});

// ------------------------------------------------------- P12: ETag and 304

const REPO_BODY = { default_branch: 'main', private: false, html_url: 'u' };
const ETAG = 'W/"33a64df551425fcc55e4d42a148795d9f25f89d4"';

/** Past the repo TTL (5 min) and the PR TTL (60 s). */
function expire(h: { advance(ms: number): void }): void {
  h.advance(301_000);
}

test('a read past its TTL sends If-None-Match and a 304 returns the stored data', async () => {
  const h = client([
    response(200, REPO_BODY, { etag: ETAG }),
    response(304, ''),
  ]);
  const first = await h.gh.repo('o', 'r');
  assert.equal(first.cached, false);
  assert.equal(first.revalidated, undefined, 'a 200 is a plain read');

  expire(h);
  const second = await h.gh.repo('o', 'r');
  assert.equal(h.calls.length, 2, 'the expired read still costs exactly one request');
  assert.equal(h.calls[1]?.headers['If-None-Match'], ETAG, 'the stored etag travels on the retry');
  assert.deepEqual(second.data, first.data);
  assert.equal(second.cached, false, 'the server confirmed freshness, so it is not a cache replay');
  assert.equal(second.revalidated, true);
});

test('five consecutive 304s leave the breaker closed', async () => {
  const h = client([response(200, REPO_BODY, { etag: ETAG }), response(304, '')]);
  await h.gh.repo('o', 'r');
  for (let i = 0; i < 5; i += 1) {
    expire(h);
    const read = await h.gh.repo('o', 'r');
    assert.equal(read.revalidated, true);
  }
  assert.equal(h.gh.circuitOpen, false, 'a 304 is a success, never a failure');
});

test('a 304 refreshes the rate-limit snapshot from its headers', async () => {
  const h = client([
    response(200, REPO_BODY, { etag: ETAG, 'x-ratelimit-remaining': '4999' }),
    response(304, '', { 'x-ratelimit-remaining': '4998' }),
  ]);
  await h.gh.repo('o', 'r');
  expire(h);
  const read = await h.gh.repo('o', 'r');
  assert.equal(read.rateLimit.remaining, 4998);
});

test('a 304 whose stored value vanished mid-flight retries once without the header', async () => {
  const calls: Array<Record<string, string>> = [];
  let clock = 1_700_000_000_000;
  let gh!: GitHubClient;
  let firstRead = true;
  gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    now: () => clock,
    sleep: () => Promise.resolve(),
    fetchImpl: (_url, init) => {
      calls.push(init.headers);
      if (firstRead) {
        firstRead = false;
        return Promise.resolve(response(200, REPO_BODY, { etag: ETAG }));
      }
      if (calls.length === 2) {
        // A concurrent read evicts the validator at the bound while this one is
        // in flight, so the 304 can no longer be answered from the store.
        (gh as unknown as { etags: Map<string, unknown> }).etags.clear();
        return Promise.resolve(response(304, ''));
      }
      return Promise.resolve(response(200, REPO_BODY));
    },
  });

  await gh.repo('o', 'r');
  clock += 301_000;
  const read = await gh.repo('o', 'r');
  assert.equal(calls.length, 3, 'the 304 is retried exactly once');
  assert.equal(calls[2]?.['If-None-Match'], undefined, 'the retry is unconditional');
  assert.equal(read.data.defaultBranch, 'main');
  assert.equal(read.revalidated, undefined);
});

test('refresh skips the fresh cache but keeps the conditional request', async () => {
  const h = client([response(200, [], { etag: ETAG }), response(304, '')]);
  await h.gh.pullRequests('o', 'r');
  const insideTtl = await h.gh.pullRequests('o', 'r', { refresh: true });
  assert.equal(h.calls.length, 2, 'refresh is a request even inside the TTL');
  assert.equal(h.calls[1]?.headers['If-None-Match'], ETAG);
  assert.equal(insideTtl.revalidated, true);
  assert.equal(insideTtl.cached, false);
});

test('the etag store is bounded and evicts in insertion order', async () => {
  const h = client([response(200, [])]);
  assert.equal(h.gh.etagSize, 0);
  for (let i = 0; i < ETAG_MAX_ENTRIES; i += 1) {
    await h.gh.pullRequestsForCommit('o', 'r', `${i}`.padStart(40, '0'));
  }
  assert.equal(h.gh.etagSize, 0, 'a response without an etag header stores nothing');

  const tagged = client([response(200, [], { etag: ETAG })]);
  for (let i = 0; i < ETAG_MAX_ENTRIES; i += 1) {
    await tagged.gh.pullRequestsForCommit('o', 'r', `${i}`.padStart(40, '0'));
  }
  assert.equal(tagged.gh.etagSize, ETAG_MAX_ENTRIES);
  for (let i = 0; i < 50; i += 1) {
    await tagged.gh.pullRequestsForCommit('o', 'r', `${1000 + i}`.padStart(40, '0'));
  }
  assert.equal(tagged.gh.etagSize, ETAG_MAX_ENTRIES, 'the bound holds');
});

test('commit avatar traffic cannot evict the pull request validator', async () => {
  // Both webviews share one client, so a graph scroll on the Explorer fires
  // `commitAuthors` for every visible hash through the same `get()` path. Those
  // keys are unbounded in distinct hashes; if they shared one map with the list
  // validators, a single scroll would silently turn Reload into a full read.
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const LIST = /\/repos\/o\/r\/pulls\?/;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    sleep: () => Promise.resolve(),
    fetchImpl: (url, init) => {
      calls.push({ url, headers: init.headers });
      if (LIST.test(url) && init.headers['If-None-Match'] === ETAG) {
        return Promise.resolve(response(304, ''));
      }
      return Promise.resolve(response(200, LIST.test(url) ? [] : { author: { login: 'a', avatar_url: 'u' } }, { etag: ETAG }));
    },
  });

  await gh.pullRequests('o', 'r');
  // Far past both bounds, the way a long graph session behaves.
  for (let i = 0; i < AUTHOR_CACHE_MAX_ENTRIES + 50; i += 1) {
    await gh.commitAuthors('o', 'r', [`${i}`.padStart(40, '0')]);
  }

  const before = calls.length;
  const read = await gh.pullRequests('o', 'r', { refresh: true });
  assert.equal(calls[before]?.headers['If-None-Match'], ETAG, 'the list validator survived the avatar traffic');
  assert.equal(read.revalidated, true);
});

test('the author etag store is bounded on its own', async () => {
  const h = client([response(200, { author: { login: 'a', avatar_url: 'u' } }, { etag: ETAG })]);
  for (let i = 0; i < AUTHOR_ETAG_MAX_ENTRIES + 50; i += 1) {
    await h.gh.commitAuthors('o', 'r', [`${i}`.padStart(40, '0')]);
  }
  assert.equal(h.gh.authorEtagSize, AUTHOR_ETAG_MAX_ENTRIES, 'the author bound holds');
  assert.equal(h.gh.etagSize, 0, 'and it does not spill into the list store');
});

test('a revalidated etag is not evicted as if it were the oldest', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const LIST = /\/repos\/o\/r\/pulls\?/;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    sleep: () => Promise.resolve(),
    fetchImpl: (url, init) => {
      calls.push({ url, headers: init.headers });
      if (LIST.test(url) && init.headers['If-None-Match'] === ETAG) {
        return Promise.resolve(response(304, ''));
      }
      return Promise.resolve(response(200, [], { etag: ETAG }));
    },
  });

  // The pulls key goes in first, so it starts at the head of the eviction order.
  await gh.pullRequests('o', 'r');
  // One more key behind it, so re-inserting the pulls key actually moves it.
  await gh.pullRequestsForCommit('o', 'r', 'a'.repeat(40));
  // A 304 must move the pulls key to the back. Mutating its timestamp in place
  // would leave the list the user is looking at as the next eviction candidate.
  assert.equal((await gh.pullRequests('o', 'r', { refresh: true })).revalidated, true);

  // Fill exactly to the bound, then one past it: only the head is dropped.
  for (let i = 0; i < ETAG_MAX_ENTRIES - 2; i += 1) {
    await gh.pullRequestsForCommit('o', 'r', `${i}`.padStart(40, '0'));
  }
  assert.equal(gh.etagSize, ETAG_MAX_ENTRIES);
  await gh.pullRequestsForCommit('o', 'r', 'b'.repeat(40));
  assert.equal(gh.etagSize, ETAG_MAX_ENTRIES, 'the bound holds');

  const before = calls.length;
  const stillValidated = await gh.pullRequests('o', 'r', { refresh: true });
  assert.equal(calls.length, before + 1);
  assert.equal(calls[before]?.headers['If-None-Match'], ETAG, 'the revalidated key kept its validator');
  assert.equal(stillValidated.revalidated, true);
});

test('clearCache also clears the etag store', async () => {
  const h = client([response(200, REPO_BODY, { etag: ETAG })]);
  await h.gh.repo('o', 'r');
  assert.equal(h.gh.etagSize, 1);
  h.gh.clearCache();
  assert.equal(h.gh.etagSize, 0);
});

test('two clients with different tokens never share an etag', async () => {
  const queue = [response(200, REPO_BODY, { etag: ETAG }), response(200, REPO_BODY, { etag: ETAG })];
  const a = client(queue, { token: 'ghp_first_token_000000000000000000' });
  const b = client(queue, { token: 'ghp_second_token_111111111111111111' });
  await a.gh.repo('o', 'r');
  await b.gh.repo('o', 'r');
  assert.equal(a.gh.etagSize, 1);
  assert.equal(b.gh.etagSize, 1);
  assert.equal(b.calls[0]?.headers['If-None-Match'], undefined, 'a fresh client sends no etag');
});

test('a 200 without an etag drops the stored validator, so a later 304 cannot revert the list', async () => {
  const calls: Array<Record<string, string>> = [];
  let read = 0;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    sleep: () => Promise.resolve(),
    fetchImpl: (_url, init) => {
      calls.push(init.headers);
      read += 1;
      if (read === 1) return Promise.resolve(response(200, [{ number: 1 }], { etag: ETAG }));
      if (read === 2) return Promise.resolve(response(200, [{ number: 2 }]));
      // A server only answers 304 to a conditional request.
      if (init.headers['If-None-Match'] !== undefined) return Promise.resolve(response(304, ''));
      return Promise.resolve(response(200, [{ number: 2 }]));
    },
  });

  await gh.pullRequests('o', 'r');
  // A 200 with a new body but no validator must not leave the old etag paired
  // with the old value; the next conditional read would then answer from it.
  const second = await gh.pullRequests('o', 'r', { refresh: true });
  assert.deepEqual(second.data.map((p) => p.number), [2]);

  const third = await gh.pullRequests('o', 'r', { refresh: true });
  assert.equal(calls[2]?.['If-None-Match'], undefined, 'the stale validator is gone');
  assert.equal(third.revalidated, undefined);
  assert.deepEqual(third.data.map((p) => p.number), [2], 'the list never reverts');
});

test('a response without an etag header stores no etag', async () => {
  const h = client([response(200, REPO_BODY)]);
  await h.gh.repo('o', 'r');
  assert.equal(h.gh.etagSize, 0);
  expire(h);
  await h.gh.repo('o', 'r');
  assert.equal(h.calls[1]?.headers['If-None-Match'], undefined);
});

test('x-poll-interval becomes pollIntervalMs in milliseconds', async () => {
  const h = client([response(200, REPO_BODY, { 'x-poll-interval': '60' })]);
  await h.gh.repo('o', 'r');
  assert.equal(h.gh.pollIntervalMs, 60_000);
  assert.equal(h.gh.rateLimit().pollIntervalMs, 60_000);

  const absent = client([response(200, REPO_BODY)]);
  await absent.gh.repo('o', 'r');
  assert.equal(absent.gh.pollIntervalMs, null);
  assert.equal(absent.gh.rateLimit().pollIntervalMs, undefined, 'the field only appears when known');
});

test('the token and its fingerprint never appear in an etag key or a log line', async () => {
  const lines: string[] = [];
  const rec = recorder([response(200, REPO_BODY, { etag: ETAG })]);
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    fetchImpl: rec.fetchImpl,
    logger: (line) => lines.push(line),
    sleep: () => Promise.resolve(),
  });
  await gh.repo('o', 'r');
  const keys = [...(gh as unknown as { etags: Map<string, unknown> }).etags.keys()].join(' ');
  assert.ok(keys.length > 0);
  assert.ok(!keys.includes(TOKEN), 'the raw token is never a key');
  assert.ok(!lines.join('\n').includes(TOKEN));
  assert.ok(!lines.join('\n').includes(ETAG), 'etag values stay out of the log');
});

test('the breaker still serves stale cache and sends no request while open', async () => {
  const queue: Array<FetchResponseLike | Error> = [response(200, REPO_BODY, { etag: ETAG })];
  const rec = recorder(queue);
  let clock = 1_700_000_000_000;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    fetchImpl: rec.fetchImpl,
    now: () => clock,
    sleep: () => Promise.resolve(),
  });
  await gh.repo('o', 'r');
  queue[0] = response(500, { message: 'boom' });
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => gh.repo(`x${i}`, 'r'));
  assert.equal(gh.circuitOpen, true);
  const before = rec.calls.length;
  clock += 600_000;
  const stale = await gh.repo('o', 'r');
  assert.equal(rec.calls.length, before, 'no request while the circuit is open');
  assert.equal(stale.cached, true);
  assert.equal(stale.data.defaultBranch, 'main');
});

// ------------------------------------------------------------- job log (P14)

/** Response with a streaming body, so the reader path is exercised. */
function streamResponse(
  status: number,
  chunks: string[],
  headerMap: Record<string, string> = {},
): FetchResponseLike & { cancelled: boolean } {
  const encoded = chunks.map((c) => new TextEncoder().encode(c));
  let index = 0;
  const state = { cancelled: false };
  const body = {
    getReader() {
      return {
        read: () => {
          if (index >= encoded.length) return Promise.resolve({ done: true, value: undefined });
          const value = encoded[index];
          index += 1;
          return Promise.resolve({ done: false, value });
        },
        cancel: () => {
          state.cancelled = true;
          return Promise.resolve();
        },
      };
    },
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headers(headerMap),
    text: () => Promise.resolve(chunks.join('')),
    body,
    get cancelled() {
      return state.cancelled;
    },
  } as FetchResponseLike & { cancelled: boolean };
}

const SIGNED = 'https://pipelines.actions.githubusercontent.com/log?sig=SECRETSIG&se=2026';

function logClient(
  queue: Array<FetchResponseLike | Error>,
  opts: { token?: string | null; apiUrl?: string; logger?: (line: string) => void } = {},
): { gh: GitHubClient; calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }> } {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = [];
  let index = 0;
  // Both hops share the recorder: hop 1 goes through `fetchImpl`, hop 2 through
  // the separate log fetch, and the assertions need to see both.
  const record: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect });
    const next = queue[Math.min(index, queue.length - 1)];
    index += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next as FetchResponseLike);
  };
  const gh = new GitHubClient({
    apiUrl: opts.apiUrl ?? 'https://api.github.com',
    token: opts.token === undefined ? TOKEN : opts.token,
    fetchImpl: record,
    fetchLogImpl: record,
    now: () => 1_700_000_000_000,
    sleep: () => Promise.resolve(),
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  });
  return { gh, calls };
}

test('jobLogTail sends the token on hop 1 and none of it on hop 2', async () => {
  const signed = streamResponse(200, ['hello\n']);
  const { gh, calls } = logClient([response(302, '', { location: SIGNED }), signed]);
  const result = await gh.jobLogTail('o', 'r', 77);
  assert.equal(result.data.state, 'ok');
  assert.deepEqual(result.data.lines, [{ text: 'hello', tone: 'normal' }]);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, 'https://api.github.com/repos/o/r/actions/jobs/77/logs');
  assert.equal(calls[0]?.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0]?.redirect, 'manual');

  const second = calls[1] as { url: string; headers: Record<string, string> };
  assert.equal(second.url, SIGNED);
  const names = Object.keys(second.headers).map((n) => n.toLowerCase());
  for (const forbidden of ['authorization', 'accept', 'x-github-api-version']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not reach hop 2`);
  }
  assert.ok(!second.url.includes(TOKEN));
});

test('jobLogTail refuses a 302 with no Location', async () => {
  const { gh, calls } = logClient([response(302, '')]);
  await assert.rejects(() => gh.jobLogTail('o', 'r', 1), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('jobLogTail never calls a host outside the policy', async () => {
  const { gh, calls } = logClient([response(302, '', { location: 'https://evil.test/log?sig=x' })]);
  const result = await gh.jobLogTail('o', 'r', 1);
  assert.equal(result.data.state, 'blocked');
  assert.deepEqual(result.data.lines, []);
  assert.equal(calls.length, 1, 'the hostile host is never contacted');
});

test('jobLogTail refuses a redirect on hop 2', async () => {
  const { gh } = logClient([
    response(302, '', { location: SIGNED }),
    response(302, '', { location: 'https://pipelines.actions.githubusercontent.com/again' }),
  ]);
  const result = await gh.jobLogTail('o', 'r', 1);
  assert.equal(result.data.state, 'expired');
});

test('jobLogTail maps 404 and 410 to expired', async () => {
  for (const status of [404, 410]) {
    const { gh } = logClient([response(status, { message: 'gone' })]);
    const result = await gh.jobLogTail('o', 'r', 1);
    assert.equal(result.data.state, 'expired', String(status));
  }
});

test('jobLogTail maps 403 on hop 2 to expired', async () => {
  const { gh } = logClient([response(302, '', { location: SIGNED }), response(403, '')]);
  const result = await gh.jobLogTail('o', 'r', 1);
  assert.equal(result.data.state, 'expired');
});

test('jobLogTail maps 401 to AUTH_ERROR', async () => {
  const { gh } = logClient([response(401, { message: 'bad credentials' })]);
  await assert.rejects(() => gh.jobLogTail('o', 'r', 1), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'AUTH_ERROR');
    return true;
  });
});

test('jobLogTail processes a direct 200 body on hop 1', async () => {
  const { gh, calls } = logClient([streamResponse(200, ['direct line\n'])]);
  const result = await gh.jobLogTail('o', 'r', 1);
  assert.equal(result.data.state, 'ok');
  assert.deepEqual(result.data.lines.map((l) => l.text), ['direct line']);
  assert.equal(calls.length, 1);
});

test('jobLogTail cancels the reader past the hard cap and returns tooLarge', async () => {
  const big = streamResponse(200, ['x'.repeat(64), 'y'.repeat(64), 'z'.repeat(64)]);
  const { gh } = logClient([response(302, '', { location: SIGNED }), big]);
  // Shrink the cap through the public option so the test does not move 64 MiB.
  const result = await gh.jobLogTail('o', 'r', 1, { limits: { hardCapBytes: 100 } });
  assert.equal(result.data.state, 'tooLarge');
  assert.equal(big.cancelled, true);
});

test('jobLogTail surfaces a transport abort as UNAVAILABLE without retrying', async () => {
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const { gh, calls } = logClient([abort]);
  await assert.rejects(() => gh.jobLogTail('o', 'r', 1), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    return true;
  });
  assert.equal(calls.length, 1, 'no retry on the log path');
});

test('jobLogTail does not retry a 503 on hop 2 and calls it unavailable, not expired', async () => {
  const { gh, calls } = logClient([response(302, '', { location: SIGNED }), response(503, '')]);
  await assert.rejects(() => gh.jobLogTail('o', 'r', 1), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    return true;
  });
  assert.equal(calls.length, 2, 'no retry');
});

test('jobLogTail caches a completed job and not a running one', async () => {
  const completed = logClient([response(302, '', { location: SIGNED }), streamResponse(200, ['a\n'])]);
  await completed.gh.jobLogTail('o', 'r', 1, { completed: true });
  await completed.gh.jobLogTail('o', 'r', 1, { completed: true });
  assert.equal(completed.calls.length, 2, 'second read comes from the cache');

  const running = logClient([
    response(302, '', { location: SIGNED }),
    streamResponse(200, ['a\n']),
    response(302, '', { location: SIGNED }),
    streamResponse(200, ['a\n']),
  ]);
  await running.gh.jobLogTail('o', 'r', 2);
  await running.gh.jobLogTail('o', 'r', 2);
  assert.equal(running.calls.length, 4, 'a running job is read every time');
});

test('jobLogTail joins an in-flight request for the same job', async () => {
  const { gh, calls } = logClient([response(302, '', { location: SIGNED }), streamResponse(200, ['a\n'])]);
  await Promise.all([gh.jobLogTail('o', 'r', 9), gh.jobLogTail('o', 'r', 9)]);
  assert.equal(calls.length, 2, 'one hop 1 and one hop 2 for two callers');
});

test('jobLogTail fails fast while the breaker is open', async () => {
  const { gh, calls } = logClient([response(500, { message: 'boom' })]);
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => gh.jobLogTail('o', 'r', 100 + i));
  assert.equal(gh.circuitOpen, true);
  const before = calls.length;
  await assert.rejects(() => gh.jobLogTail('o', 'r', 200), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    return true;
  });
  assert.equal(calls.length, before);
});

test('jobLogTail never puts the signed url in an error detail or a log line', async () => {
  const lines: string[] = [];
  const { gh } = logClient([response(302, '', { location: SIGNED }), response(500, '')], {
    logger: (line) => lines.push(line),
  });
  // A storage 5xx is UNAVAILABLE, not a missing log. Its detail carries the
  // status only, never the URL it was asked for.
  await assert.rejects(() => gh.jobLogTail('o', 'r', 1), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    assert.ok(!String(err.detail ?? '').includes('SECRETSIG'));
    return true;
  });
  assert.ok(!lines.join('\n').includes('SECRETSIG'));
  const { gh: broken } = logClient([response(302, '', { location: SIGNED }), new Error(`fetch failed ${SIGNED}`)]);
  await assert.rejects(() => broken.jobLogTail('o', 'r', 1), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.ok(!String(err.detail ?? '').includes('SECRETSIG'));
    assert.ok(!err.message.includes('SECRETSIG'));
    return true;
  });
});

// ------------------------------------------------- P21: check runs and head sha

test('P21: checkRuns hits the commit check-runs route with a full page', async () => {
  const h = client([response(200, { total_count: 0, check_runs: [] })]);
  await h.gh.checkRuns('o', 'r', 'a'.repeat(40));
  assert.equal(
    h.calls[0]?.url,
    `https://api.github.com/repos/o/r/commits/${'a'.repeat(40)}/check-runs?per_page=100`,
  );
});

test('P21: checkRuns maps the fields the badge reads and tolerates junk', async () => {
  const h = client([
    response(200, {
      total_count: 3,
      check_runs: [
        {
          id: 11,
          name: 'Lint',
          app: { name: 'GitHub Actions' },
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/o/r/runs/11',
          started_at: '2026-11-13T00:00:00Z',
          completed_at: '2026-11-13T00:01:00Z',
        },
        // Unknown status and conclusion: queued and null, never a throw.
        { id: 12, name: 'Mystery', status: 'waiting', conclusion: 'invented' },
        // Almost nothing present.
        {},
      ],
    }),
  ]);
  const result = await h.gh.checkRuns('o', 'r', 'a'.repeat(40));
  assert.deepEqual(result.data[0], {
    id: 11,
    name: 'Lint',
    // The Checks tab groups by producer, so the app name is part of the row.
    app: 'GitHub Actions',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/o/r/runs/11',
    startedAt: '2026-11-13T00:00:00Z',
    completedAt: '2026-11-13T00:01:00Z',
  });
  assert.equal(result.data[1]?.status, 'queued', 'an unknown status is queued, not a crash');
  assert.equal(result.data[1]?.conclusion, null, 'an unknown conclusion is null');
  assert.equal(result.data[2]?.name, '');
  assert.equal(result.data[2]?.status, 'queued');
  assert.equal(result.data[2]?.url, '');
});

test('P21: checkRuns maps requested and waiting onto queued', async () => {
  const h = client([
    response(200, {
      check_runs: [
        { id: 1, name: 'a', status: 'requested' },
        { id: 2, name: 'b', status: 'waiting' },
        { id: 3, name: 'c', status: 'in_progress' },
      ],
    }),
  ]);
  const result = await h.gh.checkRuns('o', 'r', 'a'.repeat(40));
  assert.deepEqual(
    result.data.map((run) => run.status),
    ['queued', 'queued', 'in_progress'],
  );
});

test('P21: a malformed check-runs body degrades to an empty list', async () => {
  const h = client([response(200, 'not json')]);
  assert.deepEqual((await h.gh.checkRuns('o', 'r', 'a'.repeat(40))).data, []);
  const h2 = client([response(200, { check_runs: 'nope' })]);
  assert.deepEqual((await h2.gh.checkRuns('o', 'r', 'a'.repeat(40))).data, []);
});

test('P21: checkRuns 404 maps to NOT_FOUND without retrying', async () => {
  const h = client([response(404, { message: 'Not Found' })]);
  await assert.rejects(
    () => h.gh.checkRuns('o', 'r', 'a'.repeat(40)),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    },
  );
  assert.equal(h.calls.length, 1, 'a 404 is not retried');
});

test('P21: checks are cached under a per-sha key for 30 s', async () => {
  const h = client([response(200, { check_runs: [{ id: 1, name: 'Lint', status: 'completed', conclusion: 'success' }] })]);
  const sha = 'b'.repeat(40);
  const first = await h.gh.checkRuns('o', 'r', sha);
  assert.equal(first.cached, false);

  h.advance(29_999);
  const cached = await h.gh.checkRuns('o', 'r', sha);
  assert.equal(cached.cached, true, 'inside 30 s the copy answers');
  assert.equal(h.calls.length, 1);

  h.advance(2);
  const refreshed = await h.gh.checkRuns('o', 'r', sha);
  assert.equal(refreshed.cached, false, 'past 30 s the next read goes to the network');
  assert.equal(h.calls.length, 2);

  // A different commit is a different key.
  await h.gh.checkRuns('o', 'r', 'c'.repeat(40));
  assert.equal(h.calls.length, 3);
});

test('P21: a write can invalidate the checks cache by prefix', async () => {
  const h = client([response(200, { check_runs: [] })]);
  await h.gh.checkRuns('o', 'r', 'd'.repeat(40));
  assert.equal(h.gh.cacheSize, 1);
  assert.equal(h.gh.invalidate(['checks:']), 1);
  assert.equal(h.gh.cacheSize, 0);
});

test('P21: pull requests carry the head sha so a row can request checks', async () => {
  const h = client([
    response(200, [
      { number: 1, head: { ref: 'feat/a', sha: 'e'.repeat(40) }, base: { ref: 'main' } },
      { number: 2, head: { ref: 'feat/b' }, base: { ref: 'main' } },
      { number: 3 },
    ]),
  ]);
  const result = await h.gh.pullRequests('o', 'r');
  assert.equal(result.data[0]?.headSha, 'e'.repeat(40));
  assert.equal(result.data[1]?.headSha, undefined, 'a missing sha stays absent, not empty');
  assert.equal(result.data[2]?.headSha, undefined);
});

// ------------------------------------------- pull request create (P22)

const PR_BODY = {
  number: 154,
  title: 'feat(graph): add ribbon layout',
  html_url: 'https://github.com/o/r/pull/154',
  head: { ref: 'feat/graph-ribbons', sha: 'a'.repeat(40) },
  base: { ref: 'main' },
  state: 'open',
  draft: false,
  user: { login: 'me' },
  updated_at: '2026-11-14T00:00:00Z',
  requested_reviewers: [],
};

test('createPullRequest posts the documented body and invalidates the pull lists', async () => {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_x',
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      return response(201, PR_BODY);
    },
  });
  // Warm both caches the write has to drop.
  await gh.pullRequests('o', 'r').catch(() => undefined);

  const result = await gh.createPullRequest('o', 'r', {
    title: 'feat(graph): add ribbon layout',
    body: '## Summary',
    base: 'main',
    head: 'feat/graph-ribbons',
    draft: true,
  });

  const write = calls[calls.length - 1];
  assert.ok(write !== undefined);
  assert.equal(write.method, 'POST');
  assert.equal(write.url, 'https://api.github.com/repos/o/r/pulls');
  assert.deepEqual(JSON.parse(write.body as string), {
    title: 'feat(graph): add ribbon layout',
    body: '## Summary',
    base: 'main',
    head: 'feat/graph-ribbons',
    draft: true,
  });
  assert.equal(result.data.number, 154);
  assert.equal(result.data.url, 'https://github.com/o/r/pull/154');
});

test('createPullRequest maps an already-exists 422 to CONFLICT carrying the number', async () => {
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_x',
    fetchImpl: async () =>
      response(422, {
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for o:feat/a.' }],
      }),
  });

  const err = await gh
    .createPullRequest('o', 'r', { title: 'T', body: '', base: 'main', head: 'feat/a', draft: false })
    .catch((e: unknown) => e);
  assert.ok(err instanceof GitHubError);
  assert.equal(err.code, 'CONFLICT');
  assert.match(err.detail ?? '', /already exists/);
});

test('createPullRequest makes exactly one attempt on a 502, because a retry could duplicate', async () => {
  let calls = 0;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_x',
    sleep: async () => undefined,
    fetchImpl: async () => {
      calls += 1;
      return response(502, {});
    },
  });

  await assert.rejects(() =>
    gh.createPullRequest('o', 'r', { title: 'T', body: '', base: 'main', head: 'feat/a', draft: false }),
  );
  assert.equal(calls, 1);
});

test('createPullRequest drops the cached pull lists so the new row appears', async () => {
  const queue: FetchResponseLike[] = [response(200, []), response(201, PR_BODY)];
  let index = 0;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_x',
    fetchImpl: async () => queue[Math.min(index++, queue.length - 1)] as FetchResponseLike,
  });

  await gh.pullRequests('o', 'r');
  assert.equal(gh.cacheSize, 1);
  await gh.createPullRequest('o', 'r', {
    title: 'T',
    body: '',
    base: 'main',
    head: 'feat/a',
    draft: false,
  });
  assert.equal(gh.cacheSize, 0, 'pulls: was invalidated by the write');
});

test('findOpenPullRequest asks the documented head filter and returns the first match', async () => {
  let seen = '';
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_x',
    fetchImpl: async (url) => {
      seen = url;
      return response(200, [PR_BODY]);
    },
  });

  const found = await gh.findOpenPullRequest('o', 'r', 'o', 'feat/graph-ribbons', 'main');
  assert.match(seen, /\/repos\/o\/r\/pulls\?/);
  assert.match(seen, /head=o%3Afeat%2Fgraph-ribbons/);
  assert.match(seen, /base=main/);
  assert.match(seen, /state=open/);
  assert.equal(found?.number, 154);
});

test('findOpenPullRequest returns null when the branch pair has no open pull request', async () => {
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_x',
    fetchImpl: async () => response(200, []),
  });
  assert.equal(await gh.findOpenPullRequest('o', 'r', 'o', 'feat/a', 'main'), null);
});

test('requestReviewers posts the login list and returns it unchanged on success', async () => {
  let body = '';
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_x',
    fetchImpl: async (_url, init) => {
      body = init.body ?? '';
      return response(201, { requested_reviewers: [{ login: 'ann' }] });
    },
  });

  const result = await gh.requestReviewers('o', 'r', 154, ['ann', 'bob']);
  assert.deepEqual(JSON.parse(body), { reviewers: ['ann', 'bob'] });
  assert.deepEqual(result.requested, ['ann']);
});

test('collaborators maps a 403 to an empty list with the unavailable flag', async () => {
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_x',
    fetchImpl: async () => response(403, { message: 'Must have push access' }),
  });
  const result = await gh.collaborators('o', 'r');
  assert.deepEqual(result.data, { logins: [], available: false });
});

test('collaborators returns logins when the token can read them', async () => {
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_x',
    fetchImpl: async () => response(200, [{ login: 'ann' }, { login: 'bob' }]),
  });
  const result = await gh.collaborators('o', 'r');
  assert.deepEqual(result.data, { logins: ['ann', 'bob'], available: true });
});

// ---------------------------------------------------- P24 pull request detail

/** A pull detail body with every field the mapper reads. */
function pullDetailBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 150,
    title: 'Rebalance change row content inset to 8px',
    state: 'open',
    draft: false,
    user: { login: 'TrygerZ', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
    head: { ref: 'fix/ui-review-polish', sha: 'a'.repeat(40), repo: { full_name: 'o/r' } },
    base: { ref: 'main', sha: 'b'.repeat(40) },
    commits: 2,
    additions: 84,
    deletions: 15,
    changed_files: 3,
    mergeable_state: 'clean',
    html_url: 'https://github.com/o/r/pull/150',
    body: 'Change rows used a 12px inset.',
    created_at: '2026-11-18T00:00:00Z',
    updated_at: '2026-11-18T03:00:00Z',
    merged_at: null,
    requested_reviewers: [{ login: 'meganr' }],
    labels: [{ name: 'ui' }],
    ...overrides,
  };
}

test('P24: pullRequest hits the pulls/:number route with the PR TTL', async () => {
  const h = client([response(200, pullDetailBody())]);
  const result = await h.gh.pullRequest('o', 'r', 150);
  assert.equal(h.calls[0]?.url, 'https://api.github.com/repos/o/r/pulls/150');
  assert.equal(result.data.number, 150);
  assert.equal(result.data.mergeableState, 'clean');
  assert.equal(result.data.headSha, 'a'.repeat(40));
  assert.equal(result.data.baseSha, 'b'.repeat(40));
  assert.deepEqual(result.data.reviewers, ['meganr']);
  assert.equal(result.data.authorAvatarUrl, 'https://avatars.githubusercontent.com/u/1?v=4');
  assert.equal(result.cached, false);
});

test('P24: a second read inside the TTL is served from the cache without a request', async () => {
  const h = client([response(200, pullDetailBody())]);
  await h.gh.pullRequest('o', 'r', 150);
  h.advance(59_999);
  const again = await h.gh.pullRequest('o', 'r', 150);
  assert.equal(again.cached, true);
  assert.equal(h.calls.length, 1);
  h.advance(2);
  await h.gh.pullRequest('o', 'r', 150);
  assert.equal(h.calls.length, 2);
});

test('P24: a hostile detail body stays data and drops non-https links', async () => {
  const h = client([
    response(200, pullDetailBody({
      title: '<img src=x onerror=alert(1)>',
      body: '<script>alert(1)</script>',
      html_url: 'javascript:alert(1)',
      user: { login: 'mallory', avatar_url: 'https://evil.example/a.png' },
      mergeable_state: 'invented',
      commits: 'lots',
      labels: 'no',
      requested_reviewers: 'no',
    })),
  ]);
  const detail = (await h.gh.pullRequest('o', 'r', 150)).data;
  assert.equal(detail.body, '<script>alert(1)</script>', 'text stays text; the panel renders it as such');
  assert.equal(detail.htmlUrl, '', 'only https links survive');
  assert.equal(detail.authorAvatarUrl, null, 'a foreign avatar host is refused');
  assert.equal(detail.mergeableState, 'unknown');
  assert.equal(detail.commits, 0);
  assert.deepEqual(detail.labels, []);
  assert.deepEqual(detail.reviewers, []);
});

test('P24: a very long body is clamped', async () => {
  const h = client([response(200, pullDetailBody({ body: 'x'.repeat(70_000) }))]);
  const detail = (await h.gh.pullRequest('o', 'r', 150)).data;
  assert.ok(detail.body.length <= 65_536);
});

test('P24: pullCommits paginates to the cap and reports truncation', async () => {
  const page = (n: number): unknown[] =>
    Array.from({ length: 100 }, (_, i) => ({
      sha: `${String(n).repeat(2)}${String(i).padStart(2, '0')}`.padEnd(40, '0'),
      commit: {
        message: `commit ${n}-${i}`,
        author: { name: 'TrygerZ', date: '2026-11-18T00:00:00Z' },
      },
    }));
  const h = client([response(200, page(1)), response(200, page(2)), response(200, page(3))]);
  const result = await h.gh.pullCommits('o', 'r', 150);
  assert.equal(result.data.commits.length, 300);
  assert.equal(result.data.truncated, true, 'a full third page means there may be more');
  assert.match(h.calls[0]?.url ?? '', /\/pulls\/150\/commits\?per_page=100&page=1$/);
  assert.match(h.calls[2]?.url ?? '', /page=3$/);
});

test('P24: pullCommits stops early and is not truncated when a page is short', async () => {
  const h = client([
    response(200, [
      { sha: 'a'.repeat(40), commit: { message: 'one', author: { name: 'T', date: '2026-11-18T00:00:00Z' } } },
    ]),
  ]);
  const result = await h.gh.pullCommits('o', 'r', 150);
  assert.equal(result.data.commits.length, 1);
  assert.equal(result.data.truncated, false);
  assert.equal(h.calls.length, 1);
  assert.equal(result.data.commits[0]?.shortHash, 'aaaaaaa');
});

test('P24: pullFiles maps status and counts and tolerates junk', async () => {
  const h = client([
    response(200, [
      { filename: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 },
      { filename: 'src/b.ts', status: 'added', additions: 7, deletions: 0 },
      { filename: 'src/c.ts', status: 'removed', additions: 0, deletions: 3 },
      { filename: 'src/d.ts', status: 'renamed', additions: 0, deletions: 0 },
      { filename: 'src/e.ts', status: 'invented', additions: -1, deletions: 'x' },
      {},
    ]),
  ]);
  const result = await h.gh.pullFiles('o', 'r', 150);
  assert.deepEqual(result.data.files.map((f) => f.status), [
    'modified',
    'added',
    'removed',
    'renamed',
    'modified',
    'modified',
  ]);
  assert.equal(result.data.files[4]?.additions, 0, 'a negative count is zero, not -1');
  assert.equal(result.data.files[4]?.deletions, 0);
  assert.equal(result.data.files[5]?.path, '');
  assert.equal(result.data.truncated, false);
});

test('P24: pullTimeline merges reviews, review comments and issue comments in time order', async () => {
  const h = client([
    response(200, [
      {
        id: 1,
        user: { login: 'connorp' },
        submitted_at: '2026-11-18T02:00:00Z',
        state: 'APPROVED',
        body: 'Looks good',
      },
      {
        id: 2,
        user: { login: 'meganr' },
        submitted_at: '2026-11-18T01:00:00Z',
        state: 'CHANGES_REQUESTED',
        body: '',
      },
    ]),
    response(200, [
      { id: 3, user: { login: 'connorp' }, created_at: '2026-11-18T00:30:00Z', body: 'nested', path: 'src/a.ts' },
    ]),
    response(200, [
      { id: 4, user: { login: 'TrygerZ' }, created_at: '2026-11-18T00:00:00Z', body: 'opened' },
    ]),
  ]);
  const result = await h.gh.pullTimeline('o', 'r', 150);
  assert.deepEqual(
    result.data.items.map((item) => [item.kind, item.id]),
    [
      ['comment', 4],
      ['reviewComment', 3],
      ['review', 2],
      ['review', 1],
    ],
  );
});

test('P24: a 404 on the detail maps to NOT_FOUND', async () => {
  const h = client([response(404, { message: 'Not Found' })]);
  await assert.rejects(() => h.gh.pullRequest('o', 'r', 999), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'NOT_FOUND');
    return true;
  });
});

test('P24: an open breaker serves the cached detail rather than failing', async () => {
  const h = client([response(200, pullDetailBody()), response(500, {})]);
  await h.gh.pullRequest('o', 'r', 150);
  for (let i = 0; i < 5; i += 1) await h.gh.pullRequest('o', `x${i}`, 150).catch(() => undefined);
  assert.equal(h.gh.circuitOpen, true);
  const stale = await h.gh.pullRequest('o', 'r', 150);
  assert.equal(stale.cached, true);
  assert.equal(stale.data.number, 150);
});

// ------------------------------------------- P25 merge, close, review, reply

interface WriteCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * A client whose writes are recorded with method and parsed body.
 *
 * The shared `recorder` above drops both because every earlier call in this file
 * is a GET; every call in this block is a write, so both are the whole point.
 */
function writeClient(
  queue: Array<FetchResponseLike | Error>,
  lang: Lang = 'en',
): { gh: GitHubClient; calls: WriteCall[]; sleeps: number[] } {
  const calls: WriteCall[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      headers: init.headers,
    });
    const next = queue[Math.min(index, queue.length - 1)];
    index += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next as FetchResponseLike);
  };
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_p25token0123456789abcdef',
    fetchImpl,
    now: () => 1_700_000_000_000,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    lang: () => lang,
  });
  return { gh, calls, sleeps };
}

const MERGE_SHA = 'a'.repeat(40);

test('P25: merge sends PUT with the method, the pinned sha, and the squash message', async () => {
  const h = writeClient([
    response(200, { sha: 'c'.repeat(40), merged: true, message: 'Pull Request successfully merged' }),
  ]);
  const result = await h.gh.mergePullRequest('o', 'r', 150, {
    method: 'squash',
    sha: MERGE_SHA,
    commitTitle: 'fix(webview): rebalance inset (#150)',
    commitMessage: 'Additive tree indent.',
  });
  assert.equal(h.calls.length, 1);
  const sent = h.calls[0] as WriteCall;
  assert.equal(sent.method, 'PUT');
  assert.equal(sent.url, 'https://api.github.com/repos/o/r/pulls/150/merge');
  assert.deepEqual(sent.body, {
    merge_method: 'squash',
    sha: MERGE_SHA,
    commit_title: 'fix(webview): rebalance inset (#150)',
    commit_message: 'Additive tree indent.',
  });
  assert.deepEqual(result.data, { merged: true, mergeSha: 'c'.repeat(40) });
});

test('P25: a merge commit omits the squash fields entirely', async () => {
  const h = writeClient([response(200, { sha: 'c'.repeat(40), merged: true })]);
  await h.gh.mergePullRequest('o', 'r', 150, { method: 'merge', sha: MERGE_SHA });
  assert.deepEqual((h.calls[0] as WriteCall).body, { merge_method: 'merge', sha: MERGE_SHA });
});

test('P25: a 405 is a refusal, never an outage, and carries GitHub own sentence', async () => {
  const h = writeClient([
    response(405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com' }),
  ]);
  await assert.rejects(
    () => h.gh.mergePullRequest('o', 'r', 150, { method: 'merge', sha: MERGE_SHA }),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.code, 'CONFLICT', '405 is a refusal, not UNAVAILABLE');
      assert.equal(err.status, 409, 'the UI treats a refusal as a conflict');
      assert.equal(err.detail, 'Pull Request is not mergeable');
      return true;
    },
  );
});

test('P25: a 409 says the head moved, in the host language', async () => {
  for (const lang of ['en', 'id'] as const) {
    const h = writeClient([response(409, { message: 'Head branch was modified' })], lang);
    await assert.rejects(
      () => h.gh.mergePullRequest('o', 'r', 150, { method: 'merge', sha: MERGE_SHA }),
      (err: unknown) => {
        assert.ok(err instanceof GitHubError);
        assert.equal(err.code, 'CONFLICT');
        assert.equal(err.message, hostText(lang).github.headMoved);
        assert.equal(err.detail, 'Head branch was modified');
        return true;
      },
    );
  }
});

test('P25: a merge write is never retried', async () => {
  const h = writeClient([response(502, { message: 'later' })]);
  await assert.rejects(() => h.gh.mergePullRequest('o', 'r', 1, { method: 'merge', sha: MERGE_SHA }));
  assert.equal(h.calls.length, 1, 'one attempt only: a retried merge could double-merge');
  assert.deepEqual(h.sleeps, []);
});

test('P25: a landed merge drops every pull cache that now lies', async () => {
  const h = writeClient([
    response(200, []), // pulls list
    response(200, pullDetailBody()), // pull detail
    response(200, []), // commit pulls
    response(200, { sha: 'c'.repeat(40), merged: true }), // the merge
  ]);
  await h.gh.pullRequests('o', 'r');
  await h.gh.pullRequest('o', 'r', 150);
  await h.gh.pullRequestsForCommit('o', 'r', MERGE_SHA);
  assert.equal(h.gh.cacheSize, 3);
  await h.gh.mergePullRequest('o', 'r', 150, { method: 'merge', sha: MERGE_SHA });
  assert.equal(h.gh.cacheSize, 0, 'pulls:, pull: and commitPulls: are all stale after a merge');
});

test('P25: close sends PATCH with state closed and drops the list', async () => {
  const h = writeClient([response(200, [{ number: 1 }]), response(200, { number: 150, state: 'closed' })]);
  await h.gh.pullRequests('o', 'r');
  const result = await h.gh.closePullRequest('o', 'r', 150);
  const sent = h.calls[1] as WriteCall;
  assert.equal(sent.method, 'PATCH');
  assert.equal(sent.url, 'https://api.github.com/repos/o/r/pulls/150');
  assert.deepEqual(sent.body, { state: 'closed' });
  assert.equal(result.data.closed, true);
  assert.equal(h.gh.cacheSize, 0);
});

test('P25: a close GitHub refuses is VALIDATION_ERROR, not a silent success', async () => {
  const h = writeClient([
    response(422, { message: 'Validation Failed', errors: [{ message: 'state is invalid' }] }),
  ]);
  await assert.rejects(
    () => h.gh.closePullRequest('o', 'r', 150),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.code, 'VALIDATION_ERROR');
      assert.equal(err.detail, 'state is invalid');
      return true;
    },
  );
});

test('P25: submitReview posts the event, body, and pinned commit, and drops the review cache', async () => {
  const h = writeClient([
    response(200, []), // reviews
    response(200, []), // review comments
    response(200, []), // issue comments
    response(200, { id: 991, state: 'APPROVED' }), // the review
  ]);
  await h.gh.pullTimeline('o', 'r', 150);
  assert.equal(h.gh.cacheSize, 3);
  const result = await h.gh.submitReview('o', 'r', 150, {
    event: 'APPROVE',
    body: 'Looks good.',
    commitId: MERGE_SHA,
  });
  const sent = h.calls.at(-1) as WriteCall;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, 'https://api.github.com/repos/o/r/pulls/150/reviews');
  assert.deepEqual(sent.body, { event: 'APPROVE', body: 'Looks good.', commit_id: MERGE_SHA });
  assert.equal(result.data.reviewId, 991);
  // The review list is stale, the issue-comment list is not.
  assert.equal(h.gh.cacheSize, 1, 'only the review cache is dropped');
});

test('P25: replyToReviewComment posts to the reply route with only the body', async () => {
  const h = writeClient([response(201, { id: 55 })]);
  const result = await h.gh.replyToReviewComment('o', 'r', 150, 44, 'Agreed.');
  const sent = h.calls[0] as WriteCall;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, 'https://api.github.com/repos/o/r/pulls/150/comments/44/replies');
  assert.deepEqual(sent.body, { body: 'Agreed.' });
  assert.equal(result.data.commentId, 55);
});

test('P25: every review and reply write is one attempt', async () => {
  const review = writeClient([response(503, { message: 'down' })]);
  await assert.rejects(() =>
    review.gh.submitReview('o', 'r', 1, { event: 'COMMENT', body: 'x', commitId: MERGE_SHA }),
  );
  assert.equal(review.calls.length, 1);
  const reply = writeClient([response(503, { message: 'down' })]);
  await assert.rejects(() => reply.gh.replyToReviewComment('o', 'r', 1, 2, 'x'));
  assert.equal(reply.calls.length, 1);
});

test('P25 fix: pullRequest can bypass the 60 s cache for the merge pre-check', async () => {
  // The merge handler calls this read to decide whether the head moved. A cached
  // answer would compare the webview's sha against itself, so the pre-check must
  // be able to force a network read; the panel's ordinary read stays cached.
  const h = client([response(200, pullDetailBody()), response(200, pullDetailBody())]);
  await h.gh.pullRequest('o', 'r', 150);
  const cached = await h.gh.pullRequest('o', 'r', 150);
  assert.equal(cached.cached, true);
  assert.equal(h.calls.length, 1);

  const refreshed = await h.gh.pullRequest('o', 'r', 150, { refresh: true });
  assert.equal(refreshed.cached, false, 'refresh bypasses the cache');
  assert.equal(h.calls.length, 2);
});

test('P25: pullRequest carries isFork from head.repo and base.repo so closed and >50 PRs know', async () => {
  const h = client([
    response(200, pullDetailBody({
      head: { ref: 'feat/a', sha: 'a'.repeat(40), repo: { full_name: 'o/r', fork: false } },
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'o/r', fork: false } },
    })),
    response(200, pullDetailBody({
      number: 151,
      head: { ref: 'feat/local-in-fork', sha: 'a'.repeat(40), repo: { full_name: 'me/r', fork: true } },
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'me/r', fork: true } },
    })),
    response(200, pullDetailBody({
      number: 152,
      head: { ref: 'patch-1', sha: 'a'.repeat(40), repo: { full_name: 'someone/r', fork: true } },
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'o/r', fork: false } },
    })),
    response(200, pullDetailBody({
      number: 153,
      head: { ref: 'deleted-fork', sha: 'a'.repeat(40), repo: null },
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'o/r', fork: false } },
    })),
    response(200, pullDetailBody({
      number: 154,
      head: { ref: 'legacy-fork', sha: 'a'.repeat(40), repo: { full_name: 'someone/r', fork: true } },
    })),
  ]);

  assert.equal((await h.gh.pullRequest('o', 'r', 150)).data.isFork, false);
  assert.equal((await h.gh.pullRequest('o', 'r', 151)).data.isFork, false, 'same-repo PR inside a forked base repo is not a fork PR');
  assert.equal((await h.gh.pullRequest('o', 'r', 152)).data.isFork, true);
  assert.equal((await h.gh.pullRequest('o', 'r', 153)).data.isFork, true, 'deleted head repo is treated as a fork');
  assert.equal((await h.gh.pullRequest('o', 'r', 154)).data.isFork, true, 'falls back to head.repo.fork when base.repo is omitted');
});

test('P25: submitReview drops cached pullRequest detail so mergeability reflects the review', async () => {
  const h = writeClient([
    response(200, pullDetailBody({ mergeable_state: 'blocked' })),
    response(200, { id: 991, state: 'APPROVED' }),
    response(200, pullDetailBody({ mergeable_state: 'clean' })),
  ]);
  const before = await h.gh.pullRequest('o', 'r', 150);
  assert.equal(before.data.mergeableState, 'blocked');

  await h.gh.submitReview('o', 'r', 150, {
    event: 'APPROVE',
    body: '',
    commitId: MERGE_SHA,
  });

  const after = await h.gh.pullRequest('o', 'r', 150);
  assert.equal(after.cached, false, 'pull detail cache must be evicted after review submission');
  assert.equal(after.data.mergeableState, 'clean');
});

// ------------------------------------------------------- P26 issue write actions

test('P26: commentIssue posts to issues/{n}/comments and invalidates issues cache', async () => {
  const h = writeClient([
    response(200, []),
    response(201, { id: 881, html_url: 'https://github.com/o/r/issues/97#issuecomment-881' }),
  ]);
  await h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: 'me' });
  assert.equal(h.gh.cacheSize, 1);

  const result = await h.gh.commentIssue('o', 'r', 97, 'Looking into this.');
  const sent = h.calls.at(-1) as WriteCall;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, 'https://api.github.com/repos/o/r/issues/97/comments');
  assert.deepEqual(sent.body, { body: 'Looking into this.' });
  assert.deepEqual(result.data, {
    commentId: 881,
    htmlUrl: 'https://github.com/o/r/issues/97#issuecomment-881',
  });
  assert.equal(h.gh.cacheSize, 0, 'issues: cache is invalidated after commenting');
});

test('P26: setIssueState sends PATCH with completed on close and reopened on open', async () => {
  const h = writeClient([
    response(200, []),
    response(200, { number: 97, state: 'closed', state_reason: 'completed' }),
    response(200, { number: 97, state: 'open', state_reason: 'reopened' }),
  ]);
  await h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: 'me' });
  assert.equal(h.gh.cacheSize, 1);

  const closed = await h.gh.setIssueState('o', 'r', 97, 'closed');
  const closeCall = h.calls[1] as WriteCall;
  assert.equal(closeCall.method, 'PATCH');
  assert.equal(closeCall.url, 'https://api.github.com/repos/o/r/issues/97');
  assert.deepEqual(closeCall.body, { state: 'closed', state_reason: 'completed' });
  assert.deepEqual(closed.data, { number: 97, state: 'closed' });
  assert.equal(h.gh.cacheSize, 0, 'issues: cache is invalidated after state change');

  const reopened = await h.gh.setIssueState('o', 'r', 97, 'open');
  const reopenCall = h.calls[2] as WriteCall;
  assert.equal(reopenCall.method, 'PATCH');
  assert.equal(reopenCall.url, 'https://api.github.com/repos/o/r/issues/97');
  assert.deepEqual(reopenCall.body, { state: 'open', state_reason: 'reopened' });
  assert.deepEqual(reopened.data, { number: 97, state: 'open' });
});

test('P26: createIssue posts title, body, and labels and invalidates issues cache', async () => {
  const h = writeClient([
    response(200, []),
    response(201, { number: 105, html_url: 'https://github.com/o/r/issues/105' }),
  ]);
  await h.gh.issues('o', 'r', { filter: 'created', state: 'open', login: 'me' });
  assert.equal(h.gh.cacheSize, 1);

  const result = await h.gh.createIssue('o', 'r', {
    title: 'Add lane gutter push state',
    body: 'Track upstream divergence.',
    labels: ['enhancement', 'ui'],
  });
  const sent = h.calls.at(-1) as WriteCall;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, 'https://api.github.com/repos/o/r/issues');
  assert.deepEqual(sent.body, {
    title: 'Add lane gutter push state',
    body: 'Track upstream divergence.',
    labels: ['enhancement', 'ui'],
  });
  assert.deepEqual(result.data, {
    number: 105,
    htmlUrl: 'https://github.com/o/r/issues/105',
  });
  assert.equal(h.gh.cacheSize, 0);
});

test('P26: repoLabels fetches up to 100 labels, snaps colors to tones, and caches for 300 s', async () => {
  const h = client([
    response(200, [
      { name: 'bug', color: 'd73a4a' },
      { name: 'enhancement', color: 'a2eeef' },
      { name: 'invalid-color', color: 'expression(alert(1))' },
      { name: '', color: '000000' },
      { name: 123, color: '000000' },
    ]),
    response(200, [{ name: 'bug', color: 'd73a4a' }]),
  ]);

  const first = await h.gh.repoLabels('o', 'r');
  assert.equal(h.calls[0]?.url, 'https://api.github.com/repos/o/r/labels?per_page=100');
  assert.equal(first.cached, false);
  assert.deepEqual(first.data, [
    { name: 'bug', colorKey: 'red' },
    { name: 'enhancement', colorKey: 'blue' },
    { name: 'invalid-color', colorKey: 'gray' },
  ]);

  h.advance(299_999);
  const second = await h.gh.repoLabels('o', 'r');
  assert.equal(second.cached, true);
  assert.equal(h.calls.length, 1);

  h.advance(2);
  const third = await h.gh.repoLabels('o', 'r');
  assert.equal(third.cached, false);
  assert.equal(h.calls.length, 2);
});

test('P26: 410 (issues disabled), 403 (missing scope), and 422 (sanitized validation error) map to clear errors', async () => {
  for (const lang of ['en', 'id'] as const) {
    const disabled = writeClient([response(410, { message: 'Issues are disabled for this repo' })], lang);
    await assert.rejects(
      () => disabled.gh.createIssue('o', 'r', { title: 'T', body: '', labels: [] }),
      (err: unknown) => {
        assert.ok(err instanceof GitHubError);
        assert.equal(err.status, 410);
        assert.equal(err.code, 'FORBIDDEN');
        assert.equal(err.message, hostText(lang).github.issuesDisabled);
        return true;
      },
    );
  }

  const forbidden = writeClient([
    response(403, { message: 'Resource not accessible by personal access token' }, { 'x-ratelimit-remaining': '4900' }),
  ]);
  await assert.rejects(
    () => forbidden.gh.commentIssue('o', 'r', 97, 'hi'),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.status, 403);
      assert.equal(err.code, 'FORBIDDEN');
      assert.equal(err.message, hostText('en').github.missingScope('repo'));
      return true;
    },
  );

  const invalid = writeClient([
    response(422, {
      message: 'Validation Failed',
      errors: [{ message: 'title\u0000\u202e is invalid' }],
    }),
  ]);
  await assert.rejects(
    () => invalid.gh.setIssueState('o', 'r', 97, 'closed'),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.status, 422);
      assert.equal(err.code, 'VALIDATION_ERROR');
      assert.equal(err.detail, 'title is invalid', 'control and bidi characters are stripped from 422 error text');
      return true;
    },
  );
});

// ------------------------------------------------------- P27 Actions writes

test('P27: rerunFailedJobs sends POST with no body, returns requested, and invalidates runs and jobs caches only', async () => {
  const h = writeClient([
    response(200, { workflow_runs: [{ id: 10, workflow_id: 1, name: 'CI', status: 'completed', conclusion: 'failure' }] }),
    response(200, { jobs: [{ id: 20, name: 'test', status: 'completed', conclusion: 'failure' }] }),
    response(200, { workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }),
    response(200, [{ number: 1, title: 'Issue', state: 'open', html_url: 'https://github.com/o/r/issues/1', user: { login: 'me' } }]),
    response(201, ''),
  ]);
  await h.gh.workflowRuns('o', 'r', {});
  await h.gh.runJobs('o', 'r', 10);
  await h.gh.workflows('o', 'r');
  await h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: 'me' });
  assert.equal(h.gh.cacheSize, 4);

  const res = await h.gh.rerunFailedJobs('o', 'r', 10);
  assert.deepEqual(res.data, { requested: true });
  const sent = h.calls.at(-1) as WriteCall;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, 'https://api.github.com/repos/o/r/actions/runs/10/rerun-failed-jobs');
  assert.equal(sent.body, undefined, 're-run sends no JSON body');
  assert.equal(h.gh.cacheSize, 2, 'workflows: and issues: stay cached while runs: and jobs: are invalidated');

  const wfCached = await h.gh.workflows('o', 'r');
  assert.equal(wfCached.cached, true);
  const issCached = await h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: 'me' });
  assert.equal(issCached.cached, true);
});

test('P27: rerunFailedJobs does not retry on 502 and distinguishes 403 expiry from missing workflow scope', async () => {
  const retryClient = writeClient([response(502, { message: 'bad gateway' })]);
  await assert.rejects(() => retryClient.gh.rerunFailedJobs('o', 'r', 10));
  assert.equal(retryClient.calls.length, 1, 'no retry on POST');
  assert.deepEqual(retryClient.sleeps, []);

  for (const lang of ['en', 'id'] as const) {
    const expired = writeClient(
      [
        response(
          403,
          { message: 'This run is older than 30 days and cannot be re-run.' },
          { 'x-ratelimit-remaining': '4900' },
        ),
      ],
      lang,
    );
    await assert.rejects(
      () => expired.gh.rerunFailedJobs('o', 'r', 10),
      (err: unknown) => {
        assert.ok(err instanceof GitHubError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'FORBIDDEN');
        assert.equal(err.message, hostText(lang).github.rerunExpired);
        assert.notEqual(err.message, '__stub__');
        return true;
      },
    );

    const noScope = writeClient(
      [
        response(
          403,
          { message: 'Resource not accessible by personal access token' },
          { 'x-ratelimit-remaining': '4900' },
        ),
      ],
      lang,
    );
    await assert.rejects(
      () => noScope.gh.rerunFailedJobs('o', 'r', 10),
      (err: unknown) => {
        assert.ok(err instanceof GitHubError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'FORBIDDEN');
        assert.equal(err.message, hostText(lang).github.workflowMissingScope);
        assert.notEqual(err.message, '__stub__');
        return true;
      },
    );
  }
});

test('P27: dispatchWorkflow sends POST body with and without inputs, handles 204, invalidates runs, and never retries or logs input values', async () => {
  const logs: string[] = [];
  const calls: WriteCall[] = [];
  const sleeps: number[] = [];
  const queue = [
    response(200, { workflow_runs: [{ id: 1, workflow_id: 12, name: 'CI', status: 'completed', conclusion: 'success' }] }),
    response(200, { workflows: [{ id: 12, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }),
    response(204, ''),
    response(204, ''),
  ];
  let idx = 0;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_dispatchtoken0123456789abc',
    now: () => 1_700_000_000_000,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    logger: (line) => logs.push(line),
    fetchImpl: (url, init) => {
      calls.push({
        url,
        method: init.method,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
        headers: init.headers,
      });
      return Promise.resolve(queue[Math.min(idx++, queue.length - 1)]!);
    },
  });

  await gh.workflowRuns('o', 'r', {});
  await gh.workflows('o', 'r');
  assert.equal(gh.cacheSize, 2);

  const secretValue = 'super-secret-input-val-99';
  const withInputs = await gh.dispatchWorkflow('o', 'r', 12, {
    ref: 'main',
    inputs: { version: '2.8.0', token_note: secretValue },
  });
  assert.deepEqual(withInputs.data, {
    dispatched: true,
    at: new Date(1_700_000_000_000).toISOString(),
  });
  assert.equal(calls[2]?.method, 'POST');
  assert.equal(calls[2]?.url, 'https://api.github.com/repos/o/r/actions/workflows/12/dispatches');
  assert.deepEqual(calls[2]?.body, {
    ref: 'main',
    inputs: { version: '2.8.0', token_note: secretValue },
  });
  assert.equal(gh.cacheSize, 1, 'runs: invalidated while workflows: stays cached');
  assert.equal((await gh.workflows('o', 'r')).cached, true);
  assert.equal(logs.some((line) => line.includes(secretValue)), false, 'input values must never appear in logs');

  await gh.dispatchWorkflow('o', 'r', 12, { ref: 'feat/no-inputs' });
  assert.deepEqual(calls[3]?.body, { ref: 'feat/no-inputs' }, 'inputs key omitted when absent');

  const fail502 = writeClient([response(502, { message: 'bad gateway' })]);
  await assert.rejects(() => fail502.gh.dispatchWorkflow('o', 'r', 12, { ref: 'main' }));
  assert.equal(fail502.calls.length, 1);
  assert.deepEqual(fail502.sleeps, []);
});

test('P27: dispatchWorkflow maps 403, 404, and 422 (no trigger, disabled, missing inputs)', async () => {
  for (const lang of ['en', 'id'] as const) {
    const noTrigger = writeClient(
      [response(422, { message: 'Workflow does not have workflow_dispatch trigger' })],
      lang,
    );
    await assert.rejects(
      () => noTrigger.gh.dispatchWorkflow('o', 'r', 12, { ref: 'main' }),
      (err: unknown) => {
        assert.ok(err instanceof GitHubError);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.equal(err.message, hostText(lang).github.noDispatchTrigger);
        assert.notEqual(err.message, '__stub__');
        return true;
      },
    );

    const disabled = writeClient(
      [response(422, { message: 'Workflow is disabled' })],
      lang,
    );
    await assert.rejects(
      () => disabled.gh.dispatchWorkflow('o', 'r', 12, { ref: 'main' }),
      (err: unknown) => {
        assert.ok(err instanceof GitHubError);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.equal(err.message, hostText(lang).github.workflowDisabled);
        return true;
      },
    );

    const missingInputs = writeClient(
      [response(422, { message: 'Required input version was not provided\u0000\u202e' })],
      lang,
    );
    await assert.rejects(
      () => missingInputs.gh.dispatchWorkflow('o', 'r', 12, { ref: 'main' }),
      (err: unknown) => {
        assert.ok(err instanceof GitHubError);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.equal(err.message, hostText(lang).github.inputsNeededOnGitHub);
        assert.equal(err.detail, 'Required input version was not provided');
        return true;
      },
    );
  }

  const notFound = writeClient([response(404, { message: 'Not Found' })]);
  await assert.rejects(
    () => notFound.gh.dispatchWorkflow('o', 'r', 999, { ref: 'main' }),
    (err: unknown) => err instanceof GitHubError && err.code === 'NOT_FOUND',
  );

  const forbidden = writeClient([
    response(403, { message: 'Forbidden' }, { 'x-ratelimit-remaining': '4900' }),
  ]);
  await assert.rejects(
    () => forbidden.gh.dispatchWorkflow('o', 'r', 12, { ref: 'main' }),
    (err: unknown) =>
      err instanceof GitHubError &&
      err.code === 'FORBIDDEN' &&
      err.message === hostText('en').github.workflowMissingScope,
  );
});

test('P27: workflowFile decodes base64 YAML, caches 60 s, enforces 64 KiB cap, and workflowRun caches 30 s', async () => {
  const yaml = 'on:\n  workflow_dispatch:\n';
  const b64 = Buffer.from(yaml, 'utf8').toString('base64').replace(/(.{8})/g, '$1\n');
  const h = client([
    response(200, { type: 'file', encoding: 'base64', size: yaml.length, content: b64 }),
    response(200, { type: 'file', encoding: 'base64', size: yaml.length, content: b64 }),
  ]);

  const first = await h.gh.workflowFile('o', 'r', '.github/workflows/ci build.yml', 'feat/a b');
  assert.equal(
    h.calls[0]?.url,
    'https://api.github.com/repos/o/r/contents/.github/workflows/ci%20build.yml?ref=feat%2Fa%20b',
  );
  assert.equal(first.data, yaml);
  assert.equal(first.cached, false);

  h.advance(WORKFLOW_FILE_TTL_MS - 1);
  const second = await h.gh.workflowFile('o', 'r', '.github/workflows/ci build.yml', 'feat/a b');
  assert.equal(second.cached, true);
  assert.equal(h.calls.length, 1);

  h.advance(2);
  const third = await h.gh.workflowFile('o', 'r', '.github/workflows/ci build.yml', 'feat/a b');
  assert.equal(third.cached, false);
  assert.equal(h.calls.length, 2);

  // 64 KiB cap (declared size and decoded byte length)
  const oversized = Buffer.alloc(WORKFLOW_FILE_MAX_BYTES + 1, 0x61).toString('base64');
  const big = client([
    response(200, { type: 'file', encoding: 'base64', size: WORKFLOW_FILE_MAX_BYTES + 1, content: oversized }),
  ]);
  await assert.rejects(
    () => big.gh.workflowFile('o', 'r', '.github/workflows/big.yml', 'main'),
    (err: unknown) => err instanceof GitHubError && err.code === 'VALIDATION_ERROR',
  );

  // workflowRun caches 30 s and invalidates on rerunFailedJobs
  const runPayload = { id: 10, workflow_id: 1, name: 'CI', status: 'completed', conclusion: 'failure' };
  const rh = writeClient([response(200, runPayload), response(201, ''), response(200, runPayload)]);
  const r1 = await rh.gh.workflowRun('o', 'r', 10);
  assert.equal(r1.data.id, 10);
  assert.equal(r1.data.conclusion, 'failure');
  assert.equal((await rh.gh.workflowRun('o', 'r', 10)).cached, true);
  assert.equal(rh.calls.length, 1);

  await rh.gh.rerunFailedJobs('o', 'r', 10);
  const r2 = await rh.gh.workflowRun('o', 'r', 10);
  assert.equal(r2.cached, false);
  assert.equal(RUN_DETAIL_TTL_MS, 30_000);
});
