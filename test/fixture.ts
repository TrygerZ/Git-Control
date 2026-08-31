/**
 * Reusable real-git repository builder for the end-to-end suites.
 *
 * NOT a test file: the name deliberately lacks the `.test.ts` suffix, which is
 * both what `esbuild.js` globs for entry points and what `node --test
 * "out/test/*.test.js"` runs. It is compiled anyway because the suites that
 * import it are bundled (`bundle: true`), so this module ends up inlined in their
 * output. It contains no top-level `test()` for the same reason.
 *
 * Everything here drives the real `git` binary against a real throwaway
 * repository. Nothing is mocked: these fixtures exist to support integration
 * tests, and a mocked git would remove the only thing they verify.
 *
 * Determinism: identity and both timestamps are pinned, so a given sequence of
 * builder calls produces the same object ids on every machine. `core.autocrlf` is
 * pinned too (`false` by default), because on Windows an inherited global
 * `autocrlf=true` would silently rewrite blob content and change those ids.
 */
import * as fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitRunner } from '../src/git';
import { MessageBridge, type BridgeHost, type WebviewLike } from '../src/bridge';
import { Logger, type LogSink } from '../src/logger';
import { RepositoryService, type PersistentStore } from '../src/repository';
import type {
  HostEvent,
  HostMessage,
  Request,
  Response,
  SettingsSnapshot,
} from '../src/messages';

/** Fixed epoch seconds for the first commit; each later commit advances a minute. */
const BASE_EPOCH_SECONDS = 1_700_000_000;

export interface MakeRepoOptions {
  /** Commits in the initial linear chain. Default 1. */
  commits?: number;
  /** Initial branch. Default `main`. */
  branch?: string;
  /** `core.autocrlf`. Default `false` so blob bytes — and hashes — are stable. */
  autocrlf?: 'true' | 'false' | 'input';
  /**
   * Create a bare repository, wire it as `origin`, and push `branch` with an
   * upstream so `@{upstream}` and `refs/remotes/origin/<branch>` both resolve.
   */
  remote?: boolean;
  /** Label used in the temp directory name, for readable failures. */
  label?: string;
}

/** Working-tree shapes {@link TestRepo.fileStates} can produce. */
export type FileState =
  | 'modified'
  | 'staged'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'binary'
  | 'unicode'
  /** Skipped on Windows, where a newline cannot appear in a filename. */
  | 'newline';

/** Every git invocation the product constructed, for process-count assertions. */
export interface GitLog {
  /** Argv lines with the leading `git ` stripped, in call order. */
  readonly lines: readonly string[];
  /** Invocations whose first argument is `subcommand`. */
  count(subcommand: string): number;
  /** Lines whose first argument is `subcommand`. */
  of(subcommand: string): string[];
  clear(): void;
}

/** Bridge plus its stubbed webview, wired over one repository. */
export interface Harness {
  bridge: MessageBridge;
  repo: RepositoryService;
  /** Argv of everything the bridge's `GitRunner` ran. */
  log: GitLog;
  /** Every message the host posted, responses and events alike. */
  posted: readonly HostMessage[];
  events(): HostEvent[];
  /** Build an envelope without sending it, for deliberately concurrent sends. */
  request(kind: string, payload: object): Request;
  /** Deliver an envelope and resolve with its response. */
  deliver(request: Request, attempts?: number): Promise<Response>;
  send(kind: string, payload: object): Promise<Response>;
  dispose(): void;
}

export interface HarnessOptions {
  settings?: Partial<SettingsSnapshot>;
  host?: Partial<BridgeHost>;
}

const DEFAULT_SETTINGS: SettingsSnapshot = {
  gitPath: 'git',
  commitLimit: 10_000,
  pageSize: 500,
  showIgnoredFiles: false,
  githubApiUrl: 'https://api.github.com',
  fetchStalenessMs: 300_000,
  ui: { zoom: 1, branchFilter: '' },
};

/** Directories to remove if a test forgets; best effort, on process exit. */
const created: string[] = [];
let exitHookInstalled = false;

// --------------------------------------------------------------------- builder

