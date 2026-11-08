/**
 * Actions view contracts (P13).
 *
 * Starts with the request validators: the two new kinds carry user-influenced
 * values into a URL path, so every field is checked here before the bridge hands
 * it to the host. Model tests are added beside them as the view model lands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRunId,
  validateActionsJobsPayload,
  validateActionsRunsPayload,
} from '../src/bridgePure';

/** Collector that records the first failing detail instead of throwing. */
function checker(): { fail(detail: string): never; details: string[] } {
  const details: string[] = [];
  return {
    details,
    fail(detail: string): never {
      details.push(detail);
      throw new Error(detail);
    },
  };
}

function runsFails(payload: Parameters<typeof validateActionsRunsPayload>[0]): string | null {
  const c = checker();
  try {
    validateActionsRunsPayload(payload, c.fail);
    return null;
  } catch {
    return c.details[0] ?? 'unknown';
  }
}

function jobsFails(payload: Parameters<typeof validateActionsJobsPayload>[0]): string | null {
  const c = checker();
  try {
    validateActionsJobsPayload(payload, c.fail);
    return null;
  } catch {
    return c.details[0] ?? 'unknown';
  }
}

// ------------------------------------------------------------------- isRunId

test('isRunId accepts positive safe integers only', () => {
  assert.equal(isRunId(1), true);
  assert.equal(isRunId(9_007_199_254_740_991), true);
  assert.equal(isRunId(0), false, 'zero is not a run id');
  assert.equal(isRunId(-3), false);
  assert.equal(isRunId(1.5), false, 'a fractional id cannot come from the API');
  assert.equal(isRunId(Number.NaN), false);
  assert.equal(isRunId(Number.POSITIVE_INFINITY), false);
  assert.equal(isRunId('123'), false, 'a numeric string is not a number');
  assert.equal(isRunId(null), false);
  assert.equal(isRunId(undefined), false);
});

// ------------------------------------------------------- validateActionsRuns

test('a minimal runs payload passes', () => {
  assert.equal(runsFails({ owner: 'o', repo: 'r' }), null);
});

test('owner and repo must be slugs', () => {
  assert.equal(runsFails({ owner: 'o wner', repo: 'r' }), 'owner/repo');
  assert.equal(runsFails({ owner: 'o', repo: '' }), 'owner/repo');
  assert.equal(runsFails({ owner: 7 as unknown as string, repo: 'r' }), 'owner/repo');
});

test('branch is validated with the git ref rules', () => {
  assert.equal(runsFails({ owner: 'o', repo: 'r', branch: 'feat/graph-ribbons' }), null);
  assert.equal(runsFails({ owner: 'o', repo: 'r', branch: '-flag' }), 'branch', 'option injection');
  assert.equal(runsFails({ owner: 'o', repo: 'r', branch: 'a..b' }), 'branch');
  assert.equal(runsFails({ owner: 'o', repo: 'r', branch: '' }), 'branch');
});

test('workflowId must be a positive integer', () => {
  assert.equal(runsFails({ owner: 'o', repo: 'r', workflowId: 12 }), null);
  assert.equal(runsFails({ owner: 'o', repo: 'r', workflowId: 0 }), 'workflowId');
  assert.equal(runsFails({ owner: 'o', repo: 'r', workflowId: -1 }), 'workflowId');
  assert.equal(runsFails({ owner: 'o', repo: 'r', workflowId: 1.5 }), 'workflowId');
  assert.equal(runsFails({ owner: 'o', repo: 'r', workflowId: '12' as unknown as number }), 'workflowId');
});

test('perPage is bounded to 1..50', () => {
  assert.equal(runsFails({ owner: 'o', repo: 'r', perPage: 1 }), null);
  assert.equal(runsFails({ owner: 'o', repo: 'r', perPage: 50 }), null);
  assert.equal(runsFails({ owner: 'o', repo: 'r', perPage: 0 }), 'perPage');
  assert.equal(runsFails({ owner: 'o', repo: 'r', perPage: 51 }), 'perPage');
  assert.equal(runsFails({ owner: 'o', repo: 'r', perPage: 2.5 }), 'perPage');
});

// ------------------------------------------------------- validateActionsJobs

test('a jobs payload needs slugs and a run id', () => {
  assert.equal(jobsFails({ owner: 'o', repo: 'r', runId: 42 }), null);
  assert.equal(jobsFails({ owner: 'o/r', repo: 'r', runId: 42 }), 'owner/repo');
  assert.equal(jobsFails({ owner: 'o', repo: 'r', runId: 0 }), 'runId');
  assert.equal(jobsFails({ owner: 'o', repo: 'r', runId: 4.2 }), 'runId');
  assert.equal(jobsFails({ owner: 'o', repo: 'r', runId: '42' as unknown as number }), 'runId');
});

// =============================================================== client (T03)

