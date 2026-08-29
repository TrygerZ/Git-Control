/**
 * Git execution layer.
 *
 * Hard rules enforced here:
 *  - `spawn` with `shell: false` and an argv array. Never string interpolation.
 *  - `--` separator before every user-supplied path.
 *  - Mutations are serialized per repository through a promise-chain mutex.
 *  - No method may construct a force push. Refspecs starting with `+` are
 *    rejected, and `--force` / `--force-with-lease` are never emitted. Rewriting
 *    published history is out of scope for this extension by design.
 *  - No `vscode` import: the git executable path is injected so this module
 *    stays unit-testable.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  LOG_FORMAT,
  REFS_FORMAT,
  parseLog,
  parseRefs,
  parseRemotes,
  parseRevListCounts,
  parseShowStat,
  parseStatus,
  type AheadBehind,
  type ParsedCommit,
  type ParsedNumstatEntry,
  type ParsedRef,
  type ParsedStatusEntry,
} from './gitParse';
import {
  sanitizeRefArg,
  validateBranchName,
  validateCommitMessage,
  validateFullHash,
  validateHash,
  validateLimit,
  validateRemoteName,
  validateRepoRelativePath,
  validateStashMessage,
} from './validation';

export type GitErrorCode =
  | 'GIT_FAILED'
  | 'GIT_TIMEOUT'
  | 'GIT_SPAWN_FAILED'
  | 'REPOSITORY_LOCKED'
  | 'VALIDATION_ERROR';

export type OperationState = 'idle' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  allowedExitCodes?: number[];
}

export interface GitRunnerOptions {
  gitPath: string;
  cwd: string;
  logger?: (line: string) => void;
}

/** Typed failure carrying enough context for the UI to render an actionable error. */
export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly args: readonly string[];

  constructor(params: {
    code: GitErrorCode;
    message: string;
    exitCode?: number | null;
    stderr?: string;
    args?: readonly string[];
  }) {
    super(params.message);
    this.name = 'GitError';
    this.code = params.code;
    this.exitCode = params.exitCode ?? null;
    this.stderr = params.stderr ?? '';
    this.args = params.args ?? [];
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class GitRunner {
  private readonly gitPath: string;
  private readonly cwd: string;
  private readonly logger: (line: string) => void;
  /** Promise chain acting as a mutex so only one mutation runs at a time. */
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private gitDirCache: string | undefined;

  constructor(options: GitRunnerOptions) {
    this.gitPath = options.gitPath.length > 0 ? options.gitPath : 'git';
    this.cwd = options.cwd;
    this.logger = options.logger ?? ((): void => undefined);
  }

  /** Spawn git. Reads may run concurrently; use {@link runExclusive} to mutate. */
  async run(args: string[], opts: RunOptions = {}): Promise<GitResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const allowed = opts.allowedExitCodes ?? [0];
    this.logger(`git ${args.join(' ')}`);

    return new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.gitPath, args, {
        cwd: this.cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // On Windows `kill` terminates the process; git children are short-lived.
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new GitError({
            code: 'GIT_SPAWN_FAILED',
            message: `Failed to start git: ${err.message}`,
            args,
          }),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new GitError({
              code: 'GIT_TIMEOUT',
              message: `git timed out after ${timeoutMs}ms`,
              stderr,
              args,
            }),
          );
          return;
        }
        const exitCode = code ?? -1;
        if (!allowed.includes(exitCode)) {
          reject(
            new GitError({
              code: 'GIT_FAILED',
              message: stderr.trim().length > 0 ? stderr.trim() : `git exited with code ${exitCode}`,
              exitCode,
              stderr,
              args,
            }),
          );
          return;
        }
        resolve({ stdout, stderr, code: exitCode });
      });

      if (opts.input !== undefined) {
        child.stdin.end(opts.input, 'utf8');
      } else {
        child.stdin.end();
      }
    });
  }

  /**
   * Serialize a mutating operation. Only one runs at a time per runner, which
   * prevents concurrent index writes and the `index.lock` races they cause.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(
      () => this.assertNotLocked().then(fn),
      () => this.assertNotLocked().then(fn),
    );
    // Keep the chain alive even when a mutation rejects.
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  /** Throw REPOSITORY_LOCKED when another git process holds the index. */
  private async assertNotLocked(): Promise<void> {
    const gitDir = await this.gitDir();
    const lockPath = path.join(gitDir, 'index.lock');
    if (await pathExists(lockPath)) {
      throw new GitError({
        code: 'REPOSITORY_LOCKED',
        message: 'Another git process is running (index.lock exists).',
      });
    }
  }

  /** Real `.git` directory, worktree- and submodule-safe. */
  async gitDir(): Promise<string> {
    if (this.gitDirCache !== undefined) return this.gitDirCache;
    const { stdout } = await this.run(['rev-parse', '--absolute-git-dir']);
    this.gitDirCache = stdout.trim();
    return this.gitDirCache;
  }

  // ---------------------------------------------------------------- reads

  async isRepository(): Promise<boolean> {
    try {
      const { stdout } = await this.run(['rev-parse', '--is-inside-work-tree']);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const { stdout } = await this.run(['--version']);
    return stdout.trim().replace(/^git version\s*/, '');
  }

  /** Current branch name, or `null` when HEAD is detached. */
  async currentBranch(): Promise<{ branch: string | null; head: string | null }> {
    const head = await this.headHash();
    const { stdout } = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      allowedExitCodes: [0, 1],
    });
    const branch = stdout.trim();
    return { branch: branch.length > 0 ? branch : null, head };
  }

  /** HEAD object id, or `null` in a repository without commits. */
  async headHash(): Promise<string | null> {
    const { stdout, code } = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      allowedExitCodes: [0, 1],
    });
    if (code !== 0) return null;
    const hash = stdout.trim();
    return validateFullHash(hash) ? hash : null;
  }

  async log(opts: { limit?: number; skip?: number; all?: boolean } = {}): Promise<ParsedCommit[]> {
    const limit = opts.limit ?? 500;
    if (!validateLimit(limit)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid commit limit: ${String(limit)}` });
    }
    const skip = opts.skip ?? 0;
    if (!Number.isInteger(skip) || skip < 0) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid skip: ${String(skip)}` });
    }
    const args = ['log', LOG_FORMAT, `--max-count=${limit}`, '--topo-order'];
    if (skip > 0) args.push(`--skip=${skip}`);
    if (opts.all !== false) args.push('--all');
    const { stdout } = await this.run(args);
    return parseLog(stdout);
  }

  async status(opts: { includeIgnored?: boolean } = {}): Promise<ParsedStatusEntry[]> {
    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
    if (opts.includeIgnored === true) args.push('--ignored=matching');
    const { stdout } = await this.run(args);
    return parseStatus(stdout);
  }

  async refs(): Promise<ParsedRef[]> {
    const { stdout } = await this.run(['for-each-ref', `--format=${REFS_FORMAT}`]);
    return parseRefs(stdout);
  }

  async remotes(): Promise<Array<{ name: string; url: string }>> {
    const { stdout } = await this.run(['remote', '-v']);
    return parseRemotes(stdout);
  }

  /** Upstream ref of a branch, or `null` when it has none. */
  async upstreamOf(branch: string): Promise<string | null> {
    this.assertBranch(branch);
    const { stdout, code } = await this.run(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', sanitizeRefArg(`${branch}@{upstream}`)],
      { allowedExitCodes: [0, 128] },
    );
    if (code !== 0) return null;
    const upstream = stdout.trim();
    return upstream.length > 0 ? upstream : null;
  }

  /** Ahead/behind counts of HEAD against its upstream. Zeros when no upstream. */
  async aheadBehind(): Promise<AheadBehind> {
    const { stdout, code } = await this.run(
      ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      { allowedExitCodes: [0, 128] },
    );
    if (code !== 0) return { behind: 0, ahead: 0 };
    return parseRevListCounts(stdout);
  }

  async show(hash: string): Promise<string> {
    this.assertHash(hash);
    const { stdout } = await this.run(['show', '--no-color', sanitizeRefArg(hash)]);
    return stdout;
  }

  async numstat(hash: string): Promise<ParsedNumstatEntry[]> {
    this.assertHash(hash);
    const { stdout } = await this.run([
      'show',
      '--numstat',
      '--format=',
      '--no-color',
      sanitizeRefArg(hash),
    ]);
    return parseShowStat(stdout);
  }

  /** Detect an in-progress git operation by inspecting `.git` marker files. */
  async operationState(): Promise<OperationState> {
    const gitDir = await this.gitDir();
    const checks: Array<[string, OperationState]> = [
      ['MERGE_HEAD', 'merge'],
      ['rebase-merge', 'rebase'],
      ['rebase-apply', 'rebase'],
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'],
      ['BISECT_LOG', 'bisect'],
    ];
    for (const [marker, state] of checks) {
      if (await pathExists(path.join(gitDir, marker))) return state;
    }
    return 'idle';
  }

  // ------------------------------------------------------------ mutations

  async stage(paths: string[]): Promise<void> {
    const safe = this.assertPaths(paths);
    await this.runExclusive(() => this.run(['add', '--', ...safe]));
  }

  async unstage(paths: string[]): Promise<void> {
    const safe = this.assertPaths(paths);
    await this.runExclusive(() => this.run(['restore', '--staged', '--', ...safe]));
  }

  /** Message goes over stdin via `-F -`, never as an argv string. */
  async commit(message: string, opts: { amend?: boolean } = {}): Promise<void> {
    const check = validateCommitMessage(message);
    if (!check.ok) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: check.message ?? 'Invalid commit message.' });
    }
    const args = ['commit', '-F', '-'];
    if (opts.amend === true) args.push('--amend');
    await this.runExclusive(() => this.run(args, { input: check.message }));
  }

  /**
   * Push without force. A refspec starting with `+` requests a force update and
   * is rejected here, so this method can never rewrite published history.
   */
  async push(opts: { remote: string; refspec: string; setUpstream?: boolean }): Promise<void> {
    if (!validateRemoteName(opts.remote)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid remote name: ${opts.remote}` });
    }
    if (opts.refspec.startsWith('+')) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: 'Force push is not supported.' });
    }
    const [source] = opts.refspec.split(':');
    if (source === undefined || !validateBranchName(source)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid refspec: ${opts.refspec}` });
    }
    const args = ['push'];
    if (opts.setUpstream === true) args.push('--set-upstream');
    args.push(sanitizeRefArg(opts.remote), sanitizeRefArg(opts.refspec));
    await this.runExclusive(() => this.run(args, { timeoutMs: 120_000 }));
  }

  async fetch(opts: { remote?: string; prune?: boolean } = {}): Promise<void> {
    const args = ['fetch'];
    if (opts.prune === true) args.push('--prune');
    if (opts.remote !== undefined) {
      if (!validateRemoteName(opts.remote)) {
        throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid remote name: ${opts.remote}` });
      }
      args.push(sanitizeRefArg(opts.remote));
    } else {
      args.push('--all');
    }
    await this.runExclusive(() => this.run(args, { timeoutMs: 120_000 }));
  }

  async switchBranch(name: string): Promise<void> {
    this.assertBranch(name);
    await this.runExclusive(() => this.run(['switch', '--', sanitizeRefArg(name)]));
  }

  async checkoutDetached(hash: string): Promise<void> {
    this.assertHash(hash);
    await this.runExclusive(() => this.run(['checkout', '--detach', sanitizeRefArg(hash)]));
  }

  async createBranch(name: string, startPoint: string): Promise<void> {
    this.assertBranch(name);
    if (!validateHash(startPoint) && !validateBranchName(startPoint)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid start point: ${startPoint}` });
    }
    await this.runExclusive(() =>
      this.run(['switch', '--create', sanitizeRefArg(name), sanitizeRefArg(startPoint)]),
    );
  }

  async merge(branch: string, opts: { noFf?: boolean } = {}): Promise<void> {
    this.assertBranch(branch);
    const args = ['merge'];
    if (opts.noFf === true) args.push('--no-ff');
    args.push(sanitizeRefArg(branch));
    await this.runExclusive(() => this.run(args));
  }

  async revert(hash: string): Promise<void> {
    this.assertHash(hash);
    await this.runExclusive(() => this.run(['revert', '--no-edit', sanitizeRefArg(hash)]));
  }

  async resetSoft(hash: string): Promise<void> {
    this.assertHash(hash);
    await this.runExclusive(() => this.run(['reset', '--soft', sanitizeRefArg(hash)]));
  }

  async resetHard(hash: string): Promise<void> {
    this.assertHash(hash);
    await this.runExclusive(() => this.run(['reset', '--hard', sanitizeRefArg(hash)]));
  }

  async stashPush(message: string, opts: { includeUntracked?: boolean } = {}): Promise<void> {
    if (!validateStashMessage(message)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: 'Invalid stash message.' });
    }
    const args = ['stash', 'push'];
    if (opts.includeUntracked === true) args.push('--include-untracked');
    if (message.length > 0) args.push('--message', message);
    await this.runExclusive(() => this.run(args));
  }

  async stashPop(): Promise<void> {
    await this.runExclusive(() => this.run(['stash', 'pop']));
  }

  async mergeContinue(): Promise<void> {
    await this.runExclusive(() => this.run(['merge', '--continue'], { input: '' }));
  }

  async mergeAbort(): Promise<void> {
    await this.runExclusive(() => this.run(['merge', '--abort']));
  }

  // ------------------------------------------------------------- guards

  private assertBranch(name: string): void {
    if (!validateBranchName(name)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid branch name: ${name}` });
    }
  }

  private assertHash(hash: string): void {
    if (!validateHash(hash)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid commit hash: ${hash}` });
    }
  }

  private assertPaths(paths: string[]): string[] {
    if (paths.length === 0) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: 'No paths supplied.' });
    }
    for (const p of paths) {
      if (!validateRepoRelativePath(p)) {
        throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid repository path: ${p}` });
      }
    }
    return paths;
  }
}

/** `fs.access` wrapper: existence check without throwing. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}
