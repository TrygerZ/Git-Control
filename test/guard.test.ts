import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STALENESS_MS, MESSAGES, SafetyGuard, type GuardAction, type GuardSnapshot } from '../src/guard';

const NOW = 1_700_000_000_000;

/** Clean repository, freshly fetched. Override only what a test cares about. */
function snapshot(overrides: Partial<GuardSnapshot> = {}): GuardSnapshot {
  return {
    dirty: false,
    staged: false,
    conflicted: false,
    operation: 'idle',
    ahead: 0,
    behind: 0,
    upstream: 'origin/main',
    lastFetchAt: NOW,
    now: NOW,
    stalenessMs: DEFAULT_STALENESS_MS,
    ...overrides,
  };
}

function verdict(action: GuardAction, overrides: Partial<GuardSnapshot> = {}) {
  return SafetyGuard.evaluate(action, snapshot(overrides));
}

test('clean repository allows non-destructive actions', () => {
  for (const action of [
    { action: 'checkout-branch', branch: 'main' },
    { action: 'checkout-commit', hash: 'abcdef1' },
    { action: 'merge', branch: 'feature' },
    { action: 'create-branch', name: 'x', startPoint: 'main' },
    { action: 'fetch' },
    { action: 'stash', message: 'wip' },
    { action: 'stash-pop' },
    { action: 'stage' },
    { action: 'commit' },
    { action: 'push', remote: 'origin', branch: 'main' },
  ] satisfies GuardAction[]) {
    assert.deepEqual(verdict(action), { allow: true }, action.action);
  }
});

test('dirty tree blocks checkout, reset-hard, and merge', () => {
  const blocked: GuardAction[] = [
    { action: 'checkout-branch', branch: 'main' },
    { action: 'checkout-commit', hash: 'abcdef1' },
    { action: 'reset-hard', hash: 'abcdef1' },
    { action: 'merge', branch: 'feature' },
  ];
  for (const action of blocked) {
    const result = verdict(action, { dirty: true });
    assert.equal(result.allow, false, action.action);
    if (result.allow) return;
    assert.equal(result.code, 'DIRTY_TREE');
    assert.equal(result.message, 'Commit atau stash perubahan sebelum checkout.');
    assert.deepEqual(result.remedies, ['commit', 'stash', 'cancel']);
  }
});

test('dirty tree does not block staging, commit, stash, or fetch', () => {
  for (const action of [
    { action: 'stage' },
    { action: 'commit' },
    { action: 'stash', message: 'wip' },
    { action: 'fetch' },
  ] satisfies GuardAction[]) {
    assert.deepEqual(verdict(action, { dirty: true }), { allow: true }, action.action);
  }
});

test('in-progress operation blocks every non-resolution action', () => {
  const operations = ['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'] as const;
  for (const operation of operations) {
    const result = verdict({ action: 'checkout-branch', branch: 'main' }, { operation });
    assert.equal(result.allow, false, operation);
    if (result.allow) return;
    assert.equal(result.code, 'CONFLICT');
    assert.deepEqual(result.remedies, ['resolve-conflicts', 'cancel']);
  }
});

test('resolution actions are allowed during a merge', () => {
  for (const action of [
    { action: 'merge-continue' },
    { action: 'merge-abort' },
    { action: 'stage' },
  ] satisfies GuardAction[]) {
    assert.deepEqual(verdict(action, { operation: 'merge' }), { allow: true }, action.action);
  }
});

test('commit is allowed during a merge once conflicts are resolved', () => {
  assert.deepEqual(
    verdict({ action: 'commit' }, { operation: 'merge', conflicted: false, staged: true }),
    { allow: true },
  );
});

test('unresolved conflicts block commit', () => {
  const result = verdict({ action: 'commit' }, { operation: 'merge', conflicted: true });
  assert.equal(result.allow, false);
  if (result.allow) return;
  assert.equal(result.code, 'CONFLICT');
  assert.equal(result.message, 'Selesaikan semua file konflik.');
  assert.deepEqual(result.remedies, ['resolve-conflicts', 'cancel']);
});

test('push requires a fetch newer than the staleness window', () => {
  const result = verdict(
    { action: 'push', remote: 'origin', branch: 'main' },
    { lastFetchAt: NOW - DEFAULT_STALENESS_MS - 1 },
  );
  assert.equal(result.allow, false);
  if (result.allow) return;
  assert.equal(result.code, 'STALE_STATUS');
  assert.equal(result.message, 'Status remote kedaluwarsa.');
  assert.deepEqual(result.remedies, ['fetch']);
});

