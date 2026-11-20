import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError, type FetchResponseLike } from '../src/github';
import { parseDispatchInputs, workflowWebUrl } from '../src/workflowInputs';
import { matchDispatchedRun } from '../src/webview/actionsModel';
import type { ActionsRunsResult, DispatchWorkflowResult, WorkflowInputsResult } from '../src/messages';
import { makeRepo, type Harness, type TestRepo } from './fixture';

const TOKEN = 'ghp_e2e_secret_0123456789abcdef';
function headers(map: Record<string, string>) { const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v])); return { get: (n: string) => lower.get(n.toLowerCase()) ?? null }; }
function response(status: number, body: unknown, h: Record<string, string> = {}): FetchResponseLike { return { status, ok: status >= 200 && status < 300, headers: headers(h), text: () => Promise.resolve(JSON.stringify(body)) }; }
function fake(queue: Array<FetchResponseLike | Error>) {
  const calls: string[] = []; let i = 0;
  return { calls, fetchImpl: (url: string) => { calls.push(url); const x = queue[Math.min(i++, queue.length - 1)]; if (x === undefined) return Promise.reject(new Error('empty test queue')); return x instanceof Error ? Promise.reject(x) : Promise.resolve(x); } };
}
function client(queue: Array<FetchResponseLike | Error>) {
  const f = fake(queue); let now = 1_700_000_000_000; const sleeps: number[] = [];
  const gh = new GitHubClient({ apiUrl: 'https://api.github.com', token: TOKEN, fetchImpl: f.fetchImpl, now: () => now, sleep: async (ms) => { sleeps.push(ms); } });
  return { gh, ...f, sleeps, advance: (ms: number) => { now += ms; } };
}
function own(t: { after(fn: () => unknown): void }, repo: TestRepo, h?: Harness): void { t.after(() => { h?.dispose(); return repo.cleanup(); }); }

test('Kasus 8: bridge exposes rate-limit badge and serves cached data after 403 quota exhaustion', async (t) => {
  const repo = await makeRepo({ label: 'k8-bridge' });
  const h = client([
    response(200, { default_branch: 'main', private: false, html_url: 'https://github.com/o/r' }, { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '9', 'x-ratelimit-reset': '1700000600' }),
    response(403, { message: 'quota' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000601' }),
  ]);
  const bridge = repo.harness({ host: { githubRepo: async () => { const result = await h.gh.repo('o', 'r'); return { ...result.data, rateLimit: result.rateLimit }; } } });
  own(t, repo, bridge);
  const first = await bridge.send('github/repo', { owner: 'o', repo: 'r' });
  assert.equal(first.ok, true);
  assert.deepEqual(h.gh.rateLimit(), { limit: 5000, remaining: 9, resetAt: 1_700_000_600_000, cached: false, offline: false });
  const limited = await h.gh.repo('other', 'r').catch((e: unknown) => e);
  assert.ok(limited instanceof GitHubError);
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.equal(limited.resetAt, 1_700_000_601_000);
  const cached = await h.gh.repo('o', 'r');
  assert.equal(cached.cached, true);
  assert.equal(cached.data.defaultBranch, 'main');
  const local = await bridge.send('repos/status', {});
  assert.equal(local.ok, true);
});

test('Kasus 8: retry policy, breaker probe, TTL, cap, mappings, and redaction', async () => {
  const h = client([new Error(`network ${TOKEN}`)]);
  await assert.rejects(() => h.gh.repo('o', 'r'));
  assert.deepEqual(h.sleeps, [500, 1000, 2000]);
  assert.equal(h.calls.length, 4);
  for (const status of [401, 404, 400]) {
    const x = client([response(status, { message: TOKEN })]);
    await assert.rejects(() => x.gh.repo('o', 'r'), (e: unknown) => { assert.ok(e instanceof GitHubError); assert.ok(!JSON.stringify(e).includes(TOKEN)); return true; });
    assert.equal(x.calls.length, 1);
    assert.deepEqual(x.sleeps, []);
  }
  const b = client([response(500, {})]);
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => b.gh.repo(`x${i}`, 'r'));
  assert.equal(b.gh.circuitOpen, true);
  const before = b.calls.length; await assert.rejects(() => b.gh.repo('fresh', 'r')); assert.equal(b.calls.length, before);
  const opened = b.gh.probe(); assert.equal(await opened, false);
  const cached = client([response(200, { default_branch: 'main', private: false, html_url: 'u' })]);
  await cached.gh.repo('o', 'r'); cached.advance(299_999); assert.equal((await cached.gh.repo('o', 'r')).cached, true); cached.advance(2); assert.equal((await cached.gh.repo('o', 'r')).cached, false);
  assert.equal(cached.gh.cacheSize, 1);
});

// --------------------------------------------- P07: pull request request budget

test('P07: one sidebar load issues one pulls request and a second read inside 60 s sends none', async () => {
  const h = client([response(200, [], { 'x-ratelimit-remaining': '59' })]);
  await h.gh.pullRequests('o', 'r');
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0] ?? '', /\/repos\/o\/r\/pulls\?state=open&per_page=50/);

  const second = await h.gh.pullRequests('o', 'r');
  assert.equal(h.calls.length, 1, 'the 60 s host cache answers, so the anonymous quota is untouched');
  assert.equal(second.cached, true);

  h.advance(60_001);
  await h.gh.pullRequests('o', 'r');
  assert.equal(h.calls.length, 2, 'past the TTL the next read goes to the network');
});