/** A real repository in a temp directory, plus the builders the suites need. */
export class TestRepo {
  readonly dir: string;
  /** Runner used for setup and for out-of-band reads. Not counted by {@link Harness.log}. */
  readonly git: GitRunner;
  readonly branch: string;

  private readonly autocrlf: 'true' | 'false' | 'input';
  private readonly extraDirs: string[] = [];
  private readonly clones: TestRepo[] = [];
  private bareDir: string | null;
  private tick = 0;

  private constructor(params: {
    dir: string;
    branch: string;
    autocrlf: 'true' | 'false' | 'input';
    remoteDir: string | null;
  }) {
    this.dir = params.dir;
    this.branch = params.branch;
    this.autocrlf = params.autocrlf;
    this.bareDir = params.remoteDir;
    this.git = new GitRunner({ gitPath: 'git', cwd: params.dir });
  }

  /** Bare `origin` directory, or `null` when the repository has no remote. */
  get remoteDir(): string | null {
    return this.bareDir;
  }

  // ------------------------------------------------------------- construction

  static async create(options: MakeRepoOptions = {}): Promise<TestRepo> {
    installExitHook();
    const branch = options.branch ?? 'main';
    const autocrlf = options.autocrlf ?? 'false';
    const dir = await tempDir(options.label ?? 'repo');
    const repo = new TestRepo({ dir, branch, autocrlf, remoteDir: null });
    await repo.git.run(['init', '--quiet', `--initial-branch=${branch}`]);
    await writeIdentity(dir, autocrlf);
    await repo.chain(options.commits ?? 1);
    if (options.remote === true) await repo.addBareRemote();
    return repo;
  }

