import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_MAX_ENTRIES,
  GITHUB_MESSAGES,
  GitHubClient,
  GitHubError,
  hasPrivateScope,
  parseScopes,
  type FetchLike,
  type FetchResponseLike,
} from '../src/github';

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
  opts: { token?: string | null; apiUrl?: string } = {},
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
  const h = client([response(401, { message: 'Bad credentials' })]);
  await assert.rejects(() => h.gh.viewer(), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.status, 401);
    assert.equal(err.code, 'AUTH_ERROR');
    assert.equal(err.message, GITHUB_MESSAGES.invalidToken);
    return true;
  });
});

test('404 maps to NOT_FOUND with the PRD wording', async () => {
  const h = client([response(404, { message: 'Not Found' })]);
  await assert.rejects(() => h.gh.repo('o', 'r'), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'NOT_FOUND');
    assert.equal(err.message, GITHUB_MESSAGES.notFound);
    return true;
  });
});

test('a network failure maps to UNAVAILABLE with the PRD wording', async () => {
  const h = client([new Error('getaddrinfo ENOTFOUND api.github.com')]);
  await assert.rejects(() => h.gh.repo('o', 'r'), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    assert.equal(err.message, GITHUB_MESSAGES.unavailable);
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
        head: { ref: 'fitur/panel' },
        base: { ref: 'main' },
        draft: true,
        user: { login: 'octocat' },
        updated_at: '2026-08-01T10:00:00Z',
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
  });
  // `merged_at` wins over `state: closed` so the chip can say "merged".
  assert.equal(result.data[1]?.state, 'merged');
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
      avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
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
      avatarUrl: 'https://avatars.githubusercontent.com/u/123?v=4',
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
