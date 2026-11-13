/**
 * Check summary model (P21).
 *
 * The summary is the only thing the badges read, so every rule lives here and is
 * pinned by a case. Priority is the interesting part: one completed failure wins
 * over any number of still-running checks, because a red badge that says "still
 * running" hides the failure the user has to act on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeChecks } from '../src/checkSummary';
import type { CheckConclusion, CheckRunInfo, CheckStatus } from '../src/messages';

let nextId = 1;

function run(
  name: string,
  status: CheckStatus,
  conclusion: CheckConclusion = null,
): CheckRunInfo {
  nextId += 1;
  return {
    id: nextId,
    name,
    status,
    conclusion,
    url: `https://github.com/o/r/runs/${nextId}`,
    startedAt: null,
    completedAt: status === 'completed' ? '2026-11-13T00:00:00Z' : null,
  };
}

test('an empty list is the none state, not a passing one', () => {
  assert.deepEqual(summarizeChecks([]), {
    state: 'none',
    total: 0,
    passed: 0,
    failing: 0,
    pending: 0,
    failingNames: [],
  });
});

test('all completed successes pass', () => {
  const summary = summarizeChecks([run('Lint', 'completed', 'success'), run('Test', 'completed', 'success')]);
  assert.equal(summary.state, 'passing');
  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failing, 0);
  assert.equal(summary.pending, 0);
});

test('neutral and skipped count as passed, so they never turn the badge red', () => {
  const summary = summarizeChecks([
    run('Lint', 'completed', 'success'),
    run('Optional', 'completed', 'neutral'),
    run('Windows', 'completed', 'skipped'),
  ]);
  assert.equal(summary.state, 'passing');
  assert.equal(summary.passed, 3);
  assert.equal(summary.failing, 0);
});

test('stale counts as passed: it is a cancelled rerun, not a failure', () => {
  assert.equal(summarizeChecks([run('Lint', 'completed', 'stale')]).state, 'passing');
});

test('one failure among successes fails the commit', () => {
  const summary = summarizeChecks([
    run('Lint', 'completed', 'success'),
    run('Test', 'completed', 'failure'),
    run('Build', 'completed', 'success'),
  ]);
  assert.equal(summary.state, 'failing');
  assert.equal(summary.failing, 1);
  assert.equal(summary.passed, 2);
  assert.deepEqual(summary.failingNames, ['Test']);
});

test('every failing conclusion counts as failing', () => {
  const summary = summarizeChecks([
    run('a', 'completed', 'failure'),
    run('b', 'completed', 'timed_out'),
    run('c', 'completed', 'action_required'),
    run('d', 'completed', 'cancelled'),
  ]);
  assert.equal(summary.state, 'failing');
  assert.equal(summary.failing, 4);
  assert.deepEqual(summary.failingNames, ['a', 'b', 'c']);
});

test('a failure wins over a run still in progress', () => {
  const summary = summarizeChecks([
    run('Lint', 'in_progress'),
    run('Test', 'completed', 'failure'),
  ]);
  assert.equal(summary.state, 'failing', 'the red badge must not wait for the other run');
  assert.equal(summary.pending, 1);
  assert.equal(summary.failing, 1);
});

test('queued and in_progress runs alone are pending', () => {
  const summary = summarizeChecks([run('Lint', 'queued'), run('Test', 'in_progress')]);
  assert.equal(summary.state, 'pending');
  assert.equal(summary.pending, 2);
  assert.equal(summary.passed, 0);
});

test('a completed run with an unknown conclusion counts as passed, not pending', () => {
  // The mapper maps unknown strings to null; a completed run with no conclusion
  // is over, so waiting on it would leave the badge spinning forever.
  const summary = summarizeChecks([run('Mystery', 'completed', null)]);
  assert.equal(summary.state, 'passing');
  assert.equal(summary.passed, 1);
});

test('failing names stop at three and keep run order', () => {
  const summary = summarizeChecks([
    run('First', 'completed', 'failure'),
    run('Second', 'completed', 'failure'),
    run('Third', 'completed', 'failure'),
    run('Fourth', 'completed', 'failure'),
  ]);
  assert.deepEqual(summary.failingNames, ['First', 'Second', 'Third']);
  assert.equal(summary.failing, 4, 'the count still reports all four');
});
