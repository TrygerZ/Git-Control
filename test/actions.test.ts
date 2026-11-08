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