test('P07: the closed list is a separate cache key and fires once', async () => {
  const h = client([response(200, []), response(200, [])]);
  await h.gh.pullRequests('o', 'r', { state: 'open' });
  await h.gh.pullRequests('o', 'r', { state: 'closed' });
  assert.equal(h.calls.length, 2, 'open and closed do not share a cache entry');
  assert.match(h.calls[1] ?? '', /state=closed/);

  await h.gh.pullRequests('o', 'r', { state: 'closed' });
  assert.equal(h.calls.length, 2, 'a second expand inside the TTL sends nothing');
});

test('P07: a read without a token carries no Authorization header', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: null,
    fetchImpl: (url, init) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return Promise.resolve(response(200, []));
    },
  });
  await gh.pullRequests('o', 'r');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.headers.Authorization, undefined, 'anonymous stays anonymous');
  assert.equal(calls[0]?.headers['X-GitHub-Api-Version'], '2022-11-28', 'the version header is not the token');
});

test('P07: a quota refusal reports RATE_LIMITED with the reset timestamp the UI counts down', async () => {
  const h = client([
    response(403, { message: 'quota' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000600' }),
  ]);
  const failure = await h.gh.pullRequests('o', 'r').catch((e: unknown) => e);
  assert.ok(failure instanceof GitHubError);
  assert.equal(failure.code, 'RATE_LIMITED');
  assert.equal(failure.resetAt, 1_700_000_600_000);
});

// ---------------------------------------------------- P08: issues request budget

test('P08: bridge github/issues drops PR items, serves second call from cache, and maps RATE_LIMITED', async (t) => {
  const repo = await makeRepo({ label: 'p08-bridge' });
  const rawIssues = [
    { number: 1, title: 'Bug one', state: 'open', html_url: 'u', user: { login: 'me' } },
    { number: 2, title: 'A pull request', state: 'open', pull_request: { url: 'pr-url' } },
  ];
  const h = client([
    response(200, rawIssues, { 'x-ratelimit-remaining': '49' }),
    response(403, { message: 'quota' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000700' }),
  ]);
  const bridge = repo.harness({
    host: {
      githubIssues: async (payload) => {
        const result = await h.gh.issues(payload.owner, payload.repo, {
          filter: payload.filter,
          state: payload.state ?? 'open',
          login: 'me',
        });
        return { issues: result.data, rateLimit: result.rateLimit };
      },
    },
  });
  own(t, repo, bridge);

  const first = await bridge.send('github/issues', { owner: 'o', repo: 'r', filter: 'assigned' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const data = first.data as { issues: Array<{ number: number; title: string }> };
  assert.equal(data.issues.length, 1, 'PR item is dropped');
  assert.equal(data.issues[0]?.number, 1);

  // Second call within TTL served from cache
  const second = await bridge.send('github/issues', { owner: 'o', repo: 'r', filter: 'assigned' });
  assert.equal(second.ok, true);
  assert.equal(h.calls.length, 1, 'served from cache, no network hit');

  // Rate limit mapped to RATE_LIMITED
  const rateLimitFailure = await h.gh
    .issues('other', 'r', { filter: 'created', state: 'open', login: 'me' })
    .catch((e: unknown) => e);
  assert.ok(rateLimitFailure instanceof GitHubError);
  assert.equal(rateLimitFailure.code, 'RATE_LIMITED');
  assert.equal(rateLimitFailure.resetAt, 1_700_000_700_000);
});

// ------------------------------------------- P12: bridge refresh + revalidate

test('P12: github/pullRequests with refresh sends a conditional request and keeps cached false', async (t) => {
  const repo = await makeRepo({ label: 'p12-refresh' });
  const sent: Array<Record<string, string>> = [];
  let n = 0;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    sleep: async () => undefined,
    fetchImpl: (_url, init) => {
      sent.push(init.headers);
      n += 1;
      if (n === 1) {
        return Promise.resolve(
          response(200, [{ number: 1, title: 'one', state: 'open', html_url: 'u' }], {
            etag: 'W/"abc123"',
            'x-ratelimit-remaining': '49',
          }),
        );
      }
      return Promise.resolve(response(304, '', { 'x-ratelimit-remaining': '49' }));
    },
  });
  const bridge = repo.harness({
    host: {
      githubPullRequests: async (payload) => {
        const result = await gh.pullRequests(payload.owner, payload.repo, {
          state: payload.state ?? 'open',
          ...(payload.refresh === true ? { refresh: true } : {}),
        });
        return { pullRequests: result.data, rateLimit: gh.rateLimit(result.cached) };
      },
    },
  });
  own(t, repo, bridge);

  const first = await bridge.send('github/pullRequests', { owner: 'o', repo: 'r' });
  assert.equal(first.ok, true);
  assert.equal(sent[0]?.['If-None-Match'], undefined, 'the first read has nothing to revalidate');

  const refreshed = await bridge.send('github/pullRequests', { owner: 'o', repo: 'r', refresh: true });
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  const data = refreshed.data as { pullRequests: unknown[]; rateLimit: { cached: boolean } };
  assert.equal(sent.length, 2, 'refresh inside the TTL still goes to the network');
  assert.equal(sent[1]?.['If-None-Match'], 'W/"abc123"', 'and it is conditional');
  assert.equal(data.rateLimit.cached, false, 'a 304 is confirmed fresh, not a cache replay');
  assert.equal(data.pullRequests.length, 1, 'the stored payload still comes back');
});

test('P12: a 304 is not a failure, so repeated reloads never open the breaker', async (t) => {
  const repo = await makeRepo({ label: 'p12-breaker' });
  let n = 0;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    sleep: async () => undefined,
    fetchImpl: () =>
      Promise.resolve(
        n++ === 0
          ? response(200, [], { etag: 'W/"keep"' })
          : response(304, ''),
      ),
  });
  const bridge = repo.harness({
    host: {
      githubPullRequests: async (payload) => {
        const result = await gh.pullRequests(payload.owner, payload.repo, {
          state: payload.state ?? 'open',
          ...(payload.refresh === true ? { refresh: true } : {}),
        });
        return { pullRequests: result.data, rateLimit: gh.rateLimit(result.cached) };
      },
    },
  });
  own(t, repo, bridge);

  await bridge.send('github/pullRequests', { owner: 'o', repo: 'r' });
  for (let i = 0; i < 6; i += 1) {
    const reload = await bridge.send('github/pullRequests', { owner: 'o', repo: 'r', refresh: true });
    assert.equal(reload.ok, true, `reload ${i + 1} must succeed`);
  }
  assert.equal(gh.circuitOpen, false, 'a 304 is a success');
});

// ------------------------------------------------ P26: issue writes + cache

test('P26: create then list shows the new issue; close then Undo restores it', async (t) => {
  const repo = await makeRepo({ label: 'p26-issues' });
  const h = client([
    // 1. Initial GET /issues (open)
    response(200, [{ number: 97, title: 'Existing issue', state: 'open', html_url: 'https://github.com/o/r/issues/97', user: { login: 'me' } }]),
    // 2. POST /issues (create #98)
    response(201, { number: 98, html_url: 'https://github.com/o/r/issues/98' }),
    // 3. GET /issues after create (cache was invalidated, returns #98 and #97)
    response(200, [
      { number: 98, title: 'New issue', state: 'open', html_url: 'https://github.com/o/r/issues/98', user: { login: 'me' }, labels: [{ name: 'bug', color: 'd73a4a' }] },
      { number: 97, title: 'Existing issue', state: 'open', html_url: 'https://github.com/o/r/issues/97', user: { login: 'me' } },
    ]),
    // 4. PATCH /issues/97 (close)
    response(200, { number: 97, state: 'closed', state_reason: 'completed' }),
    // 5. GET /issues after close (cache invalidated, only #98 open)
    response(200, [
      { number: 98, title: 'New issue', state: 'open', html_url: 'https://github.com/o/r/issues/98', user: { login: 'me' } },
    ]),
    // 6. PATCH /issues/97 (Undo -> reopen)
    response(200, { number: 97, state: 'open', state_reason: 'reopened' }),
    // 7. GET /issues after reopen (cache invalidated, #98 and #97 both open again)
    response(200, [
      { number: 98, title: 'New issue', state: 'open', html_url: 'https://github.com/o/r/issues/98', user: { login: 'me' } },
      { number: 97, title: 'Existing issue', state: 'open', state_reason: 'reopened', html_url: 'https://github.com/o/r/issues/97', user: { login: 'me' } },
    ]),
  ]);

  const bridge = repo.harness({
    host: {
      githubWriteContext: async () => ({
        connected: true,
        scopes: ['repo'],
        tokenAllowed: true,
        circuitOpen: h.gh.circuitOpen,
      }),
      githubIssues: async (payload) => {
        const result = await h.gh.issues(payload.owner, payload.repo, {
          filter: payload.filter,
          state: payload.state ?? 'open',
          login: 'me',
        });
        return { issues: result.data, rateLimit: h.gh.rateLimit(result.cached) };
      },
      githubCreateIssue: async (payload) => {
        return (
          await h.gh.createIssue(payload.owner, payload.repo, {
            title: payload.title,
            body: payload.body,
            labels: payload.labels,
          })
        ).data;
      },
      githubSetIssueState: async (payload) => {
        return (await h.gh.setIssueState(payload.owner, payload.repo, payload.number, payload.state)).data;
      },
    },
  });
  own(t, repo, bridge);

  // 1. List initial issues (caches response 1)
  const list1 = await bridge.send('github/issues', { owner: 'o', repo: 'r', filter: 'created' });
  assert.equal(list1.ok, true);
  if (!list1.ok) return;
  const data1 = list1.data as { issues: Array<{ number: number }> };
  assert.deepEqual(data1.issues.map((i) => i.number), [97]);

  // 2. Create #98 (invalidates cache) -> next list hits network and shows #98
  const created = await bridge.send('github/createIssue', {
    owner: 'o',
    repo: 'r',
    title: 'New issue',
    body: 'Details',
    labels: ['bug'],
    idempotencyKey: 'e2e-cr-98',
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const createdData = created.data as { number: number; htmlUrl: string };
  assert.equal(createdData.number, 98);

  const list2 = await bridge.send('github/issues', { owner: 'o', repo: 'r', filter: 'created' });
  assert.equal(list2.ok, true);
  if (!list2.ok) return;
  const data2 = list2.data as { issues: Array<{ number: number }> };
  assert.deepEqual(data2.issues.map((i) => i.number), [98, 97], 'new issue appears in list after create invalidates cache');

  // 3. Close #97 -> list shows only #98 open
  const closed = await bridge.send('github/setIssueState', {
    owner: 'o',
    repo: 'r',
    number: 97,
    state: 'closed',
    idempotencyKey: 'e2e-close-97',
  });
  assert.equal(closed.ok, true);

  const list3 = await bridge.send('github/issues', { owner: 'o', repo: 'r', filter: 'created' });
  assert.equal(list3.ok, true);
  if (!list3.ok) return;
  const data3 = list3.data as { issues: Array<{ number: number }> };
  assert.deepEqual(data3.issues.map((i) => i.number), [98]);

  // 4. Undo (reopen #97) -> list restores #97
  const reopened = await bridge.send('github/setIssueState', {
    owner: 'o',
    repo: 'r',
    number: 97,
    state: 'open',
    idempotencyKey: 'e2e-reopen-97',
  });
  assert.equal(reopened.ok, true);

  const list4 = await bridge.send('github/issues', { owner: 'o', repo: 'r', filter: 'created' });
  assert.equal(list4.ok, true);
  if (!list4.ok) return;
  const data4 = list4.data as { issues: Array<{ number: number }> };
  assert.deepEqual(data4.issues.map((i) => i.number), [98, 97], 'Undo restores closed issue to open list');
});

test('P27: Actions workflowInputs -> dispatch -> 2-poll match and rerunFailed refusal/execution with cache invalidation', async (t) => {
  const repo = await makeRepo({ label: 'p27-actions-e2e' });
  const workflowYaml = [
    'name: Release',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      version:',
    "        description: 'Release tag'",
    '        required: true',
    '        type: string',
    '      target:',
    "        description: 'Target environment'",
    '        required: true',
    '        type: choice',
    "        default: 'staging'",
    '        options: [staging, prod]',
  ].join('\n');

  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  const queue: FetchResponseLike[] = [
    // 1. GET /workflows for workflowInputs
    response(200, {
      total_count: 1,
      workflows: [{ id: 10, name: 'Release', path: '.github/workflows/release.yml', state: 'active' }],
    }),
    // 2. GET /contents/.github/workflows/release.yml?ref=main
    response(200, {
      encoding: 'base64',
      size: Buffer.byteLength(workflowYaml, 'utf8'),
      content: Buffer.from(workflowYaml, 'utf8').toString('base64'),
    }),
    // 3. POST /workflows/10/dispatches (workflows call hits cache)
    { status: 204, ok: true, headers: headers({}), text: () => Promise.resolve('') },
    // 4. First poll: GET /actions/runs -> empty
    response(200, { workflow_runs: [] }),
    // 5. Second poll after 5 s (past 0 s or TTL expired after advance): GET /actions/runs -> new workflow_dispatch run
    response(200, {
      workflow_runs: [
        {
          id: 901,
          workflow_id: 10,
          name: 'Release',
          display_title: 'Release',
          run_number: 12,
          event: 'workflow_dispatch',
          status: 'queued',
          conclusion: null,
          head_branch: 'main',
          head_sha: 'b'.repeat(40),
          html_url: 'https://github.com/o/r/actions/runs/901',
          created_at: '2026-11-20T12:00:05.000Z',
          run_started_at: null,
          updated_at: '2026-11-20T12:00:05.000Z',
          run_attempt: 1,
        },
      ],
    }),
    // 6. GET /actions/runs/481 for rerun refusal (completed + success)
    response(200, {
      id: 481,
      workflow_id: 10,
      name: 'Release',
      display_title: 'Release',
      run_number: 10,
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: 'a'.repeat(40),
      html_url: 'https://github.com/o/r/actions/runs/481',
      created_at: '2026-11-20T10:00:00.000Z',
      run_started_at: '2026-11-20T10:00:05.000Z',
      updated_at: '2026-11-20T10:01:00.000Z',
      run_attempt: 1,
    }),
    // 7. GET /actions/runs/482 for rerun execution (completed + failure)
    response(200, {
      id: 482,
      workflow_id: 10,
      name: 'Release',
      display_title: 'Release',
      run_number: 11,
      event: 'push',
      status: 'completed',
      conclusion: 'failure',
      head_branch: 'main',
      head_sha: 'c'.repeat(40),
      html_url: 'https://github.com/o/r/actions/runs/482',
      created_at: '2026-11-20T11:00:00.000Z',
      run_started_at: '2026-11-20T11:00:05.000Z',
      updated_at: '2026-11-20T11:01:00.000Z',
      run_attempt: 1,
    }),
    // 8. POST /actions/runs/482/rerun-failed-jobs -> 201 (invalidates runs: and jobs:)
    { status: 201, ok: true, headers: headers({}), text: () => Promise.resolve('') },
    // 9. Subsequent GET /actions/runs hits network (not cached) after invalidation
    response(200, {
      workflow_runs: [
        {
          id: 482,
          workflow_id: 10,
          name: 'Release',
          display_title: 'Release',
          run_number: 11,
          event: 'push',
          status: 'in_progress',
          conclusion: null,
          head_branch: 'main',
          head_sha: 'c'.repeat(40),
          html_url: 'https://github.com/o/r/actions/runs/482',
          created_at: '2026-11-20T11:00:00.000Z',
          run_started_at: '2026-11-20T11:00:05.000Z',
          updated_at: '2026-11-20T12:01:10.000Z',
          run_attempt: 2,
        },
      ],
    }),
  ];

  let clock = Date.parse('2026-11-20T12:00:00.000Z');
  let qIdx = 0;
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: TOKEN,
    now: () => clock,
    sleep: async () => {},
    fetchImpl: (url, init) => {
      const i = init as { method?: string; body?: string } | undefined;
      calls.push({ url, method: i?.method ?? 'GET', body: typeof i?.body === 'string' ? i.body : undefined });
      const next = queue[qIdx++];
      return next ? Promise.resolve(next) : Promise.reject(new Error(`unexpected fetch: ${url}`));
    },
  });

  const bridge = repo.harness({
    host: {
      githubWriteContext: async () => ({
        connected: true,
        scopes: ['repo'],
        tokenAllowed: true,
        circuitOpen: gh.circuitOpen,
      }),
      githubActionsWorkflows: async (p) => gh.workflows(p.owner, p.repo),
      githubActionsRun: async (p) => gh.workflowRun(p.owner, p.repo, p.runId),
      githubActionsRuns: async (p) => {
        const res = await gh.workflowRuns(p.owner, p.repo, {
          ...(p.branch === undefined ? {} : { branch: p.branch }),
          ...(p.workflowId === undefined ? {} : { workflowId: p.workflowId }),
          ...(p.perPage === undefined ? {} : { perPage: p.perPage }),
          ...(p.refresh === undefined ? {} : { refresh: p.refresh }),
        });
        return { runs: res.data, workflows: [], rateLimit: gh.rateLimit(res.cached) };
      },
      githubWorkflowInputs: async (p) => {
        const wfs = await gh.workflows(p.owner, p.repo);
        const wf = wfs.data.find((w) => w.id === p.workflowId);
        assert.ok(wf);
        const file = await gh.workflowFile(p.owner, p.repo, wf.path, p.ref);
        const parsed = parseDispatchInputs(file.data);
        return {
          inputs: parsed ?? [],
          parsed: parsed !== null,
          webUrl: workflowWebUrl('github.com', p.owner, p.repo, wf.path),
          rateLimit: gh.rateLimit(file.cached),
        };
      },
      githubDispatchWorkflow: async (p) => {
        const res = await gh.dispatchWorkflow(p.owner, p.repo, p.workflowId, {
          ref: p.ref,
          ...(p.inputs === undefined ? {} : { inputs: p.inputs }),
        });
        return res.data;
      },
      githubRerunFailed: async (p) => (await gh.rerunFailedJobs(p.owner, p.repo, p.runId)).data,
    },
  });
  own(t, repo, bridge);

  // 1. Read and parse workflow_dispatch inputs
  const inputsRes = await bridge.send('github/workflowInputs', {
    owner: 'o',
    repo: 'r',
    workflowId: 10,
    ref: 'main',
  });
  assert.equal(inputsRes.ok, true);
  if (!inputsRes.ok) return;
  const inputsData = inputsRes.data as WorkflowInputsResult;
  assert.equal(inputsData.parsed, true);
  assert.equal(inputsData.webUrl, 'https://github.com/o/r/actions/workflows/release.yml');
  assert.deepEqual(inputsData.inputs.map((x) => x.name), ['version', 'target']);

  // 2. Dispatch workflow with confirm: true and inputs
  const dispRes = await bridge.send('github/dispatchWorkflow', {
    owner: 'o',
    repo: 'r',
    workflowId: 10,
    ref: 'main',
    inputs: { version: '2.8.0', target: 'prod' },
    confirm: true,
    idempotencyKey: 'e2e-p27-disp',
  });
  assert.equal(dispRes.ok, true);
  if (!dispRes.ok) return;
  const dispData = dispRes.data as DispatchWorkflowResult;
  assert.equal(dispData.dispatched, true);
  const postDispatch = calls.find((c) => c.method === 'POST' && c.url.endsWith('/dispatches'));
  assert.equal(postDispatch?.body, JSON.stringify({ ref: 'main', inputs: { version: '2.8.0', target: 'prod' } }));

  // 3. Two polls: first poll empty, second poll at +5s with refresh:true bypasses 60s cache and finds new workflow_dispatch run
  const poll1 = await bridge.send('github/actionsRuns', { owner: 'o', repo: 'r', refresh: true });
  assert.equal(poll1.ok, true);
  if (!poll1.ok) return;
  assert.equal(
    matchDispatchedRun((poll1.data as ActionsRunsResult).runs, { workflowId: 10, branch: 'main', since: dispData.at }),
    null,
  );

  clock += 5_000;
  const poll2 = await bridge.send('github/actionsRuns', { owner: 'o', repo: 'r', refresh: true });
  assert.equal(poll2.ok, true);
  if (!poll2.ok) return;
  const matched = matchDispatchedRun((poll2.data as ActionsRunsResult).runs, {
    workflowId: 10,
    branch: 'main',
    since: dispData.at,
  });
  assert.equal(matched?.id, 901);

  // 4. Re-run refused on success run (no POST sent)
  const badRerun = await bridge.send('github/rerunFailedJobs', {
    owner: 'o',
    repo: 'r',
    runId: 481,
    idempotencyKey: 'e2e-p27-rr-ok',
  });
  assert.equal(badRerun.ok, false);
  if (!badRerun.ok) assert.equal(badRerun.error.code, 'VALIDATION_ERROR');
  assert.equal(calls.filter((c) => c.url.endsWith('/rerun-failed-jobs')).length, 0);

  // 5. Re-run succeeds on failure run and invalidates runs cache immediately without advancing clock
  const goodRerun = await bridge.send('github/rerunFailedJobs', {
    owner: 'o',
    repo: 'r',
    runId: 482,
    idempotencyKey: 'e2e-p27-rr-fail',
  });
  assert.equal(goodRerun.ok, true);
  assert.equal(calls.filter((c) => c.url.endsWith('/rerun-failed-jobs')).length, 1);

  const afterRerun = await bridge.send('github/actionsRuns', { owner: 'o', repo: 'r' });
  assert.equal(afterRerun.ok, true);
  if (!afterRerun.ok) return;
  const afterData = afterRerun.data as ActionsRunsResult;
  assert.equal(afterData.runs[0]?.status, 'in_progress');
  assert.equal(afterData.rateLimit.cached, false, 'rerunFailedJobs invalidated cached workflow runs');
});
