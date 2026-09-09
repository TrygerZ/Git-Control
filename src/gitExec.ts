import { spawn } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type GitErrorCode =
  | 'GIT_FAILED'
  | 'GIT_TIMEOUT'
  | 'GIT_SPAWN_FAILED'
  | 'GIT_OUTPUT_TOO_LARGE'
  | 'REPOSITORY_LOCKED'
  | 'VALIDATION_ERROR';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated?: boolean;
}

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  allowedExitCodes?: number[];
  onStderrLine?: (line: string) => void;
  maxStdoutBytes?: number;
  truncateStdout?: boolean;
}

export interface GitRunnerOptions {
  gitPath: string;
  cwd: string;
  logger?: (line: string) => void;
}

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
export const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
export const MAX_STDERR_BYTES = 1024 * 1024;

const resolvedGitPathCache = new Map<string, string | null>();

export function resolveGitExecutable(candidate?: string, env: { PATH?: string; PATHEXT?: string } = process.env): string | null {
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    const trimmed = candidate.trim();
    if (trimmed !== 'git') {
      if (!path.isAbsolute(trimmed)) return null;
      try {
        if (fsSync.existsSync(trimmed) && fsSync.statSync(trimmed).isFile()) return trimmed;
      } catch {
        // Not accessible or not a file.
      }
      return null;
    }
  }

  const isWindows = process.platform === 'win32';
  const pathEnv = env.PATH ?? '';
  const cacheKey = `${isWindows ? 'win32' : 'posix'}|${pathEnv}|${env.PATHEXT ?? ''}`;
  if (resolvedGitPathCache.has(cacheKey)) return resolvedGitPathCache.get(cacheKey)!;

  const rawEntries = pathEnv.split(isWindows ? ';' : ':');
  const extensions = isWindows
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)
    : [''];
  for (const raw of rawEntries) {
    const entry = raw.trim();
    if (!entry || !path.isAbsolute(entry)) continue;
    for (const ext of extensions) {
      const full = path.join(entry, `git${isWindows ? ext : ''}`);
      try {
        if (fsSync.existsSync(full) && fsSync.statSync(full).isFile()) {
          resolvedGitPathCache.set(cacheKey, full);
          return full;
        }
      } catch {
        // Continue searching PATH.
      }
      if (!isWindows) break;
    }
  }
  resolvedGitPathCache.set(cacheKey, null);
  return null;
}

export class GitExecutionLayer {
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly busyListeners = new Set<(busy: boolean) => void>();
  private readonly gitPath: string;
  private readonly cwd: string;
  private readonly logger: (line: string) => void;

  constructor(options: GitRunnerOptions) {
    const candidate = options.gitPath.trim();
    this.gitPath = candidate.length > 0 ? (resolveGitExecutable(candidate) ?? candidate) : (resolveGitExecutable() ?? 'git');
    this.cwd = options.cwd;
    this.logger = options.logger ?? (() => undefined);
  }

  async run(args: string[], opts: RunOptions = {}): Promise<GitResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const allowed = opts.allowedExitCodes ?? [0];
    const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const truncateStdout = opts.truncateStdout === true;
    this.logger(`git ${args.join(' ')}`);
    if (!path.isAbsolute(this.gitPath)) {
      throw new GitError({ code: 'GIT_SPAWN_FAILED', message: `Git executable path must be absolute to prevent CWD hijacking: ${this.gitPath}`, args });
    }
    return new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.gitPath, args, {
        cwd: this.cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', NoDefaultCurrentDirectoryInExePath: '1' },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let overflowed = false;
      const timer = setTimeout(() => {
        timedOut = true;
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
            const room = maxStdout - stdoutBytes;
            if (room > 0) stdout += Buffer.from(chunk, 'utf8').subarray(0, room).toString('utf8');
          }
          child.kill('SIGKILL');
          return;
        }
        stdoutBytes += bytes;
        stdout += chunk;
      });
      let stderrPending = '';
      child.stderr.on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk, 'utf8');
        if (stderrBytes <= MAX_STDERR_BYTES) stderr += chunk;
        if (opts.onStderrLine === undefined) return;
        stderrPending += chunk;
        const lines = stderrPending.split(/\r?\n|\r/);
        stderrPending = lines.pop() ?? '';
        for (const line of lines) if (line.trim().length > 0) opts.onStderrLine(line.trim());
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new GitError({ code: 'GIT_SPAWN_FAILED', message: `Failed to start git: ${err.message}`, args }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (overflowed && !truncateStdout) {
          reject(new GitError({ code: 'GIT_OUTPUT_TOO_LARGE', message: `git produced more than ${maxStdout} bytes on stdout`, stderr, args }));
          return;
        }
        if (overflowed) {
          resolve({ stdout, stderr, code: 0, truncated: true });
          return;
        }
        if (timedOut) {
          reject(new GitError({ code: 'GIT_TIMEOUT', message: `git timed out after ${timeoutMs}ms`, stderr, args }));
          return;
        }
        const exitCode = code ?? -1;
        if (!allowed.includes(exitCode)) {
          reject(new GitError({ code: 'GIT_FAILED', message: stderr.trim().length > 0 ? stderr.trim() : `git exited with code ${exitCode}`, exitCode, stderr, args }));
          return;
        }
        resolve({ stdout, stderr, code: exitCode });
      });
      if (opts.input !== undefined) child.stdin.end(opts.input, 'utf8');
      else child.stdin.end();
    });
  }

  async runExclusive<T>(fn: () => Promise<T>, assertNotLocked: () => Promise<void>, precheck?: () => Promise<void>): Promise<T> {
    this.pending += 1;
    if (this.pending === 1) this.emitBusy(true);
    const guarded = async (): Promise<T> => {
      await assertNotLocked();
      if (precheck !== undefined) await precheck();
      return fn();
    };
    const run = this.mutationQueue.then(guarded, guarded);
    this.mutationQueue = run.catch(() => undefined);
    return run.finally(() => {
      this.pending -= 1;
      if (this.pending === 0) this.emitBusy(false);
    });
  }

  onBusyChange(listener: (busy: boolean) => void): () => void {
    this.busyListeners.add(listener);
    return () => this.busyListeners.delete(listener);
  }

  get busy(): boolean { return this.pending > 0; }

  private emitBusy(busy: boolean): void {
    for (const listener of this.busyListeners) {
      try { listener(busy); } catch { /* Listener failures must not break the queue. */ }
    }
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try { await fs.stat(target); return true; } catch { return false; }
}
