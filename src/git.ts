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
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  LOG_FORMAT,
  REFS_FORMAT,
  parseLog,
  parseRefs,
  parseRemoteList,
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
  | 'GIT_OUTPUT_TOO_LARGE'
  | 'REPOSITORY_LOCKED'
  | 'VALIDATION_ERROR';

export type OperationState = 'idle' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  /**
   * `true` when stdout was cut off at `maxStdoutBytes` because the caller opted
   * into truncation. Never `true` unless `truncateStdout` was requested.
   */
  truncated?: boolean;
}

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  allowedExitCodes?: number[];
  /** Called with each complete stderr line. Git reports progress on stderr. */
  onStderrLine?: (line: string) => void;
  /**
   * Stop accumulating stdout past this many bytes. Defaults to
   * {@link DEFAULT_MAX_STDOUT_BYTES}.
   */
  maxStdoutBytes?: number;
  /**
   * What to do at the cap. `false` (the default) kills git and rejects with
   * `GIT_OUTPUT_TOO_LARGE`, because a caller that asked for a file's content
   * cannot use half of it — a truncated blob would be shown to the user as if it
   * were the file. `true` resolves with what arrived plus `truncated: true`, which
   * is only safe where the output is a record-per-line summary the caller already
   * treats as possibly-partial, e.g. `--numstat`.
   */
  truncateStdout?: boolean;
}

/**
 * Cached absolute path to git resolved from PATH so lookup occurs once.
 * Map keyed by PATH string so tests manipulating PATH get correct resolution.
 */
const resolvedGitPathCache = new Map<string, string | null>();

/**
 * Resolve the git executable to an absolute path.
 *
 * Requirements:
 * - If candidate is non-empty, it MUST be an absolute path; relative paths are rejected.
 * - If candidate is empty, search system PATH for git executable.
 * - On Windows: respect PATHEXT and NEVER include relative paths or '.' / CWD.
 * - On POSIX: resolve via PATH and reject relative candidates.
 */
export function resolveGitExecutable(candidate?: string, env: { PATH?: string; PATHEXT?: string } = process.env): string | null {
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    const trimmed = candidate.trim();
    if (trimmed !== 'git') {
      if (!path.isAbsolute(trimmed)) {
        return null;
      }
      try {
        if (fsSync.existsSync(trimmed) && fsSync.statSync(trimmed).isFile()) {
          return trimmed;
        }
      } catch {
        // Not accessible or not a file.
      }
      return null;
    }
  }

  const isWindows = process.platform === 'win32';
  const pathEnv = env.PATH ?? '';
  const cacheKey = `${isWindows ? 'win32' : 'posix'}|${pathEnv}|${env.PATHEXT ?? ''}`;
  if (resolvedGitPathCache.has(cacheKey)) {
    return resolvedGitPathCache.get(cacheKey)!;
  }

  const rawEntries = pathEnv.split(isWindows ? ';' : ':');
  const extensions = isWindows
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)
    : [''];

  for (const raw of rawEntries) {
    const entry = raw.trim();
    if (!entry || !path.isAbsolute(entry)) continue;

    if (isWindows) {
      for (const ext of extensions) {
        const full = path.join(entry, `git${ext}`);
        try {
          if (fsSync.existsSync(full) && fsSync.statSync(full).isFile()) {
            resolvedGitPathCache.set(cacheKey, full);
            return full;
          }
        } catch {}
      }
    } else {
      const full = path.join(entry, 'git');
      try {
        if (fsSync.existsSync(full) && fsSync.statSync(full).isFile()) {
          resolvedGitPathCache.set(cacheKey, full);
          return full;
        }
      } catch {}
    }
  }

  resolvedGitPathCache.set(cacheKey, null);
  return null;
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
/**
 * Cap on accumulated stdout per invocation, 64 MiB.
 *
 * Without a cap a single `git show <rev>:<path>` on a multi-gigabyte blob builds
 * a JS string of that size in the extension host, and V8's ~512 MB string limit
 * turns it into a hard crash that takes every other extension down with it. 64
 * MiB is far above any output this extension reads on purpose — the largest is a
 * `--numstat` for a huge commit — and far below the host's breaking point.
 */
export const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
/**
 * Cap on accumulated stderr, 1 MiB. Smaller because stderr carries messages and
 * progress lines, never content: a megabyte of them is already pathological.
 * Stderr is always truncated rather than fatal — losing the tail of a progress
 * log must not fail an otherwise successful push.
 */
