/**
 * P25 pure merge model.
 *
 * `mergeBlockReason` decides whether the merge button is live and why not;
 * `mergeCommands` is the exact list the confirmation dialog shows, which is the
 * whole promise of frame 50; `defaultSquashMessage` is the prefilled subject.
 * All three are data-in/data-out, so a wrong sentence here is a wrong dialog with
 * no DOM in the way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSquashMessage,
  mergeBlockReason,
  mergeCommands,
} from '../src/webview/pullMerge';
import type { CheckSummary, PullDetail } from '../src/messages';

function detail(overrides: Partial<PullDetail> = {}): PullDetail {
  return {
    number: 150,
    title: 'Rebalance change row content inset to 8px',
    state: 'open',
    draft: false,
    author: 'TrygerZ',
    authorAvatarUrl: null,
    headRef: 'fix/ui-review-polish',
    baseRef: 'main',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    commits: 2,
    additions: 84,
    deletions: 15,
    changedFiles: 3,
    mergeableState: 'clean',
    htmlUrl: 'https://github.com/o/r/pull/150',
    body: '',
    createdAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T03:00:00Z',
    mergedAt: null,
    reviewers: [],
    approvedBy: [],
    changesRequestedBy: [],
    labels: [],
    ...overrides,
  };
}

function checks(overrides: Partial<CheckSummary> = {}): CheckSummary {
  return { state: 'passing', total: 14, passed: 14, failing: 0, pending: 0, failingNames: [], ...overrides };
}

// ------------------------------------------------------------------- blocking

test('a clean, open, non-draft pull request has no block', () => {
  assert.equal(mergeBlockReason(detail(), checks()), null);
});

test('each mergeable state a merge cannot proceed from names the reason the panel states', () => {
  // The reason union is fixed by the phase file's catalog keys, so GitHub's states
  // fold onto it: `dirty` is a conflict, `blocked` is branch protection (the panel's
  // own status rows say which rule), `unstable` is a non-passing status check.
  const table: Array<[PullDetail['mergeableState'], string]> = [
    ['dirty', 'conflicts'],
    ['blocked', 'review-required'],
    ['behind', 'behind'],
    ['unstable', 'checks-failing'],
    ['unknown', 'unknown'],
  ];
  for (const [state, reason] of table) {
    assert.equal(mergeBlockReason(detail({ mergeableState: state }), checks()), reason, state);
  }
});

test('a draft blocks regardless of mergeability', () => {
  assert.equal(mergeBlockReason(detail({ draft: true }), checks()), 'draft');
  // A draft that is also dirty still reads as a draft: the user can fix the draft
  // flag with one click, and conflicts are the harder problem to explain first.
  assert.equal(mergeBlockReason(detail({ draft: true, mergeableState: 'dirty' }), checks()), 'draft');
});

test('a closed or merged pull request blocks before anything else', () => {
  assert.equal(mergeBlockReason(detail({ state: 'closed' }), checks()), 'closed');
  assert.equal(mergeBlockReason(detail({ state: 'merged' }), checks()), 'closed');
  // A merged pull request with a dirty state still reads as closed.
  assert.equal(mergeBlockReason(detail({ state: 'merged', mergeableState: 'dirty' }), checks()), 'closed');
});

test('failing checks block, and a pending run blocks too', () => {
  assert.equal(mergeBlockReason(detail(), checks({ state: 'failing', failing: 1 })), 'checks-failing');
  assert.equal(mergeBlockReason(detail(), checks({ state: 'pending', pending: 2 })), 'checks-pending');
});

test('a failing check outranks a pending one, and both outrank unknown', () => {
  // The summary collapses to one state, so this is really a table check: the
  // summary's own precedence must be what the button reads.
  assert.equal(
    mergeBlockReason(detail({ mergeableState: 'unknown' }), checks({ state: 'failing', failing: 1 })),
    'checks-failing',
  );
  assert.equal(
    mergeBlockReason(detail({ mergeableState: 'unknown' }), checks({ state: 'pending', pending: 1 })),
    'checks-pending',
  );
});

test('a pull request with no checks at all is not blocked by them', () => {
  const none: CheckSummary = { state: 'none', total: 0, passed: 0, failing: 0, pending: 0, failingNames: [] };
  assert.equal(mergeBlockReason(detail(), none), null);
});

test('a closed or merged pull request returns closed even when checks are failing', () => {
  assert.equal(
    mergeBlockReason(detail({ state: 'merged' }), checks({ state: 'failing', failing: 1 })),
    'closed',
  );
});

test('conflicts outrank failing checks, because a conflict cannot be merged at all', () => {
  assert.equal(
    mergeBlockReason(detail({ mergeableState: 'dirty' }), checks({ state: 'failing', failing: 3 })),
    'conflicts',
  );
});

test('the reason names the thing the user must fix first', () => {
  // Precedence, highest first: closed, draft, conflicts, review required, checks,
  // behind, unknown. Each case below pairs two blockers and asserts the higher one.
  const pairs: Array<[Partial<PullDetail>, Partial<CheckSummary>, string]> = [
    [{ draft: true }, { state: 'failing', failing: 1 }, 'draft'],
    [{ draft: true, mergeableState: 'dirty' }, {}, 'draft'],
    [{ mergeableState: 'dirty' }, { state: 'pending', pending: 1 }, 'conflicts'],
    [{ mergeableState: 'blocked' }, { state: 'failing', failing: 1 }, 'review-required'],
    [{ mergeableState: 'behind' }, { state: 'failing', failing: 1 }, 'checks-failing'],
  ];
  for (const [detailPatch, checkPatch, reason] of pairs) {
    assert.equal(
      mergeBlockReason(detail(detailPatch), checks(checkPatch)),
      reason,
      JSON.stringify([detailPatch, checkPatch]),
    );
  }
});

// ------------------------------------------------------------------- commands

const PR = { owner: 'TrygerZ', repo: 'git-control', number: 150, headRef: 'fix/ui-review-polish' };

test('merge commands list the API call and nothing else when no branch is deleted', () => {
  assert.deepEqual(mergeCommands(PR, { method: 'merge', deleteBranch: false }), [
    'PUT /repos/TrygerZ/git-control/pulls/150/merge',
  ]);
  assert.deepEqual(mergeCommands(PR, { method: 'squash', deleteBranch: false }), [
    'PUT /repos/TrygerZ/git-control/pulls/150/merge',
  ]);
});

test('merge commands list local delete first, then the remote delete', () => {
  // Order is load-bearing: `git branch -d` proves merged-ness against the tracking
  // ref, and `push --delete` removes that ref. Remote-first refuses the local half
  // of a squash merge, which is the common case this dialog exists for.
  assert.deepEqual(mergeCommands(PR, { method: 'squash', deleteBranch: true }), [
    'PUT /repos/TrygerZ/git-control/pulls/150/merge',
    'git branch -d fix/ui-review-polish',
    'git push origin --delete fix/ui-review-polish',
  ]);
});

test('a merge command never contains a force flag or a + refspec', () => {
  for (const method of ['merge', 'squash'] as const) {
    for (const deleteBranch of [true, false]) {
      const commands = mergeCommands(PR, { method, deleteBranch });
      for (const command of commands) {
        assert.doesNotMatch(command, /--force|\s\+\S/, `${command}`);
      }
    }
  }
});

test('mergeCommands folds a hostile head ref through sanitizeGitText', () => {
  const commands = mergeCommands(
    { ...PR, headRef: 'fix/‮evil\u0000name' },
    { method: 'merge', deleteBranch: true },
  );
  for (const command of commands) {
    assert.doesNotMatch(command, /[‮\u0000]/, command);
  }
});

test('mergeCommands folds a hostile owner and repo through sanitizeGitText', () => {
  const commands = mergeCommands(
    { ...PR, owner: 'o‮', repo: 'r\u0000' },
    { method: 'merge', deleteBranch: false },
  );
  assert.doesNotMatch(commands[0] ?? '', /[‮\u0000]/);
});

// ------------------------------------------------------------- squash message

test('the squash message is the title with the number in parentheses', () => {
  assert.equal(
    defaultSquashMessage(detail()),
    'Rebalance change row content inset to 8px (#150)',
  );
});

test('the squash message folds a hostile title through sanitizeGitText', () => {
  const message = defaultSquashMessage(detail({ title: 'Fix ‮bidi (#1)' }));
  assert.doesNotMatch(message, /‮/);
  // The number is still the real one, not the one from the title text.
  assert.match(message, /\(#150\)$/);
});

test('a blank title still produces a usable subject', () => {
  const message = defaultSquashMessage(detail({ title: '   ' }));
  assert.match(message, /\(#150\)$/);
  assert.ok(message.trim().length > '150'.length, message);
});