  /**
   * Bare repository wired as `origin`, with `branch` pushed and tracking.
   *
   * Mutates this repo, so it is also usable on a fixture created without
   * `remote: true`. Returns the bare directory.
   */
  async addBareRemote(): Promise<string> {
    const bare = await tempDir('bare');
    this.extraDirs.push(bare);
    const bareGit = new GitRunner({ gitPath: 'git', cwd: bare });
    await bareGit.run(['init', '--bare', '--quiet', `--initial-branch=${this.branch}`]);
    // Forward slashes: a Windows path with backslashes is a valid remote URL to
    // git, but the slash form is what every platform agrees on.
    await this.git.run(['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
    await this.git.push({ remote: 'origin', refspec: `${this.branch}:${this.branch}`, setUpstream: true });
    this.bareDir = bare;
    return bare;
  }

  /**
   * A second working copy of the same bare remote — "another writer".
   *
   * Its commits and pushes are genuinely separate git invocations against the
   * same remote, which is what the concurrency cases need. Cleaned up with this
   * repository.
   */
  async cloneFromRemote(label = 'clone'): Promise<TestRepo> {
    const remote = this.requireRemote();
    const dir = await tempDir(label);
    const parent = new GitRunner({ gitPath: 'git', cwd: path.dirname(dir) });
    await parent.run(['clone', '--quiet', remote.replace(/\\/g, '/'), dir]);
    await writeIdentity(dir, this.autocrlf);
    const clone = new TestRepo({
      dir,
      branch: this.branch,
      autocrlf: this.autocrlf,
      remoteDir: remote,
    });
    this.clones.push(clone);
    return clone;
  }

  // ---------------------------------------------------------------- topology

  /**
   * Append `count` commits, each adding one file. Returns the new hashes in
   * order.
   */
  async chain(count: number, prefix = 'c'): Promise<string[]> {
    const hashes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const name = `${prefix}${this.tick + 1}.txt`;
      await fs.writeFile(path.join(this.dir, name), `${name}\n`, 'utf8');
      await this.git.stage([name]);
      hashes.push(await this.commit(`add ${name}`));
    }
    return hashes;
  }

  /**
   * Branch `name` off `from` with one commit of its own, then return to the
   * starting branch. Returns the branch tip.
   */
  async fork(name: string, from = this.branch): Promise<string> {
    await this.git.createBranch(name, from);
    const file = `${name}.txt`;
    await fs.writeFile(path.join(this.dir, file), `${name}\n`, 'utf8');
    await this.git.stage([file]);
    const hash = await this.commit(`add ${file}`);
    await this.git.switchBranch(this.branch);
    return hash;
  }

  /** Merge `branch` into the current branch with a real merge commit. */
  async mergeCommit(branch: string): Promise<string> {
    const stamp = this.nextStamp();
    await withEnv({ GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }, () =>
      this.git.merge(branch, { noFf: true }),
    );
    return (await this.git.headHash()) as string;
  }

  /**
   * Two branches that changed the same line, left mid-conflict.
   *
   * Returns the conflicted path. The repository is in `merge` state afterwards,
   * which is exactly what the guard's in-progress rules are about.
   */
  async conflict(other = 'side', file = 'conflict.txt'): Promise<string> {
    const target = path.join(this.dir, file);
    await fs.writeFile(target, 'base\n', 'utf8');
    await this.git.stage([file]);
    await this.commit(`add ${file}`);

    await this.git.createBranch(other, this.branch);
    await fs.writeFile(target, 'theirs\n', 'utf8');
    await this.git.stage([file]);
    await this.commit(`${other} edit`);

    await this.git.switchBranch(this.branch);
    await fs.writeFile(target, 'ours\n', 'utf8');
    await this.git.stage([file]);
    await this.commit('our edit');

    // Expected to fail: that failure IS the conflict.
    await this.git.merge(other).catch(() => undefined);
    return file;
  }

  /** Detach HEAD at `hash`, defaulting to the current HEAD. */
  async detach(hash?: string): Promise<string> {
    const target = hash ?? ((await this.git.headHash()) as string);
    await this.git.checkoutDetached(target);
    return target;
  }

  // ------------------------------------------------------------- file states

  /**
   * Produce the requested working-tree states and return the path of each.
   *
   * Adds ONE commit carrying the tracked seed files the destructive states need
   * (`modified`, `deleted`, `renamed` all require a file that already exists in
   * HEAD). `newline` is omitted from the result on Windows, where the filesystem
   * cannot represent it.
   */
  async fileStates(...kinds: FileState[]): Promise<Partial<Record<FileState, string>>> {
    const wanted = new Set(kinds);
    const out: Partial<Record<FileState, string>> = {};

    const seeds: Array<[FileState, string]> = [
      ['modified', 'seed-modified.txt'],
      ['staged', 'seed-staged.txt'],
      ['deleted', 'seed-deleted.txt'],
      ['renamed', 'seed-renamed.txt'],
    ];
    const needed = seeds.filter(([kind]) => wanted.has(kind));
    if (needed.length > 0) {
      for (const [, name] of needed) {
        await fs.writeFile(path.join(this.dir, name), 'seed\n', 'utf8');
      }
      await this.git.stage(needed.map(([, name]) => name));
      await this.commit('add seed files');
    }

    if (wanted.has('modified')) {
      const name = 'seed-modified.txt';
      await fs.writeFile(path.join(this.dir, name), 'changed\n', 'utf8');
      out.modified = name;
    }
    if (wanted.has('staged')) {
      const name = 'seed-staged.txt';
      await fs.writeFile(path.join(this.dir, name), 'staged\n', 'utf8');
      await this.git.stage([name]);
      out.staged = name;
    }
    if (wanted.has('deleted')) {
      const name = 'seed-deleted.txt';
      await fs.rm(path.join(this.dir, name));
      out.deleted = name;
    }
    if (wanted.has('renamed')) {
      await this.git.run(['mv', '--', 'seed-renamed.txt', 'renamed.txt']);
      out.renamed = 'renamed.txt';
    }
    if (wanted.has('untracked')) {
      const name = 'untracked.txt';
      await fs.writeFile(path.join(this.dir, name), 'new\n', 'utf8');
      out.untracked = name;
    }
    if (wanted.has('binary')) {
      const name = 'binary.dat';
      await fs.writeFile(path.join(this.dir, name), Buffer.from([0x00, 0x01, 0x00, 0xff, 0x00]));
      out.binary = name;
    }
    if (wanted.has('unicode')) {
      const name = 'dir with spaces/ünïcode ✓.txt';
      await fs.mkdir(path.join(this.dir, 'dir with spaces'), { recursive: true });
      await fs.writeFile(path.join(this.dir, name), 'unicode\n', 'utf8');
      out.unicode = name;
    }
    if (wanted.has('newline') && process.platform !== 'win32') {
      const name = 'line\nbreak.txt';
      await fs.writeFile(path.join(this.dir, name), 'newline\n', 'utf8');
      out.newline = name;
    }
    return out;
  }

  // -------------------------------------------------------------------- hooks

  /**
   * Install an executable hook. `#!/bin/sh` works under Git for Windows, which
   * ships its own `sh` and runs hooks through it, so one body covers every
   * platform. Callers must confirm the hook actually fires rather than assume it.
   */
  async installHook(name: string, script: string): Promise<string> {
    const dir = path.join(await this.git.gitDir(), 'hooks');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    const body = script.startsWith('#!') ? script : `#!/bin/sh\n${script}`;
    await fs.writeFile(target, body.endsWith('\n') ? body : `${body}\n`, { encoding: 'utf8', mode: 0o755 });
    await fs.chmod(target, 0o755);
    return target;
  }

  // ------------------------------------------------------------------- remote

  /** Object id a ref points at inside the bare remote. */
  async remoteHash(ref = `refs/heads/${this.branch}`): Promise<string> {
    const bare = new GitRunner({ gitPath: 'git', cwd: this.requireRemote() });
    const { stdout } = await bare.run(['rev-parse', ref]);
    return stdout.trim();
  }

  // ------------------------------------------------------------------ harness

  /**
   * A {@link MessageBridge} over this repository with a recording webview.
   *
   * The `RepositoryService` is given a logger, which `GitRunner` calls once per
   * spawn with the full argv — that is the process counter, and it needs no new
   * public API on the product side.
   */
  harness(options: HarnessOptions = {}): Harness {
    const log = new RecordingLog();
    const settings: SettingsSnapshot = { ...DEFAULT_SETTINGS, ...options.settings };
    const repo = new RepositoryService({
      folderPath: this.dir,
      gitPath: 'git',
      store: new MemoryStore(),
      logger: (line) => log.push(line),
      pageSize: settings.pageSize,
      commitLimit: settings.commitLimit,
    });
    const webview = new RecordingWebview();
    const host: BridgeHost = {
      logger: new Logger(new NullSink()),
      resolveRepository: () => Promise.resolve(repo),
      settings: () => settings,
      setUiPreference: () => Promise.resolve(settings),
      githubAuth: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
      connectGitHub: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
      disconnectGitHub: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
      ...options.host,
    };
    const bridge = new MessageBridge(webview, host);
    return {
      bridge,
      repo,
      log,
      posted: webview.sent,
      events: () => webview.events(),
      request: (kind, payload) => webview.envelope(kind, payload),
      deliver: (request, attempts) => webview.deliver(request, attempts),
      send: (kind, payload) => webview.deliver(webview.envelope(kind, payload)),
      dispose: () => bridge.dispose(),
    };
  }

  // ------------------------------------------------------------------ cleanup

  /** Remove this repository, its bare remote, and every clone taken from it. */
  async cleanup(): Promise<void> {
    for (const clone of this.clones) await clone.cleanup();
    for (const dir of [this.dir, ...this.extraDirs]) await removeDir(dir);
  }

  // ------------------------------------------------------------------ private

  /** Commit with pinned author and committer dates. Returns the new hash. */
  private async commit(message: string): Promise<string> {
    const stamp = this.nextStamp();
    const hash = await withEnv({ GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp }, () =>
      this.git.commit(message),
    );
    return hash as string;
  }

  private nextStamp(): string {
    this.tick += 1;
    return `${BASE_EPOCH_SECONDS + this.tick * 60} +0000`;
  }

  private requireRemote(): string {
    if (this.remoteDir === null) {
      throw new Error('fixture has no bare remote: pass { remote: true } or call addBareRemote()');
    }
    return this.remoteDir;
  }
}

/** Preferred entry point. See {@link MakeRepoOptions}. */
export function makeRepo(options: MakeRepoOptions = {}): Promise<TestRepo> {
  return TestRepo.create(options);
}

// ------------------------------------------------------------------- plumbing

class RecordingLog implements GitLog {
  readonly lines: string[] = [];