export const MAX_STDERR_BYTES = 1024 * 1024;
/**
 * Cap on a single blob read through {@link GitRunner.showFile} /
 * {@link GitRunner.showIndexFile}, 5 MiB.
 *
 * Matches the diff viewer's own display ceiling, and is enforced at the stream
 * rather than after the whole blob is already a string in the host. Truncation is
 * NOT allowed on this path: half a file rendered as if it were the file is worse
 * than an error.
 */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
/**
 * Cap on one `--numstat` read, 16 MiB — roughly 200 000 file records. Past it the
 * list is truncated rather than fatal; see {@link GitRunner.numstat}.
 */
export const MAX_NUMSTAT_BYTES = 16 * 1024 * 1024;

export class GitRunner {
  private readonly gitPath: string;
  private readonly cwd: string;
  private readonly logger: (line: string) => void;
  /** Promise chain acting as a mutex so only one mutation runs at a time. */
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private gitDirCache: string | undefined;
  /** Number of queued-or-running exclusive operations. */
  private pending = 0;
  private readonly busyListeners = new Set<(busy: boolean) => void>();

  constructor(options: GitRunnerOptions) {
    const candidate = options.gitPath.trim();
    if (candidate.length > 0) {
      this.gitPath = resolveGitExecutable(candidate) ?? candidate;
    } else {
      this.gitPath = resolveGitExecutable() ?? 'git';
    }
    this.cwd = options.cwd;
    this.logger = options.logger ?? ((): void => undefined);
  }

  /** Spawn git. Reads may run concurrently; use {@link runExclusive} to mutate. */
  async run(args: string[], opts: RunOptions = {}): Promise<GitResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const allowed = opts.allowedExitCodes ?? [0];
    const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const truncateStdout = opts.truncateStdout === true;
    this.logger(`git ${args.join(' ')}`);

    if (!path.isAbsolute(this.gitPath)) {
      throw new GitError({
        code: 'GIT_SPAWN_FAILED',
        message: `Git executable path must be absolute to prevent CWD hijacking: ${this.gitPath}`,
        args,
      });
    }

