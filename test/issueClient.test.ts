/**
 * Repository issues read (P08).
 *
 * Two rules from the phase file are load-bearing and pinned here:
 *   - `/issues` returns pull requests too, marked by a `pull_request` key, so the
 *     mapper drops them; a PR must never render as an issue row
 *   - the body is untrusted and may be megabytes, so it is capped and neutralised
 *     in the host before it crosses `postMessage`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError, ISSUES_TTL_MS, type FetchResponseLike } from '../src/github';

const TOKEN = 'ghp_secrettoken0123456789abcdef';

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

interface Client {
  gh: GitHubClient;
  calls: string[];
  advance(ms: number): void;
}

function client(queue: FetchResponseLike[], token: string | null = TOKEN): Client {
  const calls: string[] = [];
  let clock = 1_700_000_000_000;
  let index = 0;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token,
    now: () => clock,
    sleep: () => Promise.resolve(),
    fetchImpl: (url) => {
      calls.push(url);
      const next = queue[Math.min(index, queue.length - 1)];
      index += 1;
      return Promise.resolve(next as FetchResponseLike);
    },
  });
  return { gh, calls, advance: (ms) => { clock += ms; } };
}

const RAW = [
  {
    number: 97,
    title: 'Login fails',
    state: 'open',
    state_reason: null,
    html_url: 'https://github.com/o/r/issues/97',
    user: { login: 'octocat' },
    assignees: [{ login: 'me' }, { login: 'you' }],
    labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'auth', color: '0e8a16' }],
    comments: 3,
    body: 'Line one\n\n  line two  ',
    updated_at: '2026-11-01T00:00:00Z',
    closed_at: null,
  },
  {
    number: 98,
    title: 'A pull request in disguise',
    state: 'open',
    pull_request: { url: 'https://api.github.com/repos/o/r/pulls/98' },
  },
];

// -------------------------------------------------------------------- mapping

test('issues drops pull request items and maps the rest', async () => {
  const h = client([response(200, RAW)]);
  const result = await h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: 'me' });
  assert.equal(result.data.length, 1, 'the PR item is dropped');
  const issue = result.data[0];
  assert.ok(issue !== undefined);
  assert.equal(issue.number, 97);
  assert.equal(issue.title, 'Login fails');
  assert.equal(issue.state, 'open');
  assert.equal(issue.stateReason, null);
  assert.equal(issue.url, 'https://github.com/o/r/issues/97');
  assert.equal(issue.author, 'octocat');
  assert.deepEqual(issue.assignees, ['me', 'you']);
  assert.deepEqual(issue.labels.map((l) => l.name), ['bug', 'auth']);
  assert.equal(issue.comments, 3);
  assert.equal(issue.updatedAt, '2026-11-01T00:00:00Z');
  assert.equal(issue.closedAt, null);
});

test('issues degrades non-string and missing fields to defaults', async () => {
  const h = client([
    response(200, [
      {
        number: 'nope',
        title: 42,
        state: 'weird',
        state_reason: 'something_else',
        html_url: null,
        user: null,
        assignees: 'no',
        labels: [{ name: 7, color: null }],
        comments: 'many',
        body: 12,
        updated_at: 5,
        closed_at: 9,
      },
    ]),
  ]);
  const result = await h.gh.issues('o', 'r', { filter: 'created', state: 'closed', login: 'me' });
  const issue = result.data[0];
  assert.ok(issue !== undefined);
  assert.equal(issue.number, 0);
  assert.equal(issue.title, '');
  assert.equal(issue.state, 'closed');
  assert.equal(issue.stateReason, null);
  assert.equal(issue.url, '');
  assert.equal(issue.author, '');
  assert.deepEqual(issue.assignees, []);
  assert.deepEqual(issue.labels, [], 'a label without a string name is dropped');
  assert.equal(issue.comments, 0);
  assert.equal(issue.bodyExcerpt, '');
  assert.equal(issue.updatedAt, '');
  assert.equal(issue.closedAt, null);
});

test('issues caps the excerpt at 200 and labels at 10', async () => {
  const longBody = 'a'.repeat(5000);
  const manyLabels = Array.from({ length: 25 }, (_, i) => ({ name: `l${i}`, color: '000000' }));
  const h = client([
    response(200, [
      { number: 1, title: 'big', state: 'open', body: longBody, labels: manyLabels, html_url: 'u' },
      { number: 2, title: 'html', state: 'open', body: '<script>alert(1)</script>', html_url: 'u' },
    ]),
  ]);
  const result = await h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: 'me' });
  const big = result.data[0];
  assert.ok(big !== undefined);
  assert.equal(big.bodyExcerpt.length, 200);
  assert.equal(big.labels.length, 10, 'the label list is capped');

  const html = result.data[1];
  assert.ok(html !== undefined);
  // The excerpt is text, not markup: the tags survive as characters and React
  // escapes them at the render site.
  assert.equal(html.bodyExcerpt, '<script>alert(1)</script>');
});

test('issues snaps label colours onto the seven tones', async () => {
  const h = client([
    response(200, [
      {
        number: 1,
        title: 'tone',
        state: 'open',
        html_url: 'u',
        labels: [
          { name: 'red', color: 'd73a4a' },
          { name: 'green', color: '0e8a16' },
          { name: 'bad', color: 'not-a-hex' },
          { name: 'none', color: null },
        ],
      },
    ]),
  ]);
  const result = await h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: 'me' });
  const tones = result.data[0]?.labels.map((l) => l.colorKey);
  assert.deepEqual(tones, ['red', 'green', 'gray', 'gray']);
});

// -------------------------------------------------------------------- request

test('issues asks the right endpoint per filter and state', async () => {
  for (const [filter, param] of [
    ['assigned', 'assignee'],
    ['created', 'creator'],
    ['mentioned', 'mentioned'],
  ] as const) {
    const h = client([response(200, [])]);
    await h.gh.issues('o', 'r', { filter, state: 'closed', login: 'octocat' });
    const url = h.calls[0] ?? '';
    assert.match(url, new RegExp(`/repos/o/r/issues\\?`), filter);
    assert.match(url, new RegExp(`${param}=octocat`), filter);
    assert.match(url, /state=closed/);
    assert.match(url, /per_page=50/);
    assert.match(url, /sort=updated/);
  }
});

test('issues without a login fails AUTH_ERROR and sends nothing', async () => {
  const h = client([response(200, [])]);
  await assert.rejects(
    () => h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: null }),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal(err.code, 'AUTH_ERROR');
      return true;
    },
  );
  assert.equal(h.calls.length, 0);

  // A tokenless client cannot resolve a login at all.
  const anon = client([response(200, [])], null);
  await assert.rejects(
    () => anon.gh.issues('o', 'r', { filter: 'created', state: 'open', login: null }),
    (err: unknown) => err instanceof GitHubError && err.code === 'AUTH_ERROR',
  );
  assert.equal(anon.calls.length, 0);
});

test('issues is cached per filter and state for the TTL', async () => {
  const h = client([response(200, RAW)]);
  const first = await h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: 'me' });
  assert.equal(first.cached, false);
  h.advance(ISSUES_TTL_MS - 1);
  const again = await h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: 'me' });
  assert.equal(again.cached, true);
  assert.equal(h.calls.length, 1);

  h.advance(2);
  const stale = await h.gh.issues('o', 'r', { filter: 'assigned', state: 'open', login: 'me' });
  assert.equal(stale.cached, false, 'past the TTL the read hits the network again');
  assert.equal(h.calls.length, 2);

  // A different filter is a different cache key, not a re-read.
  const other = await h.gh.issues('o', 'r', { filter: 'created', state: 'open', login: 'me' });
  assert.equal(other.cached, false);
  assert.equal(h.calls.length, 3);
});