import { GitHubClient, GitHubError, type FetchLike, type FetchResponseLike } from '../src/github';

const RATE_HEADERS = {
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4999',
  'x-ratelimit-reset': '1700000600',
};

function headers(map: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function response(status: number, body: unknown, extra: Record<string, string> = {}): FetchResponseLike {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headers({ ...RATE_HEADERS, ...extra }),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function fakeClient(queue: Array<FetchResponseLike | Error>): {
  gh: GitHubClient;
  calls: Array<{ url: string; headers: Record<string, string> }>;
  advance(ms: number): void;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let index = 0;
  let clock = 1_700_000_000_000;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = queue[Math.min(index, queue.length - 1)];
    index += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next as FetchResponseLike);
  };
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_secret',
    fetchImpl,
    now: () => clock,
    sleep: () => Promise.resolve(),
  });
  return {
    gh,
    calls,
    advance: (ms) => {
      clock += ms;
    },
  };
}

function runBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 482,
    workflow_id: 12,
    name: 'CI',
    display_title: 'fix(graph): cull nodes',
    run_number: 482,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'feat/graph-ribbons',
    head_sha: '9f8e7d6'.padEnd(40, '0'),
    html_url: 'https://github.com/o/r/actions/runs/482',
    created_at: '2026-11-01T10:00:00Z',
    run_started_at: '2026-11-01T10:00:05Z',
    updated_at: '2026-11-01T10:03:57Z',
    run_attempt: 1,
    ...patch,
  };
}

test('workflowRuns builds the plain runs path with encoding and excludes nothing', async () => {
  const h = fakeClient([response(200, { total_count: 1, workflow_runs: [runBody()] })]);
  const result = await h.gh.workflowRuns('o', 'r', { perPage: 30 });
  assert.equal(
    h.calls[0]?.url,
    'https://api.github.com/repos/o/r/actions/runs?per_page=30&exclude_pull_requests=false',
  );
  assert.equal(result.data.length, 1);
  const run = result.data[0];
  assert.ok(run);
  assert.equal(run.id, 482);
  assert.equal(run.workflowId, 12);
  assert.equal(run.name, 'CI');
  assert.equal(run.title, 'fix(graph): cull nodes');
  assert.equal(run.runNumber, 482);
  assert.equal(run.event, 'push');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.branch, 'feat/graph-ribbons');
  assert.equal(run.sha.length, 40);
  assert.equal(run.url, 'https://github.com/o/r/actions/runs/482');
  assert.equal(run.startedAt, '2026-11-01T10:00:05Z');
  assert.equal(run.attempt, 1);
});

test('workflowRuns adds the branch filter and encodes it', async () => {
  const h = fakeClient([response(200, { workflow_runs: [] })]);
  await h.gh.workflowRuns('o', 'r', { branch: 'feat/a b', perPage: 5 });
  assert.equal(
    h.calls[0]?.url,
    'https://api.github.com/repos/o/r/actions/runs?per_page=5&exclude_pull_requests=false&branch=feat%2Fa%20b',
  );
});

test('a workflowId switches to the per-workflow route and skips the branch query', async () => {
  const h = fakeClient([response(200, { workflow_runs: [] })]);
  await h.gh.workflowRuns('o', 'r', { workflowId: 12, branch: 'main', perPage: 30 });
  assert.equal(
    h.calls[0]?.url,
    'https://api.github.com/repos/o/r/actions/workflows/12/runs?per_page=30',
  );
});

test('perPage is clamped to 1..100 on the client side too', async () => {
  const h = fakeClient([response(200, { workflow_runs: [] })]);
  await h.gh.workflowRuns('o', 'r', { perPage: 999 });
  assert.match(h.calls[0]?.url ?? '', /per_page=100/);
});

test('unknown status and conclusion map to pending and null, never throw', async () => {
  const h = fakeClient([
    response(200, {
      workflow_runs: [
        runBody({ status: 'teleported', conclusion: 'confused' }),
        runBody({ id: 2, conclusion: null }),
      ],
    }),
  ]);
  const result = await h.gh.workflowRuns('o', 'r', {});
  assert.equal(result.data[0]?.status, 'pending');
  assert.equal(result.data[0]?.conclusion, null);
  assert.equal(result.data[1]?.status, 'completed');
  assert.equal(result.data[1]?.conclusion, null);
});

test('a non-https html_url is dropped so no link is rendered', async () => {
  const h = fakeClient([
    response(200, {
      workflow_runs: [
        runBody({ html_url: 'javascript:alert(1)' }),
        runBody({ id: 3, html_url: 'http://example.com/x' }),
        runBody({ id: 4, html_url: 42 }),
      ],
    }),
  ]);
  const result = await h.gh.workflowRuns('o', 'r', {});
  assert.deepEqual(result.data.map((r) => r.url), ['', '', '']);
});

