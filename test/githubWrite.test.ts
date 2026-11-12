/**
 * P19 T04/T05/T06/T07: the write path.
 *
 * Every case here is about restraint rather than capability: one attempt, no
 * cache read, no stale fallback, no retry. A repeated `POST` can create a second
 * pull request or a second comment, so "it worked on the retry" is a bug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError, type FetchLike, type FetchResponseLike } from '../src/github';
import { hostText } from '../src/hostText';

const TOKEN = 'ghp_writesecret0123456789abcdef';

function headers(map: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function response(status: number, body: unknown, headerMap: Record<string, string> = {}): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headers(headerMap),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function writeClient(
  queue: Array<FetchResponseLike | Error>,
  opts: { token?: string | null; logger?: (line: string) => void } = {},
): { gh: GitHubClient; calls: Call[]; sleeps: number[]; advance(ms: number): void } {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 1_700_000_000_000;
  let index = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
    const next = queue[Math.min(index, queue.length - 1)];
    index += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next as FetchResponseLike);
  };
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: opts.token === undefined ? TOKEN : opts.token,
    fetchImpl,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...(opts.logger === undefined ? {} : { logger: opts.logger }),
  });
  return {
    gh,
    calls,
    sleeps,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/**
 * The client's write surface. `mutate` is private on the class (only endpoint
 * methods inside `github.ts` call it), so the test reaches it through the shape
 * rather than widening the public API for a test.
 */
interface WriteSurface {
  mutate<T>(options: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body?: unknown;
    invalidate?: readonly string[];
    map(body: unknown, headers: { get(name: string): string | null }): T;
  }): Promise<{ data: T; rateLimit: { limit: number | null; remaining: number | null; resetAt: number | null; cached: boolean; offline: boolean } }>;
  invalidate(prefixes: readonly string[]): number;
  cacheSize: number;
}

function writer(gh: GitHubClient): WriteSurface {
  return gh as unknown as WriteSurface;
}

/** A representative write: create a pull request. */
function createPull(gh: GitHubClient, invalidate: readonly string[] = ['pulls:', 'commitPulls:']) {
  return writer(gh).mutate<{ number: number }>({
    method: 'POST',
    path: '/repos/o/r/pulls',
    body: { title: 'T', head: 'feat/x', base: 'main' },
    invalidate,
    map: (body) => ({ number: (body as { number?: unknown }).number as number }),
  });
}

// ------------------------------------------------------------------ request

test('mutate sends the requested method, JSON body, and content type', async () => {
  const h = writeClient([response(201, { number: 7 }, { 'x-ratelimit-remaining': '4999' })]);
  const result = await createPull(h.gh);

  assert.equal(result.data.number, 7);
  assert.equal(h.calls.length, 1);
  const sent = h.calls[0] as Call;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, 'https://api.github.com/repos/o/r/pulls');
  assert.equal(sent.headers['Content-Type'], 'application/json');
  assert.equal(sent.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(sent.body as string), { title: 'T', head: 'feat/x', base: 'main' });
});

test('mutate covers PUT, PATCH, and DELETE, and a body-less write sends none', async () => {
  for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
    const h = writeClient([response(200, { ok: true })]);
    await writer(h.gh).mutate({ method, path: '/repos/o/r/x', map: (body) => body });
    const sent = h.calls[0] as Call;
    assert.equal(sent.method, method);
    assert.equal(sent.body, undefined, `${method} without a body sends none`);
    assert.equal(sent.headers['Content-Type'], undefined, 'no content type without a body');
  }
});

test('mutate reports the rate-limit snapshot of the write response', async () => {
  const h = writeClient([
    response(201, { number: 1 }, {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4321',
      'x-ratelimit-reset': '1700000600',
    }),
  ]);
  const result = await createPull(h.gh);
  assert.deepEqual(result.rateLimit, {
    limit: 5000,
    remaining: 4321,
    resetAt: 1_700_000_600_000,
    cached: false,
    offline: false,
  });
});

// -------------------------------------------------------------------- retry

test('mutate makes exactly one attempt on 502, 503, 504, and 429', async () => {
  for (const status of [502, 503, 504, 429]) {
    const h = writeClient([response(status, { message: 'later' }, { 'x-ratelimit-remaining': '10' })]);
    await assert.rejects(() => createPull(h.gh), (err: unknown) => err instanceof GitHubError);
    assert.equal(h.calls.length, 1, `status ${status} must not be retried`);
    assert.deepEqual(h.sleeps, [], `status ${status} must not back off`);
  }
});

test('mutate makes exactly one attempt on a transport failure', async () => {
  const h = writeClient([new Error(`socket hang up ${TOKEN}`)]);
  await assert.rejects(() => createPull(h.gh), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    return true;
  });
  assert.equal(h.calls.length, 1, 'a write is never repeated automatically');
  assert.deepEqual(h.sleeps, []);
});