  push(line: string): void {
    this.lines.push(line.replace(/^git /, ''));
  }

  count(subcommand: string): number {
    return this.of(subcommand).length;
  }

  of(subcommand: string): string[] {
    return this.lines.filter((line) => line === subcommand || line.startsWith(`${subcommand} `));
  }

  clear(): void {
    this.lines.length = 0;
  }
}

/** Records every posted message and lets a test inject requests. */
class RecordingWebview implements WebviewLike {
  readonly sent: HostMessage[] = [];
  private listener: ((message: unknown) => void) | undefined;
  private counter = 0;

  postMessage(message: HostMessage): Thenable<boolean> {
    this.sent.push(message);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void } {
    this.listener = listener;
    return {
      dispose: () => {
        this.listener = undefined;
      },
    };
  }

  envelope(kind: string, payload: object): Request {
    this.counter += 1;
    return { id: `fx${this.counter}`, kind, payload } as unknown as Request;
  }

  /**
   * Deliver a request and resolve with its response. Polls rather than hooking
   * `postMessage`, so a concurrently delivered sibling cannot steal the reply.
   */
  async deliver(request: Request, attempts = 1500): Promise<Response> {
    this.listener?.(request);
    for (let i = 0; i < attempts; i += 1) {
      const found = this.sent.find((m): m is Response => 'id' in m && m.id === request.id);
      if (found !== undefined) return found;
      await delay(10);
    }
    throw new Error(`no response for ${request.kind}`);
  }