test('numbers outside the safe integer range are dropped', async () => {
  const h = fakeClient([
    response(200, {
      workflow_runs: [
        runBody({ id: Number.MAX_SAFE_INTEGER + 10, workflow_id: 'nope', run_number: -1, run_attempt: 1.5 }),
      ],
    }),
  ]);
  const run = (await h.gh.workflowRuns('o', 'r', {})).data[0];
  assert.equal(run?.id, 0);
  assert.equal(run?.workflowId, 0);
  assert.equal(run?.runNumber, 0);
  assert.equal(run?.attempt, 1, 'a fractional attempt falls back to 1');
});

test('runs are cached 60 s while every run is finished', async () => {
  const h = fakeClient([response(200, { workflow_runs: [runBody()] })]);
  await h.gh.workflowRuns('o', 'r', {});
  const again = await h.gh.workflowRuns('o', 'r', {});
  assert.equal(h.calls.length, 1);
  assert.equal(again.cached, true);
});

test('runs are cached only 15 s while one is still running', async () => {
  const h = fakeClient([
    response(200, { workflow_runs: [runBody({ status: 'in_progress', conclusion: null })] }),
  ]);
  await h.gh.workflowRuns('o', 'r', {});
  h.advance(20_000);
  await h.gh.workflowRuns('o', 'r', {});
  assert.equal(h.calls.length, 2, 'the 15 s TTL already expired');
});

test('workflows lists the repository workflows with a 300 s TTL', async () => {
  const body = {
    total_count: 1,
    workflows: [{ id: 12, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }],
  };
  const h = fakeClient([response(200, body)]);
  const first = await h.gh.workflows('o', 'r');
  assert.equal(
    h.calls[0]?.url,
    'https://api.github.com/repos/o/r/actions/workflows?per_page=100',
  );
  assert.deepEqual(first.data, [
    { id: 12, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  ]);
  h.advance(200_000);
  const second = await h.gh.workflows('o', 'r');
  assert.equal(second.cached, true, 'still inside 300 s');
  h.advance(200_000);
  await h.gh.workflows('o', 'r');
  assert.equal(h.calls.length, 2);
});

test('runJobs keeps step order and maps the job fields', async () => {
  const body = {
    total_count: 1,
    jobs: [
      {
        id: 900,
        name: 'build / ubuntu',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-11-01T10:00:05Z',
        completed_at: '2026-11-01T10:01:17Z',
        html_url: 'https://github.com/o/r/actions/runs/482/job/900',
        steps: [
          { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
          { number: 2, name: 'npm test', status: 'completed', conclusion: 'failure' },
        ],
      },
    ],
  };
  const h = fakeClient([response(200, body)]);
  const jobs = await h.gh.runJobs('o', 'r', 482);
  assert.equal(
    h.calls[0]?.url,
    'https://api.github.com/repos/o/r/actions/runs/482/jobs?filter=latest&per_page=100',
  );
  const job = jobs.data[0];
  assert.ok(job);
  assert.equal(job.name, 'build / ubuntu');
  assert.deepEqual(job.steps.map((s) => s.number), [1, 2]);
  assert.deepEqual(job.steps.map((s) => s.name), ['Set up job', 'npm test']);
  assert.equal(job.completedAt, '2026-11-01T10:01:17Z');
});

test('a 404 from the runs endpoint maps to NOT_FOUND', async () => {
  const h = fakeClient([response(404, { message: 'Not Found' })]);
  await assert.rejects(() => h.gh.workflowRuns('o', 'r', {}), (err: unknown) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.code, 'NOT_FOUND');
    return true;
  });
});

test('the breaker serves stale runs instead of failing', async () => {
  const queue: Array<FetchResponseLike | Error> = [response(200, { workflow_runs: [runBody()] })];
  const rec: Array<{ url: string }> = [];
  let index = 0;
  let clock = 1_700_000_000_000;
  const fetchImpl: FetchLike = (url) => {
    rec.push({ url });
    const next = queue[Math.min(index, queue.length - 1)];
    index += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next as FetchResponseLike);
  };
  const gh = new GitHubClient({
    apiUrl: 'https://api.github.com',
    token: 'ghp_secret',
    fetchImpl,
    now: () => clock,
    sleep: () => Promise.resolve(),
  });
  await gh.workflowRuns('o', 'r', {});
  queue[0] = response(500, { message: 'boom' });
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => gh.workflowRuns(`x${i}`, 'r', {}));
  assert.equal(gh.circuitOpen, true);
  const before = rec.length;
  clock += 600_000;
  const stale = await gh.workflowRuns('o', 'r', {});
  assert.equal(rec.length, before, 'no request while the circuit is open');
  assert.equal(stale.cached, true);
  assert.equal(stale.data[0]?.id, 482);
});
