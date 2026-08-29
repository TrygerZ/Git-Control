/**
 * Temp-repository fixtures for the integration suites.
 *
 * Why this exists: `git.test.ts`, `bridge.test.ts`, and `repository.test.ts`
 * together call `makeRepo()` 42 times, and every call used to run `git init`, two
 * `git config`, and one or more stage/commit pairs. On Windows a single `git`
 * spawn measured 350-650 ms in this environment (antivirus scanning `git.exe`,
 * confirmed by timing `git --version` in a loop), so those spawns alone accounted
 * for roughly three minutes of the suite's wall time.
 *
 * The fix keeps the repositories real — these are integration tests and mocking
 * git would gut them. Each distinct shape is built with real git exactly ONCE per
 * test process, then copied per test with `fs.cp`. A copied `.git` is a fully
 * functional repository: `git init` writes no absolute paths into `.git/config`
 * for a normal (non-worktree, non-submodule) repo, so the copy is independent of
 * the template and of every other copy. Each test still gets its own throwaway
 * directory and still drives the same code paths against the same git binary.
 *
 * Assertions are unchanged. Nothing here weakens what the tests check; it only
 * stops re-creating identical starting states.
 */
import * as fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitRunner } from '../src/git';

/** Shapes the suites need. Add a case rather than hand-rolling a repo in a test. */
export type FixtureKind =
  /** One commit, `a.txt` containing `one\n`, on `main`. */
  | 'single'
  /** Three commits on `main` (`add one/two/three`) plus `add side` on `side`. */
  | 'triple';

/** Built templates, one per kind per process. */
const templates = new Map<FixtureKind, Promise<string>>();
/** Every directory this module created, removed on process exit. */
const created: string[] = [];
let exitHookInstalled = false;

/**
 * Windows keeps `.git` handles briefly after git exits, so a bare `rm` can lose a
 * race with the process that just wrote the index. Retrying is the fix used
 * throughout this suite.
 */
export function cleanup(dir: string): Promise<void> {
  return fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * A fresh, isolated repository of the given shape.
 *
 * The caller owns the returned path and should pass it to {@link cleanup} from
 * `t.after`.
 */
export async function makeFixture(kind: FixtureKind = 'single'): Promise<string> {
  const template = await templateFor(kind);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `git-control-${kind}-`));
  await fs.cp(template, dir, { recursive: true });
  return dir;
}

function templateFor(kind: FixtureKind): Promise<string> {
  const existing = templates.get(kind);
  if (existing !== undefined) return existing;
  const building = buildTemplate(kind);
  templates.set(kind, building);
  return building;
}

async function buildTemplate(kind: FixtureKind): Promise<string> {
  installExitHook();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `git-control-tpl-${kind}-`));
  created.push(dir);
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  await git.run(['init', '--quiet', '--initial-branch=main']);
  await git.run(['config', 'user.email', 'test@example.com']);
  await git.run(['config', 'user.name', 'Test User']);

  if (kind === 'single') {
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\n', 'utf8');
    await git.stage(['a.txt']);
    await git.commit('initial commit');
    return dir;
  }

  for (const n of ['one', 'two', 'three']) {
    await fs.writeFile(path.join(dir, `${n}.txt`), `${n}\n`, 'utf8');
    await git.stage([`${n}.txt`]);
    await git.commit(`add ${n}`);
  }
  await git.createBranch('side', 'main');
  await fs.writeFile(path.join(dir, 'side.txt'), 'side\n', 'utf8');
  await git.stage(['side.txt']);
  await git.commit('add side');
  await git.switchBranch('main');
  return dir;
}

/** Remove the templates when the test process ends. Best effort, synchronous. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // A leftover temp directory is the OS's problem, not a test failure.
      }
    }
  });
}
