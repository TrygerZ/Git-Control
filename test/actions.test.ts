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

test('a workflowId switches to the per-workflow route and includes the branch query', async () => {
  const h = fakeClient([response(200, { workflow_runs: [] })]);
  await h.gh.workflowRuns('o', 'r', { workflowId: 12, branch: 'main', perPage: 30 });
  assert.equal(
    h.calls[0]?.url,
    'https://api.github.com/repos/o/r/actions/workflows/12/runs?per_page=30&branch=main',
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

  // The 15 s active TTL would have expired by now; the finished one must not.
  h.advance(20_000);
  const later = await h.gh.workflowRuns('o', 'r', {});
  assert.equal(h.calls.length, 1, 'still inside 60 s');
  assert.equal(later.cached, true);

  h.advance(45_000);
  await h.gh.workflowRuns('o', 'r', {});
  assert.equal(h.calls.length, 2, 'past 60 s the read is real');
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

// =========================================================== pure model (T06)

import {
  branchesWithRuns,
  durationText,
  failingDot,
  filterByWorkflow,
  groupRuns,
  metaLine,
  needsPolling,
  toneOf,
  ALL_BRANCHES_CAP,
  formatDuration,
  runRowLabel,
  statusWord,
} from '../src/webview/actionsModel';
import type { WorkflowRunInfo } from '../src/messages';

function run(patch: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo {
  return {
    id: 1,
    workflowId: 12,
    name: 'CI',
    title: 'fix(graph): cull nodes',
    runNumber: 482,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    branch: 'main',
    sha: '9f8e7d6'.padEnd(40, '0'),
    url: 'https://github.com/o/r/actions/runs/1',
    createdAt: '2026-11-01T10:00:00Z',
    startedAt: '2026-11-01T10:00:05Z',
    updatedAt: '2026-11-01T10:03:57Z',
    attempt: 1,
    ...patch,
  };
}

// ------------------------------------------------------------------- toneOf

test('toneOf maps every status and conclusion the view can draw', () => {
  assert.equal(toneOf({ status: 'completed', conclusion: 'success' }), 'success');
  assert.equal(toneOf({ status: 'completed', conclusion: 'failure' }), 'danger');
  assert.equal(toneOf({ status: 'completed', conclusion: 'timed_out' }), 'danger');
  assert.equal(toneOf({ status: 'completed', conclusion: 'startup_failure' }), 'danger');
  assert.equal(toneOf({ status: 'completed', conclusion: 'action_required' }), 'warning');
  assert.equal(toneOf({ status: 'in_progress', conclusion: null }), 'running');
  assert.equal(toneOf({ status: 'queued', conclusion: null }), 'queued');
  assert.equal(toneOf({ status: 'waiting', conclusion: null }), 'queued');
  assert.equal(toneOf({ status: 'requested', conclusion: null }), 'queued');
  assert.equal(toneOf({ status: 'pending', conclusion: null }), 'queued');
  assert.equal(toneOf({ status: 'completed', conclusion: 'cancelled' }), 'neutral');
  assert.equal(toneOf({ status: 'completed', conclusion: 'skipped' }), 'neutral');
  assert.equal(toneOf({ status: 'completed', conclusion: 'neutral' }), 'neutral');
  assert.equal(toneOf({ status: 'completed', conclusion: 'stale' }), 'neutral');
  assert.equal(toneOf({ status: 'completed', conclusion: null }), 'neutral');
});

test('a running status wins over a stale conclusion', () => {
  // The API can report in_progress with the previous attempt's conclusion.
  assert.equal(toneOf({ status: 'in_progress', conclusion: 'failure' }), 'running');
});

// ----------------------------------------------------------------- groupRuns

test('groupRuns splits on the current branch and keeps GitHub order', () => {
  const runs = [
    run({ id: 1, branch: 'main' }),
    run({ id: 2, branch: 'feat/a' }),
    run({ id: 3, branch: 'main' }),
  ];
  const groups = groupRuns(runs, 'main');
  assert.deepEqual(groups.thisBranch.map((r) => r.id), [1, 3]);
  assert.deepEqual(groups.others.map((r) => r.id), [2]);
});

test('groupRuns with no current branch puts everything in others', () => {
  const runs = [run({ id: 1, branch: 'main' }), run({ id: 2, branch: null })];
  const groups = groupRuns(runs, null);
  assert.deepEqual(groups.thisBranch, []);
  assert.deepEqual(groups.others.map((r) => r.id), [1, 2]);
});

test('groupRuns puts every run in others when the branch has none', () => {
  const groups = groupRuns([run({ id: 1, branch: 'other' })], 'main');
  assert.deepEqual(groups.thisBranch, []);
  assert.equal(groups.others.length, 1);
});

test('groupRuns caps the All branches group at 20', () => {
  const runs = Array.from({ length: 25 }, (_, i) => run({ id: i + 1, branch: 'other' }));
  const groups = groupRuns(runs, 'main');
  assert.equal(groups.others.length, ALL_BRANCHES_CAP);
  assert.deepEqual(groups.others.map((r) => r.id), runs.slice(0, 20).map((r) => r.id));
});

test('a run whose branch is null never lands in This branch', () => {
  const groups = groupRuns([run({ id: 1, branch: null })], 'main');
  assert.deepEqual(groups.thisBranch, []);
});

// ----------------------------------------------------------- branchesWithRuns

test('branchesWithRuns lists each branch once with the current branch first', () => {
  const runs = [
    run({ id: 1, branch: 'feat/a' }),
    run({ id: 2, branch: 'main' }),
    run({ id: 3, branch: 'feat/a' }),
    run({ id: 4, branch: null }),
  ];
  assert.deepEqual(branchesWithRuns(runs, 'main'), ['main', 'feat/a']);
  assert.deepEqual(branchesWithRuns(runs, null), ['feat/a', 'main'], 'first-seen order, nulls dropped');
});

test('branchesWithRuns keeps the current branch even when it has no runs', () => {
  assert.deepEqual(branchesWithRuns([run({ id: 1, branch: 'x' })], 'main'), ['main', 'x']);
});

// ------------------------------------------------------------ filterByWorkflow

test('filterByWorkflow keeps only the chosen workflow, or everything for null', () => {
  const runs = [run({ id: 1, workflowId: 12 }), run({ id: 2, workflowId: 13 })];
  assert.deepEqual(filterByWorkflow(runs, null).map((r) => r.id), [1, 2]);
  assert.deepEqual(filterByWorkflow(runs, 13).map((r) => r.id), [2]);
});

// ------------------------------------------------------------------ failingDot

test('failingDot looks at the newest completed run on the current branch', () => {
  assert.equal(
    failingDot([run({ status: 'completed', conclusion: 'failure' })], 'main'),
    true,
  );
  assert.equal(failingDot([run({ status: 'completed', conclusion: 'success' })], 'main'), false);
});

test('failingDot counts timed_out and startup_failure, not cancelled or skipped', () => {
  for (const conclusion of ['timed_out', 'startup_failure'] as const) {
    assert.equal(failingDot([run({ conclusion })], 'main'), true, conclusion);
  }
  for (const conclusion of ['cancelled', 'skipped', 'neutral', 'stale', 'action_required'] as const) {
    assert.equal(failingDot([run({ conclusion })], 'main'), false, conclusion);
  }
});

test('failingDot skips a run that is still going in favour of the last completed one', () => {
  const runs = [
    run({ id: 1, status: 'in_progress', conclusion: null }),
    run({ id: 2, status: 'completed', conclusion: 'failure' }),
  ];
  assert.equal(failingDot(runs, 'main'), true);
});

test('failingDot is false with no runs, no current branch, or only other branches', () => {
  assert.equal(failingDot([], 'main'), false);
  assert.equal(failingDot([run({ conclusion: 'failure' })], null), false);
  assert.equal(failingDot([run({ conclusion: 'failure', branch: 'other' })], 'main'), false);
});

// ----------------------------------------------------------------- needsPolling

test('needsPolling is true while any run is not completed', () => {
  assert.equal(needsPolling([run({ status: 'in_progress', conclusion: null })]), true);
  assert.equal(needsPolling([run({ status: 'queued', conclusion: null })]), true);
  assert.equal(needsPolling([run(), run({ status: 'waiting', conclusion: null })]), true);
  assert.equal(needsPolling([run()]), false);
  assert.equal(needsPolling([]), false);
});

// --------------------------------------------------------------- durationText

test('durationText reports a completed run from startedAt to updatedAt', () => {
  const r = run({
    startedAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:03:52Z',
  });
  assert.equal(durationText(r, Date.parse('2026-11-02T00:00:00Z'), 'en'), '3m 52s');
});

test('durationText counts from startedAt to now while running', () => {
  const r = run({ status: 'in_progress', conclusion: null, startedAt: '2026-11-01T10:00:00Z' });
  const now = Date.parse('2026-11-01T10:01:05Z');
  assert.equal(durationText(r, now, 'en'), 'running 1m 5s');
  assert.equal(durationText(r, now, 'id'), 'berjalan 1m 5s');
});

test('durationText says queued for a run that never started', () => {
  const r = run({ status: 'queued', conclusion: null, startedAt: null });
  assert.equal(durationText(r, Date.now(), 'en'), 'queued');
  assert.equal(durationText(r, Date.now(), 'id'), 'antre');
});

test('durationText clamps clock skew to zero rather than showing a negative', () => {
  const r = run({ startedAt: '2026-11-01T10:00:10Z', updatedAt: '2026-11-01T10:00:00Z' });
  assert.equal(durationText(r, Date.parse('2026-11-01T11:00:00Z'), 'en'), '0s');
});

test('durationText drops the seconds once the duration reaches an hour', () => {
  const r = run({ startedAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T11:02:03Z' });
  assert.equal(durationText(r, 0, 'en'), '1h 2m');
});

test('durationText handles a completed run with garbage updatedAt', () => {
  const r = run({ startedAt: '2026-11-01T10:00:00Z', updatedAt: 'garbage' });
  assert.equal(durationText(r, 0, 'en'), '0s');
});

// ------------------------------------------------------------------- metaLine

test('metaLine reads workflow, run number, trigger, and short sha', () => {
  const line = metaLine(run());
  assert.equal(line, 'CI #482 - push 9f8e7d6');
});

test('metaLine omits a missing event instead of leaving a stray separator', () => {
  assert.equal(metaLine(run({ event: '' })), 'CI #482 - 9f8e7d6');
});

test('metaLine sanitizes bidi control characters in name and event', () => {
  const line = metaLine(run({ name: 'CI‮evil' }));
  assert.ok(!line.includes('‮'));
});

// ------------------------------------------------------------ formatDuration

test('formatDuration clamps clock skew to zero and shares one ladder with jobs', () => {
  assert.equal(formatDuration('2026-11-01T10:00:00Z', Date.parse('2026-11-01T10:00:10Z'), true, 'en'), 'running 10s');
  assert.equal(formatDuration('2026-11-01T10:00:10Z', Date.parse('2026-11-01T10:00:00Z'), false, 'en'), '0s');
  assert.equal(formatDuration(null, 0, true, 'en'), 'queued');
  assert.equal(formatDuration(null, 0, true, 'id'), 'antre');
  assert.equal(formatDuration(null, 0, false, 'en'), '0s', 'finished with no start stamp');
});

// -------------------------------------------------------------- runRowLabel

test('runRowLabel names the status, meta, duration, and the disclosure action', () => {
  const r = run({ startedAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:03:52Z' });
  const now = Date.parse('2026-11-02T00:00:00Z');
  const collapsed = runRowLabel(r, now, 'en', false);
  for (const part of ['Succeeded', 'CI #482 - push 9f8e7d6', '3m 52s', 'Show jobs for']) {
    assert.ok(collapsed.includes(part), `${part} missing from ${collapsed}`);
  }
  const expanded = runRowLabel(r, now, 'en', true);
  assert.ok(expanded.includes('Hide jobs for'), expanded);
  assert.ok(runRowLabel(r, now, 'id', false).includes('Berhasil'));
});

test('runRowLabel sanitizes the title it embeds', () => {
  const label = runRowLabel(run({ title: 'evil\u202Etitle' }), 0, 'en', false);
  assert.ok(!label.includes('\u202E'), label);
});

// ------------------------------------------------------- finished, no start

test('formatDuration says 0s for a finished run that never started', () => {
  // A startup_failure has completed_at but no run_started_at.
  assert.equal(formatDuration(null, Date.parse('2026-11-01T10:00:00Z'), false, 'en'), '0s');
  assert.equal(formatDuration(null, 0, true, 'en'), 'queued');
});

// ------------------------------------------------------------------ statusWord

test('statusWord names a finished run without a verdict as no result, not skipped', () => {
  for (const conclusion of ["neutral", "stale", null] as const) {
    assert.equal(statusWord("completed", conclusion, "en"), "No result", String(conclusion));
  }
  assert.equal(statusWord("completed", "skipped", "en"), "Skipped");
  assert.equal(statusWord("completed", "neutral", "id"), "Tanpa hasil");
  assert.equal(statusWord("in_progress", null, "en"), "Running");
  assert.equal(statusWord("queued", null, "en"), "Queued");
});
