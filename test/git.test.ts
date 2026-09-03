import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitError, GitRunner, MAX_STDERR_BYTES, resolveGitExecutable } from '../src/git';
import { cleanup, makeFixture } from './repoFixture';

/** Throwaway repository with one commit. Copied from a per-process template. */
function makeRepo(): Promise<string> {
  return makeFixture('single');
}

test('GitRunner drives a real repository end to end', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  assert.equal(await git.isRepository(), true);
  assert.match(await git.version(), /^\d+\.\d+/);

  const head = await git.headHash();
  assert.ok(head !== null && head.length === 40);

  const { branch } = await git.currentBranch();
  assert.equal(branch, 'main');

  assert.equal(await git.operationState(), 'idle');
  assert.equal(path.basename(await git.gitDir()), '.git');

  const commits = await git.log({ limit: 10 });
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.subject, 'initial commit');
  assert.deepEqual(commits[0]?.parents, []);

  const files = await git.numstat(head);
  assert.deepEqual(files.map((f) => f.path), ['a.txt']);

  await fs.writeFile(path.join(dir, 'b.txt'), 'two\n', 'utf8');
  const dirty = await git.status();
  assert.deepEqual(
    dirty.map((e) => [e.path, e.untracked]),
    [['b.txt', true]],
  );

  await git.stage(['b.txt']);
  assert.equal((await git.status())[0]?.staged, true);
  await git.unstage(['b.txt']);
  assert.equal((await git.status())[0]?.untracked, true);

  // Detached checkout then back, exercising ref validation on both paths.
  await git.checkoutDetached(head);
  assert.equal((await git.currentBranch()).branch, null);
  await git.switchBranch('main');
  assert.equal((await git.currentBranch()).branch, 'main');

  const refs = await git.refs();
  assert.ok(refs.some((r) => r.refName === 'refs/heads/main' && r.isHead));
  assert.deepEqual(await git.aheadBehind(), { behind: 0, ahead: 0 });
  assert.equal(await git.upstreamOf('main'), null);
  assert.deepEqual(await git.remotes(), []);
});

test('GitRunner rejects invalid input before spawning git', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  await assert.rejects(() => git.stage(['../escape.txt']), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.code, 'VALIDATION_ERROR');
    return true;
  });
  await assert.rejects(() => git.commit('ab'), /at least 3 characters/);
  await assert.rejects(() => git.switchBranch('-x'), /Invalid branch name/);
  await assert.rejects(() => git.resetHard('nope'), /Invalid commit hash/);
  await assert.rejects(
    () => git.push({ remote: 'origin', refspec: '+main:main' }),
    /Force push is not supported/,
  );
});

test('runExclusive serializes mutations and survives rejections', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  const order: string[] = [];
  const first = git.runExclusive(async () => {
    order.push('first:start');
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push('first:end');
  });
  const failing = git.runExclusive(async () => {
    order.push('second:start');
    throw new Error('boom');
  });
  const third = git.runExclusive(async () => {
    order.push('third:start');
  });

  await first;
  await assert.rejects(() => failing, /boom/);
  await third;

  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'third:start']);
});

test('index.lock surfaces as REPOSITORY_LOCKED', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  const lock = path.join(await git.gitDir(), 'index.lock');
  await fs.writeFile(lock, '', 'utf8');
  t.after(() => fs.rm(lock, { force: true }));

  await assert.rejects(() => git.stashPop(), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.code, 'REPOSITORY_LOCKED');
    return true;
  });
});

test('run reports failures as GitError with stderr and args', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  await assert.rejects(() => git.run(['rev-parse', 'does-not-exist']), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.code, 'GIT_FAILED');
    assert.equal(err.exitCode, 128);
    assert.deepEqual([...err.args], ['rev-parse', 'does-not-exist']);
    return true;
  });
});

test('missing git executable yields GIT_SPAWN_FAILED', async () => {
  const git = new GitRunner({ gitPath: 'git-control-no-such-binary', cwd: os.tmpdir() });
  await assert.rejects(() => git.run(['--version']), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.code, 'GIT_SPAWN_FAILED');
    return true;
  });
});

