/**
 * Self-check for `test/fixture.ts`.
 *
 * A fixture builder nobody has run is a liability: a test written against it later
 * fails for reasons that have nothing to do with the product. The PRD sync cases
 * use only a slice of the builder surface, so this file exercises the rest —
 * topology, file states, the hook installer, and Windows cleanup — once.
 *
 * The hook installer in particular is verified rather than assumed: a `#!/bin/sh`
 * hook is supposed to run under Git for Windows' bundled `sh`, and "supposed to"
 * is not evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitError } from '../src/git';
import { makeRepo } from './fixture';

test('fixture builds every topology shape with stable hashes', async (t) => {
  const repo = await makeRepo({ commits: 3, label: 'fx-topo' });
  t.after(() => repo.cleanup());

  const log = await repo.git.log({ limit: 10, all: false });
  assert.deepEqual(
    log.map((c) => c.subject),
    ['add c3.txt', 'add c2.txt', 'add c1.txt'],
  );
  // Identity and both dates are pinned, so the whole chain is reproducible.
  assert.equal(log[0]?.authorName, 'Fixture User');
  assert.equal(log[0]?.authoredAt, log[0]?.committedAt);

  const sideTip = await repo.fork('side');
  assert.equal((await repo.git.currentBranch()).branch, repo.branch, 'fork returns to the base branch');
  assert.equal(await repo.git.isAncestor(sideTip, 'side'), true);
  assert.equal(await repo.git.isAncestor(sideTip, repo.branch), false, 'side really diverges');

  const merge = await repo.mergeCommit('side');
  const meta = await repo.git.commitMeta(merge);
  assert.equal(meta?.parents.length, 2, 'a real merge commit, not a fast-forward');

  const detached = await repo.detach();
  assert.equal((await repo.git.currentBranch()).branch, null);
  assert.equal((await repo.git.currentBranch()).head, detached);
  await repo.git.switchBranch(repo.branch);
});

test('fixture leaves a real conflict mid-merge', async (t) => {
  const repo = await makeRepo({ commits: 1, label: 'fx-conflict' });
  t.after(() => repo.cleanup());

  const file = await repo.conflict();
  assert.equal(await repo.git.operationState(), 'merge');
  const conflicted = (await repo.git.status()).filter((e) => e.conflicted);
  assert.deepEqual(conflicted.map((e) => e.path), [file]);
  await repo.git.mergeAbort();
  assert.equal(await repo.git.operationState(), 'idle');
});

test('fixture produces every working-tree file state git can report', async (t) => {
  const repo = await makeRepo({ commits: 1, label: 'fx-files' });
  t.after(() => repo.cleanup());

  const states = await repo.fileStates(
    'modified',
    'staged',
    'deleted',
    'renamed',
    'untracked',
    'binary',
    'unicode',
    'newline',
  );
  const entries = await repo.git.status();
  const byPath = new Map(entries.map((e) => [e.path, e]));

  assert.equal(byPath.get(states.modified as string)?.unstaged, true);
  assert.equal(byPath.get(states.staged as string)?.staged, true);
  assert.equal(byPath.get(states.deleted as string)?.worktreeStatus, 'D');
  assert.equal(byPath.get(states.renamed as string)?.staged, true);
  assert.equal(byPath.get(states.untracked as string)?.untracked, true);

  // Binary content survives the round trip with its NUL bytes intact.
  assert.deepEqual(
    [...(await fs.readFile(path.join(repo.dir, states.binary as string)))],
    [0x00, 0x01, 0x00, 0xff, 0x00],
  );

  // Spaces and non-ASCII in a path reach git and come back through `-z` parsing.
  const unicode = states.unicode as string;
  assert.ok(unicode.includes(' ') && /[^\u0000-\u007f]/.test(unicode));
  assert.ok(byPath.has(unicode), `status must report ${unicode}, saw ${[...byPath.keys()].join(', ')}`);

  if (process.platform === 'win32') {
    assert.equal(states.newline, undefined, 'a newline in a filename is skipped on Windows');
  } else {
    assert.ok(byPath.has(states.newline as string));
  }
});

test('the installed pre-commit hook actually fires and can reject a commit', async (t) => {
  const repo = await makeRepo({ commits: 1, label: 'fx-hook' });
  t.after(() => repo.cleanup());

  const marker = path.join(repo.dir, 'hook-ran.txt');
  await repo.installHook('pre-commit', `echo ran > "${marker.replace(/\\/g, '/')}"\nexit 1`);

  await fs.writeFile(path.join(repo.dir, 'hooked.txt'), 'x\n', 'utf8');
  await repo.git.stage(['hooked.txt']);

  await assert.rejects(
    () => repo.git.commit('this commit must be rejected'),
    (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.code, 'GIT_FAILED');
      return true;
    },
  );
  // Proof the hook ran rather than the commit failing for some other reason.
  assert.equal(await fs.readFile(marker, 'utf8'), 'ran\n');
  assert.equal((await repo.git.log({ limit: 1, all: false }))[0]?.subject, 'add c1.txt');
});

test('the bare remote is wired as a tracking origin the product can read', async (t) => {
  const repo = await makeRepo({ commits: 1, remote: true, label: 'fx-remote' });
  t.after(() => repo.cleanup());

  assert.equal(await repo.git.upstreamOf(repo.branch), `origin/${repo.branch}`);
  assert.equal(await repo.remoteHash(), await repo.git.headHash());
  assert.deepEqual(await repo.git.aheadBehind(), { ahead: 0, behind: 0 });

  // A clone of the same bare remote is an independent second writer.
  const other = await repo.cloneFromRemote('fx-clone');
  await other.chain(1, 'theirs');
  await other.git.push({ remote: 'origin', refspec: `${other.branch}:${other.branch}` });
  assert.notEqual(await repo.remoteHash(), await repo.git.headHash());
});

test('cleanup removes a repository whose git objects are read-only', async (t) => {
  const repo = await makeRepo({ commits: 2, label: 'fx-cleanup' });
  // No `t.after`: removing it IS the assertion.

  // Pack and prune so there are loose and packed objects, all read-only, which is
  // the state a plain recursive delete fails on under Windows.
  await repo.git.run(['gc', '--quiet', '--no-prune']);
  await repo.cleanup();
  assert.equal(await exists(repo.dir), false, 'the working tree is gone');
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}
