import test from 'node:test';
import assert from 'node:assert/strict';
import { GitRunner } from '../src/git';
import { parseRefNameList, parseTrack, parseWorktrees } from '../src/gitParse';
import { pickBaseBranch } from '../src/repository';
import { cleanup, makeFixture } from './repoFixture';

test('parseTrack reads ahead, behind, and the gone marker', () => {
  assert.deepEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false });
  assert.deepEqual(parseTrack('[ahead 2]'), { ahead: 2, behind: 0, gone: false });
  assert.deepEqual(parseTrack('[behind 1]'), { ahead: 0, behind: 1, gone: false });
  assert.deepEqual(parseTrack('[ahead 2, behind 1]'), { ahead: 2, behind: 1, gone: false });
  assert.deepEqual(parseTrack('[gone]'), { ahead: 0, behind: 0, gone: true });
  // An unknown shape degrades to "nothing known" rather than throwing.
  assert.deepEqual(parseTrack('[something new]'), { ahead: 0, behind: 0, gone: false });
});

test('parseWorktrees reads every porcelain block shape', () => {
  const raw = [
    'worktree C:/repo',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree C:/repo-linked',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/feature',
    'locked reason text',
    '',
    'worktree C:/repo-locked',
    'HEAD 3333333333333333333333333333333333333333',
    'branch refs/heads/other',
    'locked',
    '',
    'worktree C:/repo-detached',
    'HEAD 4444444444444444444444444444444444444444',
    'detached',
    'prunable gitdir file points to non-existent location',
    '',
    'worktree C:/repo-bare.git',
    'bare',
    '',
  ].join('\n');
  assert.deepEqual(parseWorktrees(raw), [
    {
      path: 'C:/repo',
      head: '1111111111111111111111111111111111111111',
      branch: 'refs/heads/main',
      detached: false,
      bare: false,
      locked: null,
      prunable: null,
    },
    {
      path: 'C:/repo-linked',
      head: '2222222222222222222222222222222222222222',
      branch: 'refs/heads/feature',
      detached: false,
      bare: false,
      locked: 'reason text',
      prunable: null,
    },
    {
      path: 'C:/repo-locked',
      head: '3333333333333333333333333333333333333333',
      branch: 'refs/heads/other',
      detached: false,
      bare: false,
      locked: '',
      prunable: null,
    },
    {
      path: 'C:/repo-detached',
      head: '4444444444444444444444444444444444444444',
      branch: null,
      detached: true,
      bare: false,
      locked: null,
      prunable: 'gitdir file points to non-existent location',
    },
    {
      path: 'C:/repo-bare.git',
      head: null,
      branch: null,
      detached: false,
      bare: true,
      locked: null,
      prunable: null,
    },
  ]);
  assert.deepEqual(parseWorktrees(''), []);
});

test('parseRefNameList handles empty input and CRLF', () => {
  assert.deepEqual(parseRefNameList(''), []);
  assert.deepEqual(parseRefNameList('\r\n\r\n'), []);
  assert.deepEqual(parseRefNameList('refs/heads/main\r\nrefs/heads/feat/ahead\r\n'), [
    'refs/heads/main',
    'refs/heads/feat/ahead',
  ]);
});

test('pickBaseBranch prefers the origin head, then main, then master, then current', () => {
  const locals = ['main', 'master', 'develop'];
  assert.equal(pickBaseBranch({ locals, originHead: 'origin/develop', current: 'main' }), 'develop');
  assert.equal(pickBaseBranch({ locals, originHead: 'origin/missing', current: 'master' }), 'main');
  assert.equal(pickBaseBranch({ locals: ['master', 'develop'], originHead: null, current: 'develop' }), 'master');
  assert.equal(pickBaseBranch({ locals: ['develop'], originHead: null, current: 'develop' }), 'develop');
  // Detached HEAD in a repo with no conventional branch: no base, nothing is merged.
  assert.equal(pickBaseBranch({ locals: ['develop'], originHead: null, current: null }), null);
  assert.equal(pickBaseBranch({ locals: [], originHead: null, current: null }), null);
});

/**
 * Shape of the `branches` fixture, asserted through the real git binary only.
 *
 * The rest of the suite builds on it: `merged-local` is reachable from `main`,
 * `feat/ahead` sits two commits past its upstream, `gone-upstream` keeps its
 * upstream config while the tracking ref was pruned away, `local-only` is
 * unmerged with no upstream, both a lightweight and an annotated tag exist, and
 * a stash entry makes `refs/stash` a real `other` ref for the filter tests.
 */
test('branches fixture carries merged, ahead, gone, local-only refs, a stash, and two tags', async (t) => {
  const dir = await makeFixture('branches');
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  const refs = await git.refs();
  const byName = new Map(refs.map((r) => [r.refName, r]));
  assert.deepEqual([...byName.keys()].sort(), [
    'refs/heads/feat/ahead',
    'refs/heads/gone-upstream',
    'refs/heads/local-only',
    'refs/heads/main',
    'refs/heads/merged-local',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/feat/ahead',
    'refs/remotes/origin/main',
    'refs/stash',
    'refs/tags/v1.0.0',
    'refs/tags/v1.1.0',
  ]);

  const gone = byName.get('refs/heads/gone-upstream');
  assert.equal(gone?.upstream, 'refs/remotes/origin/gone-upstream');
  assert.equal(gone?.track, '[gone]');

  const ahead = byName.get('refs/heads/feat/ahead');
  assert.equal(ahead?.track, '[ahead 2]');
  assert.equal(ahead?.committedAt !== null && ahead?.committedAt !== undefined, true);

  // A lightweight tag reports its commit's date, an annotated tag its tagger date.
  assert.equal(typeof byName.get('refs/tags/v1.0.0')?.committedAt, 'string');
  assert.equal(typeof byName.get('refs/tags/v1.1.0')?.committedAt, 'string');
  // Every ref carries the field, so no consumer has to branch on its presence.
  for (const ref of refs) assert.equal(ref.committedAt === null || typeof ref.committedAt === 'string', true, ref.refName);

  const { branch } = await git.currentBranch();
  assert.equal(branch, 'main');
});

/**
 * A linked worktree is created inside the test, never in the template: `fs.cp`
 * copies each worktree's `gitdir` file as an absolute path, so a template
 * worktree would point every copy at the template's own directory.
 */
test('worktrees lists a linked worktree with exactly one current entry', async (t) => {
  const dir = await makeFixture('single');
  const linked = `${dir}-linked`;
  t.after(() => cleanup(linked));
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  await git.run(['worktree', 'add', '--quiet', '-b', 'linked-branch', linked]);

  const entries = await git.worktrees();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.branch).sort(),
    ['refs/heads/linked-branch', 'refs/heads/main'],
  );
  for (const entry of entries) {
    assert.equal(entry.detached, false);
    assert.equal(entry.bare, false);
    assert.equal(entry.locked, null);
    assert.equal(entry.prunable, null);
  }
});
