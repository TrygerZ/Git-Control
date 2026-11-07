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
    headPublished: null,
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

test('dirty tree blocks checkout and merge', () => {
  const blocked: GuardAction[] = [
    { action: 'checkout-branch', branch: 'main' },
    { action: 'checkout-commit', hash: 'abcdef1' },
    { action: 'merge', branch: 'feature' },
    { action: 'merge-into', target: 'main', source: 'feature' },
    { action: 'pull' },
    { action: 'stash-apply', index: 0 },
    { action: 'cherry-pick', hash: 'abcdef1' },
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

  // reset-hard on dirty tree is not blocked with DIRTY_TREE, but requires level 2 confirmation
  const rhId = verdict({ action: 'reset-hard', hash: 'abcdef1' }, { dirty: true }, 'id');
  assert.equal(rhId.allow, false);
  if (rhId.allow) return;
  assert.equal(rhId.code, 'CONFIRMATION_REQUIRED');
  assert.equal(rhId.confirmationLevel, 2);
  assert.equal(rhId.risk, 'high');
  assert.deepEqual(rhId.remedies, ['confirm', 'cancel']);

  const rhEn = verdict({ action: 'reset-hard', hash: 'abcdef1' }, { dirty: true }, 'en');
  assert.equal(rhEn.allow, false);
  if (rhEn.allow) return;
  assert.equal(rhEn.code, 'CONFIRMATION_REQUIRED');
  assert.equal(rhEn.confirmationLevel, 2);
  assert.equal(rhEn.risk, 'high');
  assert.deepEqual(rhEn.remedies, ['confirm', 'cancel']);
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

test('cherry-pick resolution actions are allowed during active cherry-pick', () => {
  for (const action of [
    { action: 'cherry-pick-continue' },
    { action: 'cherry-pick-abort' },
    { action: 'stage' },
  ] satisfies GuardAction[]) {
    assert.deepEqual(verdict(action, { operation: 'cherry-pick' }), { allow: true }, action.action);
  }
});

test('cherry-pick is blocked when an operation is in progress', () => {
  const res = verdict({ action: 'cherry-pick', hash: 'abcdef1' }, { operation: 'merge' });
  assert.equal(res.allow, false);
  if (!res.allow) {
    assert.equal(res.code, 'CONFLICT');
    assert.deepEqual(res.remedies, ['resolve-conflicts', 'cancel']);
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

test('stash-drop demands a level 2 confirmation, is high risk, and is not dirty-blocked', () => {
  const resId = verdict({ action: 'stash-drop', index: 0 }, { dirty: true }, 'id');
  assert.equal(resId.allow, false);
  if (resId.allow) return;
  assert.equal(resId.code, 'CONFIRMATION_REQUIRED');
  assert.equal(resId.message, 'Drop stash membuang perubahan permanen.');
  assert.equal(resId.requiresConfirmation, true);
  assert.equal(resId.confirmationLevel, 2);
  assert.equal(resId.risk, 'high');
  assert.deepEqual(resId.remedies, ['confirm', 'cancel']);

  const resEn = verdict({ action: 'stash-drop', index: 0 }, { dirty: true }, 'en');
  assert.equal(resEn.allow, false);
  if (resEn.allow) return;
  assert.equal(resEn.message, 'Stash drop discards changes permanently.');
  assert.equal(resEn.confirmationLevel, 2);
  assert.equal(resEn.risk, 'high');
});

test('push-up-to, revert, and reset-soft demand a level 1 confirmation', () => {
  const actions: GuardAction[] = [
    { action: 'push-up-to', remote: 'origin', branch: 'main', hash: 'abcdef1' },
    { action: 'revert', hash: 'abcdef1' },
    { action: 'reset-soft', hash: 'abcdef1' },
    { action: 'merge-into', target: 'main', source: 'feature' },
    { action: 'pull' },
    { action: 'stash-apply', index: 0 },
    { action: 'cherry-pick', hash: 'abcdef1' },
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

test('discard-file demands a level 2 confirmation and is high risk', () => {
  const resId = verdict({ action: 'discard-file', path: 'file.txt' }, {}, 'id');
  assert.equal(resId.allow, false);
  if (resId.allow) return;
  assert.equal(resId.code, 'CONFIRMATION_REQUIRED');
  assert.equal(resId.message, 'Membuang perubahan lokal bersifat permanen.');
  assert.equal(resId.requiresConfirmation, true);
  assert.equal(resId.confirmationLevel, 2);
  assert.equal(resId.risk, 'high');

  const resEn = verdict({ action: 'discard-file', path: 'file.txt' }, {}, 'en');
  assert.equal(resEn.allow, false);
  if (resEn.allow) return;
  assert.equal(resEn.message, 'Discarding local changes is permanent.');
});

test('discard-file is allowed on dirty tree without being blocked by DIRTY_TREE', () => {
  const res = verdict({ action: 'discard-file', path: 'file.txt' }, { dirty: true });
  assert.equal(res.allow, false);
  if (res.allow) return;
  assert.equal(res.code, 'CONFIRMATION_REQUIRED');
  assert.equal(res.confirmationLevel, 2);
  assert.equal(res.risk, 'high');
});

test('discard-file during an active operation reports conflict', () => {
  const res = verdict({ action: 'discard-file', path: 'file.txt' }, { operation: 'merge' });
  assert.equal(res.allow, false);
  if (res.allow) return;
  assert.equal(res.code, 'CONFLICT');
});

test('discard-file when conflicted files exist reports conflict', () => {
  const res = verdict({ action: 'discard-file', path: 'file.txt' }, { conflicted: true });
  assert.equal(res.allow, false);
  if (res.allow) return;
  assert.equal(res.code, 'CONFLICT');
});

test('exported messages match the PRD wording verbatim', () => {
  const idGuard = hostText('id').guard;
  assert.equal(idGuard.dirty, 'Commit atau stash perubahan sebelum checkout.');
  assert.equal(idGuard.conflictFiles, 'Selesaikan semua file konflik.');
  assert.equal(idGuard.stale, 'Status remote kedaluwarsa.');
  assert.equal(idGuard.remoteAhead, 'Remote memiliki histori berbeda.');
  assert.equal(idGuard.resetHard, 'Hard reset membuang perubahan permanen.');
  assert.equal(idGuard.discardFile, 'Membuang perubahan lokal bersifat permanen.');
  assert.equal(idGuard.stashDrop, 'Drop stash membuang perubahan permanen.');
  const enGuard = hostText('en').guard;
  assert.equal(enGuard.dirty, 'Commit or stash changes before checkout.');
  assert.equal(enGuard.resetHard, 'Hard reset discards changes permanently.');
  assert.equal(enGuard.discardFile, 'Discarding local changes is permanent.');
  assert.equal(enGuard.stashDrop, 'Stash drop discards changes permanently.');
});

test('evaluate never mutates the snapshot it is given', () => {
  const input = snapshot({ dirty: true });
  const copy = { ...input };
  SafetyGuard.evaluate({ action: 'merge', branch: 'x' }, input);
  assert.deepEqual(input, copy);
});

test('pull is blocked on dirty tree and requires level 1 confirmation when clean', () => {
  const dirtyRes = verdict({ action: 'pull' }, { dirty: true }, 'en');
  assert.equal(dirtyRes.allow, false);
  if (dirtyRes.allow) return;
  assert.equal(dirtyRes.code, 'DIRTY_TREE');
  assert.deepEqual(dirtyRes.remedies, ['commit', 'stash', 'cancel']);

  const cleanRes = verdict({ action: 'pull' }, { dirty: false }, 'en');
  assert.equal(cleanRes.allow, false);
  if (cleanRes.allow) return;
  assert.equal(cleanRes.code, 'CONFIRMATION_REQUIRED');
  assert.equal(cleanRes.confirmationLevel, 1);
  assert.deepEqual(cleanRes.remedies, ['confirm', 'cancel']);
});

test('amend is blocked when HEAD is published, allowed when it is local only', () => {
  // `headPublished === false` means the last commit is not on the upstream, so
  // replacing it stays a local rewrite that a later push can still fast-forward.
  assert.deepEqual(verdict({ action: 'commit', amend: true }, { headPublished: false }), { allow: true });

  for (const [lang, expected] of [
    // "may already be" is deliberate: the probe cannot always prove publication
    // (a pruned upstream leaves no local ref to ask), so the message must not
    // assert a fact it does not have.
    ['en', 'Last commit may already be on the upstream branch, and amending it would need a force push, which Git Control never does.'],
    ['id', 'Commit terakhir mungkin sudah ada di branch upstream, dan amend butuh force push, yang tidak pernah dilakukan Git Control.'],
  ] as const) {
    const res = verdict({ action: 'commit', amend: true }, { headPublished: true }, lang);
    assert.equal(res.allow, false, lang);
    if (res.allow) return;
    assert.equal(res.code, 'NON_FAST_FORWARD', lang);
    assert.deepEqual(res.remedies, ['cancel'], 'fetch cannot make an amend valid');
    assert.equal(res.requiresConfirmation, undefined, 'no confirmation path exists for a published amend');
    assert.equal(res.message, expected, lang);
    assert.equal(res.message, hostText(lang).guard.amendPublished, `${lang} text comes from hostText`);
  }
});

test('an uncomputed publication flag blocks the amend instead of allowing it', () => {
  // Fail closed: a caller that forgets to compute the flag must not silently
  // turn a published amend into a force-push-shaped rewrite.
  const res = verdict({ action: 'commit', amend: true }, { headPublished: null });
  assert.equal(res.allow, false);
  if (res.allow) return;
  assert.equal(res.code, 'NON_FAST_FORWARD');
  assert.deepEqual(res.remedies, ['cancel']);
});

test('a plain commit ignores the publication flag', () => {
  for (const headPublished of [true, false, null] as const) {
    assert.deepEqual(
      verdict({ action: 'commit' }, { headPublished, staged: true }),
      { allow: true },
      `headPublished ${String(headPublished)}`,
    );
  }
});

test('amend during an in-progress operation reports the operation, not the publication', () => {
  for (const operation of ['merge', 'rebase', 'cherry-pick'] as const) {
    const res = verdict({ action: 'commit', amend: true }, { operation, headPublished: false }, 'en');
    assert.equal(res.allow, false, operation);
    if (res.allow) return;
    assert.equal(res.code, 'CONFLICT', operation);
    assert.equal(res.message, hostText('en').guard.conflictInProgress, operation);
    assert.deepEqual(res.remedies, ['resolve-conflicts', 'cancel'], operation);
  }
});

test('unresolved conflicts win over the amend rule', () => {
  // A half-resolved merge would record conflict markers, so it must be reported
  // before the publication check even when the commit is also an amend.
  const res = verdict({ action: 'commit', amend: true }, { operation: 'merge', conflicted: true, headPublished: true });
  assert.equal(res.allow, false);
  if (res.allow) return;
  assert.equal(res.code, 'CONFLICT');
  assert.equal(res.message, hostText('en').guard.conflictFiles);
});

test('amend is blocked in a detached HEAD, where no branch upstream exists', () => {
  // A detached HEAD has no branch, so `status.upstream` is null and the old
  // check waved the amend through even when the commit sat on a remote ref.
  // The snapshot carries the host's own answer; `true` here means published.
  const res = verdict({ action: 'commit', amend: true }, { headPublished: true, upstream: null }, 'en');
  assert.equal(res.allow, false);
  if (res.allow) return;
  assert.equal(res.code, 'NON_FAST_FORWARD');
  assert.deepEqual(res.remedies, ['cancel']);
});

/**
 * P09 relies on git's own behaviour: `git switch --create` carries uncommitted
 * changes onto the new branch. So the guard must NOT block branch creation on a
 * dirty tree, or the dialog's "your changes move with you" note would be a lie.
 * An operation in progress is still a hard stop: switching mid-merge would strand it.
 */
test('create-branch is allowed on a dirty tree and blocked only by an in-progress operation', () => {
  const action: GuardAction = { action: 'create-branch', name: 'feat/97-lane-gutter', startPoint: 'abcdef1' };

  assert.deepEqual(verdict(action, { dirty: true }), { allow: true });
  assert.deepEqual(verdict(action, { dirty: true, staged: true }), { allow: true });

  for (const operation of ['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'] as const) {
    const res = verdict(action, { operation });
    assert.equal(res.allow, false, operation);
    if (res.allow) return;
    assert.equal(res.code, 'CONFLICT', operation);
    assert.deepEqual(res.remedies, ['resolve-conflicts', 'cancel'], operation);
  }
});