test('a body that dies mid-read is reported as UNAVAILABLE, never as a landed write', async () => {
  // GitHub already committed the write when the 2xx arrived; a failure reading
  // the body must not look like "nothing happened", or the user retries the POST
  // and creates the duplicate this whole path exists to prevent.
  const broken: FetchResponseLike = {
    status: 201,
    ok: true,
    headers: headers({}),
    text: () => Promise.reject(new Error(`socket hang up ${TOKEN}`)),
  };
  const h = writeClient([broken]);
  await assert.rejects(() => createPull(h.gh), (err: unknown) => {
    assert.ok(err instanceof GitHubError, 'a raw Error would map to 500 SERVER_ERROR');
    assert.equal(err.code, 'UNAVAILABLE');
    assert.ok(!JSON.stringify(err).includes(TOKEN));
    return true;
  });
});

test('a 2xx still invalidates the cache even when the body cannot be read', async () => {
  // The write landed. Whatever the response body did, the cached list is stale.
  const h = writeClient([
    response(200, [{ number: 1, title: 'one', state: 'open', html_url: 'u' }]),
    {
      status: 201,
      ok: true,
      headers: headers({}),
      text: () => Promise.reject(new Error('body gone')),
    } as FetchResponseLike,
  ]);
  await h.gh.pullRequests('o', 'r');
  await assert.rejects(() => createPull(h.gh));
  assert.equal(h.gh.cacheSize, 0, 'pulls: is gone even though the reply was unreadable');
});

test('a throwing mapper is reported as UNAVAILABLE, not as a raw error', async () => {
  const h = writeClient([response(201, { number: 7 })]);
  await assert.rejects(
    () =>
      writer(h.gh).mutate({
        method: 'POST',
        path: '/repos/o/r/pulls',
        body: {},
        map: () => {
          throw new Error('mapper blew up');
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.code, 'UNAVAILABLE');
      return true;
    },
  );
});

// ------------------------------------------------------------------ mapping

test('mutate maps 401, 403, 404, and 422 like the read path', async () => {
  const cases: Array<[number, string]> = [
    [401, 'AUTH_ERROR'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
  ];
  for (const [status, code] of cases) {
    const h = writeClient([response(status, { message: 'x' }, { 'x-ratelimit-remaining': '10' })]);
    await assert.rejects(() => createPull(h.gh), (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.code, code, `status ${status}`);
      return true;
    });
  }

  // 422 is the one write-specific case: the request was understood and refused.
  const invalid = writeClient([response(422, { message: 'Validation Failed' })]);
  await assert.rejects(() => createPull(invalid.gh), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.status, 422);
    return true;
  });
});

test('a write 403 names the permission it needs instead of a bare denial', async () => {
  // A fine-grained token cannot report its scopes, so the guard lets the attempt
  // through and GitHub answers 403. "Access denied" leaves the user nowhere to
  // go; naming the permission is the only actionable answer available.
  const h = writeClient([response(403, { message: 'Resource not accessible' }, { 'x-ratelimit-remaining': '42' })]);
  await assert.rejects(() => createPull(h.gh), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'FORBIDDEN');
    assert.equal(err.message, hostText('en').github.missingScope('repo'));
    return true;
  });
});

test('a quota 403 still reads as RATE_LIMITED, not as a permission problem', async () => {
  const h = writeClient([
    response(403, { message: 'quota' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000900' }),
  ]);
  await assert.rejects(() => createPull(h.gh), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'RATE_LIMITED');
    return true;
  });
});

test('mutate maps a quota 403 to RATE_LIMITED with the reset time', async () => {
  const h = writeClient([
    response(403, { message: 'quota' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000900' }),
  ]);
  await assert.rejects(() => createPull(h.gh), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.resetAt, 1_700_000_900_000);
    return true;
  });
});

// ------------------------------------------------------------------- cache

test('a successful write invalidates the listed prefixes and keeps the rest', async () => {
  const h = writeClient([
    response(200, { default_branch: 'main', private: false, html_url: 'u' }),
    response(200, [{ number: 1, title: 'one', state: 'open', html_url: 'u' }]),
    response(200, [{ number: 2, title: 'two', state: 'open', html_url: 'u' }]),
    response(201, { number: 9 }),
    response(200, { default_branch: 'main', private: false, html_url: 'u' }),
    response(200, [{ number: 3, title: 'three', state: 'open', html_url: 'u' }]),
  ]);
  await h.gh.repo('o', 'r');
  await h.gh.pullRequests('o', 'r');
  await h.gh.pullRequestsForCommit('o', 'r', 'a'.repeat(40));
  const callsBefore = h.calls.length;

  await createPull(h.gh);
  assert.equal(h.calls.length, callsBefore + 1);

  const repo = await h.gh.repo('o', 'r');
  assert.equal(repo.cached, true, 'repo: survives the invalidation');
  assert.equal(h.calls.length, callsBefore + 1);

  const pulls = await h.gh.pullRequests('o', 'r');
  assert.equal(pulls.cached, false, 'pulls: was invalidated');
  assert.equal(h.calls.length, callsBefore + 2);

  const commitPulls = await h.gh.pullRequestsForCommit('o', 'r', 'a'.repeat(40));
  assert.equal(commitPulls.cached, false, 'commitPulls: was invalidated');
});