    return new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.gitPath, args, {
        cwd: this.cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
          NoDefaultCurrentDirectoryInExePath: '1',
        },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      /** Set once stdout hit the cap; further chunks are dropped. */
      let overflowed = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // On Windows `kill` terminates the process; git children are short-lived.
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (overflowed) return;
        const bytes = Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes + bytes > maxStdout) {
          overflowed = true;
          if (truncateStdout) {
            // Keep the prefix that fits. Sliced on a byte boundary, so the final
            // character may be cut in half — harmless for the only truncatable
            // caller, `--numstat`, whose parser discards an incomplete last line.
            const room = maxStdout - stdoutBytes;
            if (room > 0) {
              stdout += Buffer.from(chunk, 'utf8').subarray(0, room).toString('utf8');
            }
          }
          // Kill rather than keep buffering: continuing to accumulate is exactly
          // the DoS, and the remainder cannot help either caller.
          child.kill('SIGKILL');
          return;
        }
        stdoutBytes += bytes;
        stdout += chunk;
      });
      // Git writes progress to stderr; forward complete lines as they arrive.
      let stderrPending = '';
      child.stderr.on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk, 'utf8');
        // Keep the head: the first lines carry the reason, the tail is progress.
        if (stderrBytes <= MAX_STDERR_BYTES) stderr += chunk;
        if (opts.onStderrLine === undefined) return;
        stderrPending += chunk;
        const lines = stderrPending.split(/\r?\n|\r/);
        stderrPending = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) opts.onStderrLine(line.trim());
        }
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
        // Overflow is checked before the timeout and the exit code: the SIGKILL
        // that produced them is our own, so its exit status says nothing.
        if (overflowed && !truncateStdout) {
          reject(
            new GitError({
              code: 'GIT_OUTPUT_TOO_LARGE',
              message: `git produced more than ${maxStdout} bytes on stdout`,
              stderr,
              args,
            }),
          );
          return;
        }
        if (overflowed) {
          resolve({ stdout, stderr, code: 0, truncated: true });
          return;
        }
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
   *
   * `precheck` runs after the lock is held and after the `index.lock` assertion,
   * immediately before `fn`. That is the only place a check and its mutation share
   * the lock, so it is where a guard decision has to be re-made if it must hold at
   * the moment git runs rather than at the moment the request arrived. Throwing
   * from `precheck` aborts the operation without running `fn`.
   *
   * `precheck` must not itself call `runExclusive`: the lock is a promise chain, so
   * a nested acquisition waits on the operation that holds it and deadlocks. Reads
   * are safe — they never take the lock.
   */
  async runExclusive<T>(fn: () => Promise<T>, opts: { precheck?: () => Promise<void> } = {}): Promise<T> {
    this.enter();
    const guarded = async (): Promise<T> => {
      await this.assertNotLocked();
      if (opts.precheck !== undefined) await opts.precheck();
      return fn();
    };
    const run = this.mutationQueue.then(guarded, guarded);
    // Keep the chain alive even when a mutation rejects.
    this.mutationQueue = run.catch(() => undefined);
    return run.finally(() => this.leave());
  }

  /**
   * Observe whether any exclusive operation is queued or running. The watcher
   * uses this to suppress file-system events caused by our own mutations.
   * @returns unsubscribe function
   */
  onBusyChange(listener: (busy: boolean) => void): () => void {
    this.busyListeners.add(listener);
    return () => {
      this.busyListeners.delete(listener);
    };
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  private enter(): void {
    this.pending += 1;
    if (this.pending === 1) this.emitBusy(true);
  }

  private leave(): void {
    this.pending -= 1;
    if (this.pending === 0) this.emitBusy(false);
  }

  private emitBusy(busy: boolean): void {
    for (const listener of this.busyListeners) {
      try {
        listener(busy);
      } catch {
        // A misbehaving listener must not break the mutation queue.
      }
    }
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

  /** Absolute working-tree root. Differs from `cwd` when opened on a subfolder. */
  async repoRoot(): Promise<string> {
    const { stdout } = await this.run(['rev-parse', '--show-toplevel']);
    return stdout.trim();
  }

  /** Full metadata for one commit, or `null` when the object is unknown. */
  async commitMeta(hash: string): Promise<ParsedCommit | null> {
    this.assertHash(hash);
    const { stdout, code } = await this.run(
      ['log', LOG_FORMAT, '--max-count=1', sanitizeRefArg(hash)],
      { allowedExitCodes: [0, 128] },
    );
    if (code !== 0) return null;
    return parseLog(stdout)[0] ?? null;
  }

  /**
   * True when `ancestor` is reachable from `descendant` (i.e. fast-forwardable).
   *
   * Both sides accept a hash or a ref name. The ancestor side has to: asking
   * "would pushing X to origin/Y be a fast-forward?" means asking whether the
   * *remote-tracking ref* is reachable from X, and that ref is a name, not a hash
   * the caller already has. `validateBranchName` still rejects anything git would
   * read as an option, and `sanitizeRefArg` is applied to both.
   */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    // `allowQualified`: the ancestor side is `refs/remotes/<remote>/<branch>`,
    // which `validateBranchName` otherwise rejects so a pseudo-ref cannot be
    // smuggled in where a branch is expected.
    if (!validateHash(ancestor) && !validateBranchName(ancestor, { allowQualified: true })) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid ref: ${ancestor}` });
    }
    if (!validateHash(descendant) && !validateBranchName(descendant)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid ref: ${descendant}` });
    }
    const { code } = await this.run(
      ['merge-base', '--is-ancestor', sanitizeRefArg(ancestor), sanitizeRefArg(descendant)],
      { allowedExitCodes: [0, 1] },
    );
    return code === 0;
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

  /** Every remote with both its fetch and push URL. */
  async remoteList(): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> {
    const { stdout } = await this.run(['remote', '-v']);
    return parseRemoteList(stdout);
  }

  /**
   * Content of one path at one revision, i.e. `git show <rev>:<path>`.
   *
   * The diff viewer needs historical blobs without writing anything to disk, and
   * the host must never shell out itself, so this is the only supported route.
   * `rev` accepts a hash, a branch name, or the empty-string-free special values
   * git understands for the index (`:0`), which is why it is validated against
   * both the hash and the branch rules.
   *
   * Binary content is returned verbatim; the caller decides what to do with NUL
   * bytes because "binary" is a presentation concern, not a git one.
   *
   * Capped at {@link MAX_BLOB_BYTES} with truncation refused: a blob past the
   * ceiling rejects with `GIT_OUTPUT_TOO_LARGE`, which the bridge maps to a 413
   * the UI already renders. Returning a prefix would misrepresent the file.
   */
  async showFile(rev: string, filePath: string): Promise<string> {
    if (!validateHash(rev) && !validateBranchName(rev)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid revision: ${rev}` });
    }
    if (!validateRepoRelativePath(filePath)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid repository path: ${filePath}` });
    }
    // Forward slashes only: `git show` uses git's own path syntax, not the OS's.
    const spec = `${rev}:${filePath.replace(/\\/g, '/')}`;
    const { stdout } = await this.run(['show', '--no-color', sanitizeRefArg(spec)], {
      maxStdoutBytes: MAX_BLOB_BYTES,
    });
    return stdout;
  }

  /** Content of one path in the index (stage 0), i.e. `git show :path`. */
  async showIndexFile(filePath: string): Promise<string> {
    if (!validateRepoRelativePath(filePath)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid repository path: ${filePath}` });
    }
    const spec = `:${filePath.replace(/\\/g, '/')}`;
    // `--` is not accepted after an object spec, and `spec` starts with `:` so
    // it can never be read as an option.
    const { stdout } = await this.run(['show', '--no-color', spec], {
      maxStdoutBytes: MAX_BLOB_BYTES,
    });
    return stdout;
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

  /**
   * Per-file add/delete counts for one commit.
   *
   * Truncation IS allowed here, unlike {@link showFile}: the output is one
   * self-contained record per line, `parseShowStat` drops any partial trailing
   * line, and a caller that learns the list was cut off can say so. A commit
   * touching 500 000 files produces tens of megabytes of `--numstat`, and failing
   * the whole inspector for it would be worse than showing the first pages.
   * `onTruncated` fires when the cap was hit, so the caller can mark the result.
   */
  async numstat(
    hash: string,
    opts: { firstParent?: boolean; onTruncated?: () => void } = {},
  ): Promise<ParsedNumstatEntry[]> {
    this.assertHash(hash);
    const args = ['show', '--numstat', '--format=', '--no-color'];
    // A merge commit has no diff against "the" parent; compare with the first.
    if (opts.firstParent === true) args.push('-m', '--first-parent');
    args.push(sanitizeRefArg(hash));
    const { stdout, truncated } = await this.run(args, {
      maxStdoutBytes: MAX_NUMSTAT_BYTES,
      truncateStdout: true,
    });
    if (truncated === true && opts.onTruncated !== undefined) opts.onTruncated();
    return parseShowStat(stdout);
  }

  /**
   * Per-file add/delete counts for the working tree or the index.
   *
   * `cached: true` reads the index against HEAD (`--cached`), otherwise the working
   * tree against the index. Untracked files appear in neither, which is why the
   * status panel leaves their counts unknown rather than showing zero.
   *
   * Truncation follows {@link numstat}: one self-contained record per line, so a
   * capped read loses trailing files instead of failing the whole status.
   *
   * Unlike {@link numstat} this reports truncation in the RETURN VALUE rather than
   * through a callback. The status panel renders a missing count as "not counted",
   * which is indistinguishable from "not changed" unless the caller says the list
   * was cut short - and a callback is easy to pass and then never wire up, which is
   * exactly how the truncation fact went missing before. A field cannot be
   * destructured without being seen.
   */
  async diffNumstat(
    opts: { cached?: boolean } = {},
  ): Promise<{ entries: ParsedNumstatEntry[]; truncated: boolean }> {
    const args = ['diff', '--numstat', '--no-color'];
    if (opts.cached === true) args.push('--cached');
    const { stdout, truncated } = await this.run(args, {
      maxStdoutBytes: MAX_NUMSTAT_BYTES,
      truncateStdout: true,
    });
    return { entries: parseShowStat(stdout), truncated: truncated === true };
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
    const safe = this.pathspecs(paths);
    await this.runExclusive(() => this.run(['add', '--', ...safe]));
  }

  /**
   * Remove paths from the index.
   *
   * `git restore --staged` rebuilds the index entry FROM HEAD, so a repository
   * without commits fails it with `fatal: could not resolve HEAD` (exit 128).
   * There `git rm --cached` is the correct equivalent, not a fallback hack:
   * "unstage" in a repo with no HEAD can only mean "drop the index entry".
   * `--cached` never touches the working tree, and `--force` waives only the
   * "staged content differs from the file and HEAD" refusal — that staged content
   * is exactly what the user asked to remove from the index, and the file on disk
   * keeps it.
   */
  async unstage(paths: string[]): Promise<void> {
    const safe = this.pathspecs(paths);
    const hasHead = (await this.headHash()) !== null;
    const args = hasHead
      ? ['restore', '--staged', '--', ...safe]
      : ['rm', '--cached', '--force', '--quiet', '--', ...safe];
    await this.runExclusive(() => this.run(args));
  }

  /**
   * Message goes over stdin via `-F -`, never as an argv string.
   * @returns the new HEAD hash, or `null` if HEAD could not be read back.
   */
  async commit(message: string, opts: { amend?: boolean } = {}): Promise<string | null> {
    const check = validateCommitMessage(message);
    if (!check.ok) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: check.message ?? 'Invalid commit message.' });
    }
    const args = ['commit', '-F', '-'];
    if (opts.amend === true) args.push('--amend');
    await this.runExclusive(() => this.run(args, { input: check.message }));
    return this.headHash();
  }

  /**
   * Push without force. A refspec starting with `+` requests a force update and
   * is rejected here, so this method can never rewrite published history.
   */
  async push(opts: {
    remote: string;
    refspec: string;
    setUpstream?: boolean;
    onProgress?: (line: string) => void;
  }): Promise<void> {
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
    await this.runExclusive(() =>
      this.run(args, {
        timeoutMs: 120_000,
        ...(opts.onProgress === undefined ? {} : { onStderrLine: opts.onProgress }),
      }),
    );
  }

  async fetch(
    opts: { remote?: string; prune?: boolean; onProgress?: (line: string) => void } = {},
  ): Promise<void> {
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
    await this.runExclusive(() =>
      this.run(args, {
        timeoutMs: 120_000,
        ...(opts.onProgress === undefined ? {} : { onStderrLine: opts.onProgress }),
      }),
    );
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

  /**
   * Switch to `target` branch and merge `source` (branch or commit hash) into it.
   * Both commands execute in a single exclusive lock so no other git process intervenes.
   */
  async mergeInto(target: string, source: string): Promise<void> {
    this.assertBranch(target);
    if (!validateHash(source) && !validateBranchName(source)) {
      throw new GitError({ code: 'VALIDATION_ERROR', message: `Invalid source: ${source}` });
    }
    await this.runExclusive(async () => {
      await this.run(['switch', '--', sanitizeRefArg(target)]);
      await this.run(['merge', sanitizeRefArg(source)]);
    });
  }

  async revert(hash: string): Promise<void> {
    this.assertHash(hash);
    await this.runExclusive(() => this.run(['revert', '--no-edit', sanitizeRefArg(hash)]));
  }

  async resetSoft(hash: string): Promise<void> {
    this.assertHash(hash);
    await this.runExclusive(() => this.run(['reset', '--soft', sanitizeRefArg(hash)]));
  }

  /**
   * `git reset --hard`. Discards work permanently, so the caller may pass
   * `precheck` to re-verify its preconditions inside the exclusive lock: for every
   * other action a check made just before the lock is close enough, but here the
   * thing being discarded is the user's uncommitted work.
   */
  async resetHard(hash: string, opts: { precheck?: () => Promise<void> } = {}): Promise<void> {
    this.assertHash(hash);
    await this.runExclusive(
      () => this.run(['reset', '--hard', sanitizeRefArg(hash)]),
      opts.precheck === undefined ? {} : { precheck: opts.precheck },
    );
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
    await this.runExclusive(() => this.run(['-c', 'core.editor=true', 'merge', '--continue'], { input: '' }));
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

  /**
   * Validate paths and turn them into pathspecs anchored at the REPOSITORY ROOT.
   *
   * `cwd` is the workspace folder, which is not necessarily the repository root —
   * VS Code is routinely opened on a subdirectory. `git status` reports paths
   * relative to the root, so feeding those strings back as plain pathspecs from a
   * subdirectory resolves them against `cwd` and every stage/unstage fails with
   * `pathspec '<file>' did not match any file(s) known to git`.
   *
   * `:(top)` re-anchors the pathspec at the root, which is exactly what the
   * incoming strings already are. It is preferred over changing `cwd` to the root:
   * `cwd` is also what `git status`, `git diff --numstat`, the watcher, and the
   * diff provider run against, and moving it would silently change the base of all
   * of them. `literal` is added at the same time because these are exact file names
   * out of `git status`, not user-typed globs, so a tracked file named `weird[1].c`
   * must not be read as a character class.
   *
   * Both magics need git 1.9+ (2013); the extension already requires far newer.
   */
  private pathspecs(paths: string[]): string[] {
    // Forward slashes only: pathspecs use git's own syntax, not the platform's.
    return this.assertPaths(paths).map((p) => `:(top,literal)${p.replace(/\\/g, '/')}`);
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