test('a fetch exactly at the staleness threshold still counts as fresh', () => {
  assert.deepEqual(
    verdict(
      { action: 'push', remote: 'origin', branch: 'main' },
      { lastFetchAt: NOW - DEFAULT_STALENESS_MS },
    ),
    { allow: true },
  );
  const past = verdict(
    { action: 'push', remote: 'origin', branch: 'main' },
    { lastFetchAt: NOW - DEFAULT_STALENESS_MS - 1 },
  );
  assert.equal(past.allow, false);
});

test('never having fetched is stale', () => {
  const result = verdict({ action: 'push', remote: 'origin', branch: 'main' }, { lastFetchAt: null });
  assert.equal(result.allow, false);
  if (result.allow) return;
  assert.equal(result.code, 'STALE_STATUS');
});

test('push while behind reports REMOTE_AHEAD and only offers fetch', () => {
  const result = verdict({ action: 'push', remote: 'origin', branch: 'main' }, { behind: 3, ahead: 1 });
  assert.equal(result.allow, false);
  if (result.allow) return;
  assert.equal(result.code, 'REMOTE_AHEAD');
  assert.equal(result.message, 'Remote memiliki histori berbeda.');
  assert.deepEqual(result.remedies, ['fetch']);
  assert.ok(!result.remedies.includes('confirm'));
});

test('push-up-to while behind is NON_FAST_FORWARD with a fetch remedy', () => {
  const result = verdict(
    { action: 'push-up-to', remote: 'origin', branch: 'main', hash: 'abcdef1' },
    { behind: 2 },
  );
  assert.equal(result.allow, false);
  if (result.allow) return;
  assert.equal(result.code, 'NON_FAST_FORWARD');
  assert.deepEqual(result.remedies, ['fetch']);
});

test('staleness is checked before the behind count', () => {
  const result = verdict(
    { action: 'push', remote: 'origin', branch: 'main' },
    { behind: 5, lastFetchAt: null },
  );
  assert.equal(result.allow, false);
  if (result.allow) return;
  assert.equal(result.code, 'STALE_STATUS');
});

test('reset-hard demands a level 2 confirmation and is high risk', () => {
  const result = verdict({ action: 'reset-hard', hash: 'abcdef1' });
  assert.equal(result.allow, false);
  if (result.allow) return;
  assert.equal(result.code, 'CONFIRMATION_REQUIRED');
  assert.equal(result.message, 'Hard reset membuang perubahan permanen.');
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.confirmationLevel, 2);
  assert.equal(result.risk, 'high');
});

test('push-up-to, revert, and reset-soft demand a level 1 confirmation', () => {
  const actions: GuardAction[] = [
    { action: 'push-up-to', remote: 'origin', branch: 'main', hash: 'abcdef1' },
    { action: 'revert', hash: 'abcdef1' },
    { action: 'reset-soft', hash: 'abcdef1' },
  ];
  for (const action of actions) {
    const result = verdict(action);
    assert.equal(result.allow, false, action.action);
    if (result.allow) return;
    assert.equal(result.code, 'CONFIRMATION_REQUIRED');
    assert.equal(result.requiresConfirmation, true);
    assert.equal(result.confirmationLevel, 1);
    assert.deepEqual(result.remedies, ['confirm', 'cancel']);
  }
});

test('dirty and behind together report the dirty tree first', () => {
  const result = verdict({ action: 'merge', branch: 'feature' }, { dirty: true, behind: 4 });
  assert.equal(result.allow, false);
  if (result.allow) return;
  assert.equal(result.code, 'DIRTY_TREE');
});

test('dirty push is still gated on remote freshness, not the working tree', () => {
  const result = verdict(
    { action: 'push', remote: 'origin', branch: 'main' },
    { dirty: true, behind: 1 },
  );
  assert.equal(result.allow, false);
  if (result.allow) return;
  assert.equal(result.code, 'REMOTE_AHEAD');
});

test('reset-hard during a merge reports the conflict, not the confirmation', () => {
  const result = verdict({ action: 'reset-hard', hash: 'abcdef1' }, { operation: 'merge' });
  assert.equal(result.allow, false);
  if (result.allow) return;
  assert.equal(result.code, 'CONFLICT');
});

test('exported messages match the PRD wording verbatim', () => {
  assert.equal(MESSAGES.dirty, 'Commit atau stash perubahan sebelum checkout.');
  assert.equal(MESSAGES.conflictFiles, 'Selesaikan semua file konflik.');
  assert.equal(MESSAGES.stale, 'Status remote kedaluwarsa.');
  assert.equal(MESSAGES.remoteAhead, 'Remote memiliki histori berbeda.');
  assert.equal(MESSAGES.resetHard, 'Hard reset membuang perubahan permanen.');
});

test('evaluate never mutates the snapshot it is given', () => {
  const input = snapshot({ dirty: true });
  const copy = { ...input };
  SafetyGuard.evaluate({ action: 'merge', branch: 'x' }, input);
  assert.deepEqual(input, copy);
});