test('invalidate returns the number of removed entries and touches nothing else', async () => {
  const h = writeClient([
    response(200, { default_branch: 'main', private: false, html_url: 'u' }),
    response(200, [{ number: 1, title: 'one', state: 'open', html_url: 'u' }]),
  ]);
  await h.gh.repo('o', 'r');
  await h.gh.pullRequests('o', 'r');
  const before = h.gh.cacheSize;

  assert.equal(writer(h.gh).invalidate(['pulls:']), 1);
  assert.equal(h.gh.cacheSize, before - 1);
  assert.equal(writer(h.gh).invalidate(['pulls:']), 0, 'already gone');
  assert.equal(writer(h.gh).invalidate([]), 0, 'nothing asked, nothing removed');
});

test('invalidate clears a validator whose cached body was already evicted', async () => {
  // The two stores are bounded separately, so a body can be evicted while its
  // ETag survives. Sweeping only the keys still in `cache` would leave that
  // validator to answer the next read with a 304 and re-serve the pre-write body.
  const h = writeClient([
    response(200, [{ number: 1, title: 'pre-write', state: 'open', html_url: 'u' }], { etag: 'W/"e1"' }),
  ]);
  await h.gh.pullRequests('o', 'r');
  assert.equal(h.gh.etagSize, 1);

  // Simulate the eviction: the body is gone, the validator is not.
  (h.gh as unknown as { cache: Map<string, unknown> }).cache.clear();
  assert.equal(h.gh.cacheSize, 0);

  assert.equal(writer(h.gh).invalidate(['pulls:']), 0, 'nothing left to remove from the body cache');
  assert.equal(h.gh.etagSize, 0, 'but the validator must go too, or the next 304 revives the old body');
});

test('invalidate sweeps the author cache too, not only the response cache', async () => {
  // Author responses live in their own bounded store, so a prefix sweep that
  // only walks `cache` leaves them behind. Nothing invalidates an author key
  // today, and the next phase that does would silently keep a stale login.
  const h = writeClient([
    response(200, { author: { login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/1' } }),
  ]);
  await h.gh.commitAuthors('o', 'r', ['a'.repeat(40)]);
  assert.equal(h.gh.authorCacheSize, 1);

  assert.equal(writer(h.gh).invalidate(['commitAuthor:']), 1);
  assert.equal(h.gh.authorCacheSize, 0);
  assert.equal(h.gh.authorEtagSize, 0);
});

test('a failed write invalidates nothing', async () => {
  const h = writeClient([
    response(200, [{ number: 1, title: 'one', state: 'open', html_url: 'u' }]),
    response(502, { message: 'down' }),
  ]);
  await h.gh.pullRequests('o', 'r');
  await assert.rejects(() => createPull(h.gh));
  const again = await h.gh.pullRequests('o', 'r');
  assert.equal(again.cached, true, 'the cached list survives a write that never landed');
});

// ----------------------------------------------------------------- breaker

test('an open breaker blocks a write and never serves cache for it', async () => {
  const h = writeClient([
    response(200, [{ number: 1, title: 'one', state: 'open', html_url: 'u' }]),
    response(500, { message: 'boom' }),
  ]);
  await h.gh.pullRequests('o', 'r');
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => h.gh.repo(`x${i}`, 'r'));
  assert.equal(h.gh.circuitOpen, true);

  const before = h.calls.length;
  await assert.rejects(() => createPull(h.gh), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'UNAVAILABLE');
    return true;
  });
  assert.equal(h.calls.length, before, 'no request while the circuit is open');
});

test('a write never counts a 4xx as a breaker failure, and a 5xx does count', async () => {
  const h = writeClient([
    response(422, { message: 'invalid' }),
    response(500, { message: 'boom' }),
  ]);
  await assert.rejects(() => createPull(h.gh));
  assert.equal(h.gh.circuitOpen, false, '422 is a client mistake, not an outage');

  // Five server failures on their own open the breaker, exactly as they do on
  // the read path. The 422 above must not have shortened the count.
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => createPull(h.gh));
  assert.equal(h.gh.circuitOpen, true, 'five 5xx writes open the breaker');
});

// --------------------------------------------------------------- redaction

test('a failed write never leaks the token through its error or its log', async () => {
  const lines: string[] = [];
  const h = writeClient([response(422, { message: `bad token ${TOKEN}` })], { logger: (line) => lines.push(line) });
  await assert.rejects(() => createPull(h.gh), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.ok(!JSON.stringify(err).includes(TOKEN));
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
  assert.ok(!lines.join('\n').includes(TOKEN));
});
