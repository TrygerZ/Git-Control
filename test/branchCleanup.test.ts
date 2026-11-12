/**
 * Cleanup candidate selection (P20).
 *
 * The dialog may only offer branches git itself would agree are safe: a local
 * branch, marked merged, not the current one, and not the base branch. The
 * `merged` flag is advisory (D-21), so this file pins the narrowing; git's own
 * refusal is what actually protects the work, and it is tested against the real
 * binary in `git.test.ts`.
 *
 * Input is `BranchRef[]`, not the plan's `RefInfo[]`: `merged` is added by
 * `RepositoryService.refs()` and does not exist on a bare `RefInfo`, so the
 * narrower type is the honest one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCleanupCandidates } from '../src/branchCleanup';
import type { BranchRef } from '../src/messages';

function ref(over: Partial<BranchRef> & { shortName: string }): BranchRef {
  return {
    ...over,
    refName: over.refName ?? `refs/heads/${over.shortName}`,
    shortName: over.shortName,
    kind: over.kind ?? 'local',
    objectName: over.objectName ?? '0123456789abcdef0123456789abcdef01234567',
    upstream: over.upstream ?? null,
    ahead: over.ahead ?? 0,
    behind: over.behind ?? 0,
    isHead: over.isHead ?? false,
    gone: over.gone ?? false,
    committedAt: over.committedAt ?? null,
    merged: over.merged ?? false,
  };
}

test('a merged local branch that is neither current nor base is a candidate', () => {
  const refs = [ref({ shortName: 'main', isHead: true }), ref({ shortName: 'feat/a', merged: true })];
  const out = selectCleanupCandidates(refs, 'main', 'main');
  assert.deepEqual(out.map((c) => c.name), ['feat/a']);
});

test('the current branch, the base branch, and unmerged branches are excluded', () => {
  const refs = [
    ref({ shortName: 'main', isHead: true }),
    ref({ shortName: 'develop', merged: true }),
    ref({ shortName: 'feat/current', merged: true, isHead: true }),
    ref({ shortName: 'feat/unmerged', merged: false }),
  ];
  const out = selectCleanupCandidates(refs, 'feat/current', 'develop');
  assert.deepEqual(out.map((c) => c.name), [], 'nothing is safe here');
});

test('remote, tag, and other refs are never candidates, even when flagged merged', () => {
  const refs = [
    ref({ shortName: 'origin/feat/a', kind: 'remote', refName: 'refs/remotes/origin/feat/a', merged: true }),
    ref({ shortName: 'v1.0.0', kind: 'tag', refName: 'refs/tags/v1.0.0', merged: true }),
    ref({ shortName: 'stash', kind: 'other', refName: 'refs/stash', merged: true }),
    ref({ shortName: 'feat/a', merged: true }),
  ];
  const out = selectCleanupCandidates(refs, 'main', 'main');
  assert.deepEqual(out.map((c) => c.name), ['feat/a']);
});

test('upstream-gone and merged-at facts are carried for the row', () => {
  const at = '2026-11-01T10:00:00.000Z';
  const refs = [
    ref({ shortName: 'feat/gone', merged: true, gone: true, committedAt: at, upstream: 'refs/remotes/origin/feat/gone' }),
    ref({ shortName: 'feat/plain', merged: true, committedAt: at, upstream: 'refs/remotes/origin/feat/plain' }),
  ];
  const out = selectCleanupCandidates(refs, 'main', 'main');
  const byName = new Map(out.map((c) => [c.name, c]));
  assert.equal(byName.get('feat/gone')?.upstreamGone, true);
  assert.equal(byName.get('feat/plain')?.upstreamGone, false);
  assert.equal(byName.get('feat/gone')?.mergedAt, at);
  assert.equal(byName.get('feat/plain')?.mergedAt, at);
});

test('the remote that still carries the branch is reported, and null when none does', () => {
  const refs = [
    ref({ shortName: 'feat/on-origin', merged: true, upstream: 'refs/remotes/origin/feat/on-origin' }),
    ref({ shortName: 'origin/feat/on-origin', refName: 'refs/remotes/origin/feat/on-origin', kind: 'remote' }),
    ref({ shortName: 'feat/local-only', merged: true }),
  ];
  const out = selectCleanupCandidates(refs, 'main', 'main');
  const byName = new Map(out.map((c) => [c.name, c]));
  assert.equal(byName.get('feat/on-origin')?.remote, 'origin');
  assert.equal(byName.get('feat/local-only')?.remote, null);
});

/**
 * A tracking ref that was pruned away is the one case where the upstream config
 * still names a remote that no longer has the branch. Reporting `origin` there
 * would offer a remote delete git answers with "remote ref does not exist".
 */
test('a gone upstream reports no remote even though the config still names one', () => {
  const refs = [
    ref({
      shortName: 'feat/gone',
      merged: true,
      gone: true,
      upstream: 'refs/remotes/origin/feat/gone',
    }),
  ];
  assert.equal(selectCleanupCandidates(refs, 'main', 'main')[0]?.remote, null);
});

test('ordering is stable: the input order is preserved', () => {
  const refs = [
    ref({ shortName: 'zeta', merged: true }),
    ref({ shortName: 'alpha', merged: true }),
    ref({ shortName: 'mid', merged: true }),
  ];
  const out = selectCleanupCandidates(refs, 'main', 'main');
  assert.deepEqual(out.map((c) => c.name), ['zeta', 'alpha', 'mid']);
});

test('a detached HEAD with no current branch still offers merged branches', () => {
  const refs = [ref({ shortName: 'main' }), ref({ shortName: 'feat/a', merged: true })];
  const out = selectCleanupCandidates(refs, null, 'main');
  assert.deepEqual(out.map((c) => c.name), ['feat/a']);
});

test('an empty ref list yields no candidates', () => {
  assert.deepEqual(selectCleanupCandidates([], 'main', 'main'), []);
});

/**
 * Gate finding. The upstream config can name a remote that carries a DIFFERENT
 * branch name (`foo` tracking `origin/bar`). The store deletes
 * `refs/remotes/<remote>/<local>`, which does not exist in that case, so the
 * selector must not offer a remote there: it would be offered, skipped, and the
 * run would report a cleanup that did not happen.
 */
test('a remote is offered only when it carries the branch under its own name', () => {
  const refs = [
    ref({ shortName: 'foo', merged: true, upstream: 'refs/remotes/origin/bar' }),
    ref({ shortName: 'origin/bar', refName: 'refs/remotes/origin/bar', kind: 'remote' }),
  ];
  assert.equal(selectCleanupCandidates(refs, 'main', 'main')[0]?.remote, null);
});

test('a branch tracking its own name on a remote is offered that remote', () => {
  const refs = [
    ref({ shortName: 'feat/a', merged: true, upstream: 'refs/remotes/upstream/feat/a' }),
    ref({ shortName: 'upstream/feat/a', refName: 'refs/remotes/upstream/feat/a', kind: 'remote' }),
  ];
  assert.equal(selectCleanupCandidates(refs, 'main', 'main')[0]?.remote, 'upstream');
});