  events(): HostEvent[] {
    return this.sent.filter((m): m is HostEvent => 'kind' in m);
  }
}

class MemoryStore implements PersistentStore {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

class NullSink implements LogSink {
  appendLine(): void {
    /* discard */
  }
}

// --------------------------------------------------------------------- helpers

/**
 * Repository identity, written straight into `.git/config`.
 *
 * Four `git config` spawns cost more than one file write, and the format is a
 * plain INI file git itself round-trips. Pinning `autocrlf` matters on Windows: a
 * global `autocrlf=true` would rewrite blob bytes and move every object id.
 */
async function writeIdentity(dir: string, autocrlf: string): Promise<void> {
  await fs.appendFile(
    path.join(dir, '.git', 'config'),
    [
      '[user]',
      '\tname = Fixture User',
      '\temail = fixture@example.com',
      '[core]',
      `\tautocrlf = ${autocrlf}`,
      '[commit]',
      '\tgpgsign = false',
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * Run `fn` with extra environment variables.
 *
 * `GitRunner` builds its child environment from `process.env`, and the git dates
 * can only be set through the environment, so this is the only way to pin them
 * without adding a product API for the tests' benefit. Safe because `node:test`
 * runs the tests within one file sequentially.
 */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    prior.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function tempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `git-control-${label}-`));
  created.push(dir);
  return dir;
}

/**
 * Recursive delete that survives Windows.
 *
 * Two separate problems. Git marks loose object files read-only, and on Windows
 * the read-only attribute makes `unlink` fail with `EPERM` no matter what the
 * caller's privileges are — so the write bit has to be restored first. And git
 * (or an antivirus scanner following it) can still hold a handle for a moment
 * after the process exits, which surfaces as `EBUSY`/`EPERM` on the directory
 * itself; that one only needs a short wait.
 */
export async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'ENOTEMPTY') throw err;
      await clearReadOnly(dir);
      await delay(25 * (attempt + 1));
    }
  }
  // Last attempt, with node's own retry loop. A leftover temp directory is the
  // OS's problem; failing a green test over it would not be.
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
}

async function clearReadOnly(target: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return;
  }
  await fs.chmod(target, 0o700).catch(() => undefined);
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) await clearReadOnly(child);
    else await fs.chmod(child, 0o600).catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Best effort only.
      }
    }
  });
}