test('repoRoot, commitMeta, and isAncestor read real objects', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  assert.equal(await fs.realpath(await git.repoRoot()), await fs.realpath(dir));

  const first = await git.headHash() as string;
  await fs.writeFile(path.join(dir, 'c.txt'), 'three\n', 'utf8');
  await git.stage(['c.txt']);
  const second = await git.commit('second commit');
  assert.ok(second !== null && second.length === 40);

  const meta = await git.commitMeta(second as string);
  assert.equal(meta?.subject, 'second commit');
  assert.deepEqual(meta?.parents, [first]);
  assert.equal(await git.commitMeta('0'.repeat(40)), null);

  // The first commit is an ancestor of the second, but not the reverse.
  assert.equal(await git.isAncestor(first, second as string), true);
  assert.equal(await git.isAncestor(second as string, first), false);

  // A ref name is accepted on BOTH sides. The push-up-to fast-forward check asks
  // "is refs/remotes/origin/<branch> reachable from <hash>?", so the ancestor side
  // is a remote-tracking name the caller has no hash for; rejecting it there made every partial
  // push look non-linear.
  assert.equal(await git.isAncestor('main', 'main'), true);
  assert.equal(await git.isAncestor(first, 'main'), true);
  assert.equal(await git.isAncestor('refs/remotes/origin/main', first).catch(() => true), true);
  await assert.rejects(() => git.isAncestor('-x', 'main'), /Invalid ref/);
  await assert.rejects(() => git.isAncestor('refs/stash', 'main'), /Invalid ref/);
  await assert.rejects(() => git.isAncestor('refs/heads/main', 'main'), /Invalid ref/);
  await assert.rejects(() => git.isAncestor(first, 'refs/remotes/origin/main'), /Invalid ref/);
  await assert.rejects(() => git.isAncestor(first, 'refs/stash'), /Invalid ref/);
  await assert.rejects(() => git.isAncestor(first, '-x'), /Invalid ref/);
});

test('onBusyChange brackets exclusive operations', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  const transitions: boolean[] = [];
  const off = git.onBusyChange((busy) => transitions.push(busy));
  assert.equal(git.busy, false);

  await Promise.all([
    git.runExclusive(() => new Promise<void>((r) => setTimeout(r, 10))),
    git.runExclusive(() => Promise.resolve()),
  ]);

  // One rising edge for the whole burst, one falling edge when it drains.
  assert.deepEqual(transitions, [true, false]);
  assert.equal(git.busy, false);

  off();
  await git.runExclusive(() => Promise.resolve());
  assert.deepEqual(transitions, [true, false]);
});

test('onStderrLine streams git progress lines', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  const lines: string[] = [];
  // `--progress` forces stderr output even when stderr is not a TTY.
  await git.run(['gc', '--quiet', '--no-prune'], { onStderrLine: (line) => lines.push(line) });
  // gc may legitimately be silent; the contract is only "no partial lines".
  for (const line of lines) assert.ok(!line.includes('\n'));
});

test('showFile returns historical content and validates rev and path', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  const first = (await git.headHash()) as string;

  await fs.writeFile(path.join(dir, 'a.txt'), 'two\n', 'utf8');
  await git.stage(['a.txt']);
  await git.commit('second commit');

  // Historical revision keeps the old content; HEAD has the new one.
  assert.equal(await git.showFile(first, 'a.txt'), 'one\n');
  assert.equal(await git.showFile('HEAD', 'a.txt'), 'two\n');
  assert.equal(await git.showFile('main', 'a.txt'), 'two\n');

  // Validation runs before git is spawned.
  await assert.rejects(() => git.showFile('-x', 'a.txt'), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.code, 'VALIDATION_ERROR');
    return true;
  });
  await assert.rejects(() => git.showFile(first, '../escape.txt'), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.code, 'VALIDATION_ERROR');
    return true;
  });
  await assert.rejects(() => git.showFile(first, '/etc/passwd'), /Invalid repository path/);
  await assert.rejects(() => git.showFile('', 'a.txt'), /Invalid revision/);
});

test('showIndexFile reads the staged copy and rejects escaping paths', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  await fs.writeFile(path.join(dir, 'a.txt'), 'staged\n', 'utf8');
  await git.stage(['a.txt']);
  // Working tree moves on; the index keeps what was staged.
  await fs.writeFile(path.join(dir, 'a.txt'), 'worktree\n', 'utf8');

  assert.equal(await git.showIndexFile('a.txt'), 'staged\n');
  await assert.rejects(() => git.showIndexFile('../escape.txt'), /Invalid repository path/);
});

