import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STALENESS_MS, SafetyGuard, type GuardAction, type GuardSnapshot } from '../src/guard';
import { hostText } from '../src/hostText';
import type { Lang } from '../src/messages';

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

function verdict(action: GuardAction, overrides: Partial<GuardSnapshot> = {}, lang: Lang = 'en') {
  return SafetyGuard.evaluate(action, snapshot(overrides), lang);
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
    const resId = verdict(action, { dirty: true }, 'id');
    assert.equal(resId.allow, false, action.action);
    if (resId.allow) return;
    assert.equal(resId.code, 'DIRTY_TREE');
    assert.equal(resId.message, 'Commit atau stash perubahan sebelum checkout.');
    assert.deepEqual(resId.remedies, ['commit', 'stash', 'cancel']);

    const resEn = verdict(action, { dirty: true }, 'en');
    assert.equal(resEn.allow, false, action.action);
    if (resEn.allow) return;
    assert.equal(resEn.code, 'DIRTY_TREE');
    assert.equal(resEn.message, 'Commit or stash changes before checkout.');
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
    const resId = verdict({ action: 'checkout-branch', branch: 'main' }, { operation }, 'id');
    assert.equal(resId.allow, false, operation);
    if (resId.allow) return;
    assert.equal(resId.code, 'CONFLICT');
    assert.equal(resId.message, 'Selesaikan operasi git yang sedang berjalan.');
    assert.deepEqual(resId.remedies, ['resolve-conflicts', 'cancel']);

    const resEn = verdict({ action: 'checkout-branch', branch: 'main' }, { operation }, 'en');
    assert.equal(resEn.allow, false, operation);
    if (resEn.allow) return;
    assert.equal(resEn.message, 'Resolve in-progress git operation first.');
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
  const resId = verdict({ action: 'commit' }, { operation: 'merge', conflicted: true }, 'id');
  assert.equal(resId.allow, false);
  if (resId.allow) return;
  assert.equal(resId.code, 'CONFLICT');
  assert.equal(resId.message, 'Selesaikan semua file konflik.');
  assert.deepEqual(resId.remedies, ['resolve-conflicts', 'cancel']);

  const resEn = verdict({ action: 'commit' }, { operation: 'merge', conflicted: true }, 'en');
  assert.equal(resEn.allow, false);
  if (resEn.allow) return;
  assert.equal(resEn.message, 'Resolve all conflicted files.');
});

test('push requires a fetch newer than the staleness window', () => {
  const resId = verdict(
    { action: 'push', remote: 'origin', branch: 'main' },
    { lastFetchAt: NOW - DEFAULT_STALENESS_MS - 1 },
    'id',
  );
  assert.equal(resId.allow, false);
  if (resId.allow) return;
  assert.equal(resId.code, 'STALE_STATUS');
  assert.equal(resId.message, 'Status remote kedaluwarsa.');
  assert.deepEqual(resId.remedies, ['fetch']);

  const resEn = verdict(
    { action: 'push', remote: 'origin', branch: 'main' },
    { lastFetchAt: NOW - DEFAULT_STALENESS_MS - 1 },
    'en',
  );
  assert.equal(resEn.allow, false);
  if (resEn.allow) return;
  assert.equal(resEn.message, 'Remote status is stale.');
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
  const resId = verdict({ action: 'push', remote: 'origin', branch: 'main' }, { behind: 3, ahead: 1 }, 'id');
  assert.equal(resId.allow, false);
  if (resId.allow) return;
  assert.equal(resId.code, 'REMOTE_AHEAD');
  assert.equal(resId.message, 'Remote memiliki histori berbeda.');
  assert.deepEqual(resId.remedies, ['fetch']);
  assert.ok(!resId.remedies.includes('confirm'));

  const resEn = verdict({ action: 'push', remote: 'origin', branch: 'main' }, { behind: 3, ahead: 1 }, 'en');
  assert.equal(resEn.allow, false);
  if (resEn.allow) return;
  assert.equal(resEn.message, 'Remote has different history.');
});

test('push-up-to while behind is NON_FAST_FORWARD with a fetch remedy', () => {
  const resId = verdict(
    { action: 'push-up-to', remote: 'origin', branch: 'main', hash: 'abcdef1' },
    { behind: 2 },
    'id',
  );
  assert.equal(resId.allow, false);
  if (resId.allow) return;
  assert.equal(resId.code, 'NON_FAST_FORWARD');
  assert.equal(resId.message, 'Push bukan fast-forward.');
  assert.deepEqual(resId.remedies, ['fetch']);

  const resEn = verdict(
    { action: 'push-up-to', remote: 'origin', branch: 'main', hash: 'abcdef1' },
    { behind: 2 },
    'en',
  );
  assert.equal(resEn.allow, false);
  if (resEn.allow) return;
  assert.equal(resEn.message, 'Push is not fast-forward.');
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
  const resId = verdict({ action: 'reset-hard', hash: 'abcdef1' }, {}, 'id');
  assert.equal(resId.allow, false);
  if (resId.allow) return;
  assert.equal(resId.code, 'CONFIRMATION_REQUIRED');
  assert.equal(resId.message, 'Hard reset membuang perubahan permanen.');
  assert.equal(resId.requiresConfirmation, true);
  assert.equal(resId.confirmationLevel, 2);
  assert.equal(resId.risk, 'high');

  const resEn = verdict({ action: 'reset-hard', hash: 'abcdef1' }, {}, 'en');
  assert.equal(resEn.allow, false);
  if (resEn.allow) return;
  assert.equal(resEn.message, 'Hard reset discards changes permanently.');
});

test('push-up-to, revert, and reset-soft demand a level 1 confirmation', () => {
  const actions: GuardAction[] = [
    { action: 'push-up-to', remote: 'origin', branch: 'main', hash: 'abcdef1' },
    { action: 'revert', hash: 'abcdef1' },
    { action: 'reset-soft', hash: 'abcdef1' },
  ];
  for (const action of actions) {
    const resId = verdict(action, {}, 'id');
    assert.equal(resId.allow, false, action.action);
    if (resId.allow) return;
    assert.equal(resId.code, 'CONFIRMATION_REQUIRED');
    assert.equal(resId.message, 'Tindakan ini perlu konfirmasi.');
    assert.equal(resId.requiresConfirmation, true);
    assert.equal(resId.confirmationLevel, 1);
    assert.deepEqual(resId.remedies, ['confirm', 'cancel']);

    const resEn = verdict(action, {}, 'en');
    assert.equal(resEn.allow, false, action.action);
    if (resEn.allow) return;
    assert.equal(resEn.message, 'This action requires confirmation.');
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
  const idGuard = hostText('id').guard;
  assert.equal(idGuard.dirty, 'Commit atau stash perubahan sebelum checkout.');
  assert.equal(idGuard.conflictFiles, 'Selesaikan semua file konflik.');
  assert.equal(idGuard.stale, 'Status remote kedaluwarsa.');
  assert.equal(idGuard.remoteAhead, 'Remote memiliki histori berbeda.');
  assert.equal(idGuard.resetHard, 'Hard reset membuang perubahan permanen.');
  const enGuard = hostText('en').guard;
  assert.equal(enGuard.dirty, 'Commit or stash changes before checkout.');
  assert.equal(enGuard.resetHard, 'Hard reset discards changes permanently.');
});

test('evaluate never mutates the snapshot it is given', () => {
  const input = snapshot({ dirty: true });
  const copy = { ...input };
  SafetyGuard.evaluate({ action: 'merge', branch: 'x' }, input);
  assert.deepEqual(input, copy);
});