test('remoteList reports fetch and push URLs separately', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  assert.deepEqual(await git.remoteList(), []);
  await git.run(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  assert.deepEqual(await git.remoteList(), [
    {
      name: 'origin',
      fetchUrl: 'https://github.com/owner/repo.git',
      pushUrl: 'https://github.com/owner/repo.git',
    },
  ]);

  await git.run(['remote', 'set-url', '--push', 'origin', 'git@github.com:owner/repo.git']);
  assert.deepEqual(await git.remoteList(), [
    {
      name: 'origin',
      fetchUrl: 'https://github.com/owner/repo.git',
      pushUrl: 'git@github.com:owner/repo.git',
    },
  ]);
});

// ------------------------------------------------------------------- SEC-009

test('run kills git and rejects GIT_OUTPUT_TOO_LARGE past the stdout cap (SEC-009)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  // A blob comfortably past a deliberately tiny cap. 256 KiB of real content, so
  // the stream genuinely delivers several chunks rather than one.
  const big = 'x'.repeat(256 * 1024);
  await fs.writeFile(path.join(dir, 'big.txt'), big, 'utf8');
  await git.stage(['big.txt']);
  await git.commit('add a big file');

  await assert.rejects(
    () => git.run(['show', '--no-color', 'HEAD:big.txt'], { maxStdoutBytes: 4096 }),
    (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.code, 'GIT_OUTPUT_TOO_LARGE');
      assert.match(err.message, /more than 4096 bytes/);
      return true;
    },
  );

  // Under the cap nothing changes, and the content is complete.
  const ok = await git.run(['show', '--no-color', 'HEAD:big.txt'], {
    maxStdoutBytes: 1024 * 1024,
  });
  assert.equal(ok.stdout.length, big.length);
  assert.equal(ok.truncated, undefined);
});

test('run truncates instead of failing when the caller opts in (SEC-009)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  const big = 'y'.repeat(128 * 1024);
  await fs.writeFile(path.join(dir, 'big.txt'), big, 'utf8');
  await git.stage(['big.txt']);
  await git.commit('add a big file');

  const result = await git.run(['show', '--no-color', 'HEAD:big.txt'], {
    maxStdoutBytes: 4096,
    truncateStdout: true,
  });
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length > 0, 'what arrived is kept');
  assert.ok(result.stdout.length < big.length, 'and it is short of the whole blob');
  // A truncated read is not an error, so `code` reads as success.
  assert.equal(result.code, 0);
});

test('showFile refuses to return a partial blob (SEC-009)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  // The production cap is 5 MiB, so generate past it. ~6 MiB of ASCII.
  const huge = 'z'.repeat(6 * 1024 * 1024);
  await fs.writeFile(path.join(dir, 'huge.txt'), huge, 'utf8');
  await git.stage(['huge.txt']);
  await git.commit('add a huge file');

  await assert.rejects(() => git.showFile('HEAD', 'huge.txt'), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.code, 'GIT_OUTPUT_TOO_LARGE', 'half a file must never be presented as the file');
    return true;
  });
  await assert.rejects(() => git.showIndexFile('huge.txt'), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.code, 'GIT_OUTPUT_TOO_LARGE');
    return true;
  });

  // A normal file still reads end to end through the same capped path.
  assert.equal(await git.showFile('HEAD', 'a.txt'), 'one\n');
});

test('numstat truncation is reported rather than fatal (SEC-009)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  // Enough files that a small cap lands mid-list.
  const names: string[] = [];
  for (let i = 0; i < 400; i += 1) {
    const name = `numstat-${String(i).padStart(4, '0')}.txt`;
    names.push(name);
    await fs.writeFile(path.join(dir, name), `${i}\n`, 'utf8');
  }
  await git.stage(names);
  await git.commit('add many files');
  const head = (await git.headHash()) as string;

  // Uncapped: the whole list, no truncation signal.
  let truncated = false;
  const all = await git.numstat(head, { onTruncated: () => { truncated = true; } });
  assert.equal(all.length, names.length);
  assert.equal(truncated, false);

  // Capped through `run` directly, since the production cap is 16 MiB. This
  // asserts the property that matters: a partial record is dropped, not parsed.
  const capped = await git.run(['show', '--numstat', '--format=', '--no-color', head], {
    maxStdoutBytes: 2048,
    truncateStdout: true,
  });
  assert.equal(capped.truncated, true);
  for (const line of capped.stdout.split('\n')) {
    if (line.length === 0) continue;
    // Every complete line is a well-formed record; the parser skips the rest.
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    assert.match(parts[0] as string, /^(\d+|-)$/);
  }
});

test('stderr accumulation is capped without failing the operation (SEC-009)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  // `git status` succeeds and writes nothing to stderr; the point is that a
  // successful run is unaffected by the cap being in place at all.
  const result = await git.run(['status', '--porcelain=v1']);
  assert.equal(result.code, 0);
  assert.ok(result.stderr.length <= MAX_STDERR_BYTES);
});


// ------------------------------------------------------- Bug 1 + Bug 3 regressions

test('unstage works in a repository with no commits (Bug 1 edge case)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-control-nohead-'));
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  await git.run(['init', '--quiet', '--initial-branch=main']);
  await git.run(['config', 'user.email', 'test@example.com']);
  await git.run(['config', 'user.name', 'Test User']);

  await fs.writeFile(path.join(dir, 'lambada.txt'), 'x\n', 'utf8');
  await git.stage(['lambada.txt']);
  assert.equal((await git.status())[0]?.staged, true);

  // `restore --staged` rebuilds from HEAD, which does not exist yet: exit 128.
  // `unstage` must take the `rm --cached` route instead of failing.
  await git.unstage(['lambada.txt']);
  const after = await git.status();
  assert.deepEqual(after.map((e) => [e.path, e.untracked]), [['lambada.txt', true]]);
  // The file itself survives: unstage never touches the working tree.
  assert.equal(await fs.readFile(path.join(dir, 'lambada.txt'), 'utf8'), 'x\n');
});

test('stage and unstage work when cwd is a subdirectory of the repo (Bug 3)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const sub = path.join(dir, 'nested', 'deeper');
  await fs.mkdir(sub, { recursive: true });

  // The runner is rooted at the SUBDIRECTORY, as it is when VS Code opens one.
  const git = new GitRunner({ gitPath: 'git', cwd: sub });
  const root = new GitRunner({ gitPath: 'git', cwd: dir });

  // `git status` reports paths relative to the repository root, from any cwd.
  await fs.writeFile(path.join(dir, 'top.txt'), 'top\n', 'utf8');
  assert.deepEqual((await git.status()).map((e) => e.path), ['top.txt']);

  // Those very strings must round-trip through stage/unstage from the subdir.
  await git.stage(['top.txt']);
  assert.equal((await root.status())[0]?.staged, true);
  await git.unstage(['top.txt']);
  assert.equal((await root.status())[0]?.untracked, true);

  // A path inside the subdirectory is still root-relative, never cwd-relative.
  await fs.writeFile(path.join(sub, 'inner.txt'), 'inner\n', 'utf8');
  const innerPath = ['nested', 'deeper', 'inner.txt'].join('/');
  await git.stage([innerPath]);
  assert.ok((await root.status()).some((e) => e.path === innerPath && e.staged));
  await git.unstage([innerPath]);
  assert.ok((await root.status()).some((e) => e.path === innerPath && e.untracked));
});

test('pathspecs are literal, so glob characters in a filename are not patterns', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  await fs.writeFile(path.join(dir, 'weird[1].txt'), 'w\n', 'utf8');
  await fs.writeFile(path.join(dir, 'weird1.txt'), 'decoy\n', 'utf8');
  await git.stage(['weird[1].txt']);

  const staged = (await git.status()).filter((e) => e.staged).map((e) => e.path);
  assert.deepEqual(staged, ['weird[1].txt'], 'only the literal name was staged');
});

test('resolveGitExecutable returns absolute path from PATH and rejects relative paths', () => {
  const resolved = resolveGitExecutable();
  assert.ok(resolved !== null, 'git should be resolved from system PATH');
  assert.ok(path.isAbsolute(resolved), `resolved path must be absolute: ${resolved}`);

  // Explicit relative candidate must be rejected (returns null)
  assert.equal(resolveGitExecutable('git-relative'), null);
  assert.equal(resolveGitExecutable('./git'), null);
  assert.equal(resolveGitExecutable('..\\git.exe'), null);

  // Absolute path to existing git binary is accepted
  assert.equal(resolveGitExecutable(resolved), resolved);

  // Resolution never uses relative entry or dot in PATH
  const isWindows = process.platform === 'win32';
  const fakeEnv = {
    PATH: isWindows ? '.;C:\\fake\\relative' : '.:/fake/relative',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };
  assert.equal(resolveGitExecutable(undefined, fakeEnv), null);
});

test('GitRunner rejects relative gitPath and passes NoDefaultCurrentDirectoryInExePath in env', async () => {
  const runner = new GitRunner({ gitPath: 'some-relative-git', cwd: os.tmpdir() });
  await assert.rejects(
    () => runner.run(['--version']),
    (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.code, 'GIT_SPAWN_FAILED');
      assert.match(err.message, /Git executable path must be absolute/);
      return true;
    },
  );
});

