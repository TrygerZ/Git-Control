import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitError, GitRunner } from '../src/git';
import { GitHubError } from '../src/github';
import { BRIDGE_MESSAGES, MessageBridge, toErrorBody, type BridgeHost, type WebviewLike } from '../src/bridge';
import { Logger, type LogSink } from '../src/logger';
import { RepositoryService, type PersistentStore } from '../src/repository';
import type {
  HostEvent,
  HostMessage,
  OpenDiffPayload,
  RemoteInfo,
  Request,
  Response,
  SettingsSnapshot,
} from '../src/messages';

test('GitError REPOSITORY_LOCKED maps to 409', () => {
  const body = toErrorBody(new GitError({ code: 'REPOSITORY_LOCKED', message: 'locked' }));
  assert.equal(body.status, 409);
  assert.equal(body.code, 'REPOSITORY_LOCKED');
  assert.equal(body.message, BRIDGE_MESSAGES.locked);
});

test('hook rejection maps to 409 HOOK_REJECTED with hook output in detail', () => {
  const stderr = 'pre-commit hook failed\nlint: 3 errors';
  const body = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 1, stderr }),
  );
  assert.equal(body.status, 409);
  assert.equal(body.code, 'HOOK_REJECTED');
  assert.equal(body.message, BRIDGE_MESSAGES.hookRejected);
  assert.equal(body.detail, stderr);
});

test('non-fast-forward push maps to 409 NON_FAST_FORWARD with a fetch remedy only', () => {
  const stderr = '! [rejected] main -> main (non-fast-forward)';
  const body = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 1, stderr }),
  );
  assert.equal(body.status, 409);
  assert.equal(body.code, 'NON_FAST_FORWARD');
  assert.deepEqual(body.remedies, ['fetch']);
});

test('validation failures from git map to 400', () => {
  const body = toErrorBody(new GitError({ code: 'VALIDATION_ERROR', message: 'Invalid branch name: -x' }));
  assert.equal(body.status, 400);
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.equal(body.detail, 'Invalid branch name: -x');
});

test('spawn failure and timeout map to service-unavailable codes', () => {
  const spawn = toErrorBody(new GitError({ code: 'GIT_SPAWN_FAILED', message: 'no git' }));
  assert.equal(spawn.status, 503);
  assert.equal(spawn.code, 'UNAVAILABLE');

  const timeout = toErrorBody(new GitError({ code: 'GIT_TIMEOUT', message: 'timed out' }));
  assert.equal(timeout.status, 504);
  assert.equal(timeout.code, 'UNAVAILABLE');
});

test('an unclassified git failure falls back to 500 SERVER_ERROR', () => {
  const body = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'fatal: bad object', exitCode: 128, stderr: 'fatal: bad object' }),
  );
  assert.equal(body.status, 500);
  assert.equal(body.code, 'SERVER_ERROR');
});

test('a plain Error maps to 500 SERVER_ERROR', () => {
  const body = toErrorBody(new Error('boom'));
  assert.equal(body.status, 500);
  assert.equal(body.code, 'SERVER_ERROR');
  assert.equal(body.message, 'boom');
});

// ----------------------------------------------------------- dispatch tests

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

/** Fake webview: records what the host sent and lets tests inject requests. */
class FakeWebview implements WebviewLike {
  readonly sent: HostMessage[] = [];
  private listener: ((message: unknown) => void) | undefined;

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

  /** Deliver a request and resolve with its response once one is posted. */
  async send(request: Request, attempts = 1500): Promise<Response> {
    const before = this.sent.length;
    this.listener?.(request);
    // Generous budget by default: real git calls on Windows are slow.
    for (let i = 0; i < attempts; i += 1) {
      const found = this.sent
        .slice(before)
        .find((m): m is Response => 'id' in m && m.id === request.id);
      if (found !== undefined) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no response for ${request.kind}`);
  }

  events(): HostEvent[] {
    return this.sent.filter((m): m is HostEvent => 'kind' in m);
  }
}

const SETTINGS: SettingsSnapshot = {
  gitPath: 'git',
  commitLimit: 10_000,
  pageSize: 500,
  showIgnoredFiles: false,
  githubApiUrl: 'https://api.github.com',
  fetchStalenessMs: 300_000,
  ui: { zoom: 1, branchFilter: '' },
};

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-control-bridge-'));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  await git.run(['init', '--quiet', '--initial-branch=main']);
  await git.run(['config', 'user.email', 'test@example.com']);
  await git.run(['config', 'user.name', 'Test User']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n', 'utf8');
  await git.stage(['a.txt']);
  await git.commit('initial commit');
  return dir;
}

function cleanup(dir: string): Promise<void> {
  return fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

interface Harness {
  webview: FakeWebview;
  bridge: MessageBridge;
  repo: RepositoryService | null;
  /** Calls recorded by the optional host callbacks. */
  calls: { showLogs: number; openDiff: OpenDiffPayload[]; external: string[] };
}

function harness(repo: RepositoryService | null, overrides: Partial<BridgeHost> = {}): Harness {
  const webview = new FakeWebview();
  const calls = { showLogs: 0, openDiff: [] as OpenDiffPayload[], external: [] as string[] };
  const host: BridgeHost = {
    logger: new Logger(new NullSink()),
    resolveRepository: () => Promise.resolve(repo),
    settings: () => SETTINGS,
    setUiPreference: () => Promise.resolve(SETTINGS),
    githubAuth: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
    connectGitHub: () => Promise.resolve({ connected: true, login: null, scopes: [] }),
    disconnectGitHub: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
    openDiff: (payload) => {
      calls.openDiff.push(payload);
      return Promise.resolve({ opened: true, mode: 'commit' });
    },
    showLogs: () => {
      calls.showLogs += 1;
    },
    openExternal: (url) => {
      calls.external.push(url);
      return Promise.resolve(true);
    },
    ...overrides,
  };
  return { webview, bridge: new MessageBridge(webview, host), repo, calls };
}

let requestCounter = 0;
function req(kind: string, payload: object): Request {
  requestCounter += 1;
  return { id: `r${requestCounter}`, kind, payload } as unknown as Request;
}

test('missing repository yields 404 with the PRD wording', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('repos/status', {}));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 404);
  assert.equal(response.error.code, 'NOT_FOUND');
  assert.equal(response.error.message, BRIDGE_MESSAGES.noRepository);
});

test('malformed payloads are rejected with 400 before touching git', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  for (const request of [
    req('commits/detail', { hash: 'not-a-hash' }),
    req('repos/graph', { limit: -1 }),
    req('repos/graph', { cursor: 1.5 }),
    req('actions/stage', { paths: [], stage: true, statusToken: '', idempotencyKey: 'k1' }),
    req('actions/stage', { paths: ['../escape'], stage: true, statusToken: '', idempotencyKey: 'k2' }),
    req('actions/git', { action: 'checkout-branch', branch: '-x', idempotencyKey: 'k3' }),
    req('actions/git', { action: 'push', remote: 'origin', branch: '..bad', idempotencyKey: 'k4' }),
  ]) {
    const response = await h.webview.send(request);
    assert.equal(response.ok, false, JSON.stringify(request.payload));
    if (response.ok) return;
    assert.equal(response.error.status, 400);
    assert.equal(response.error.code, 'VALIDATION_ERROR');
  }
});

test('a dirty tree blocks checkout and returns the guard remedies', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'dirty.txt'), 'x\n', 'utf8');
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/git', { action: 'checkout-branch', branch: 'main', idempotencyKey: 'co1' }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'DIRTY_TREE');
  assert.equal(response.error.message, 'Commit atau stash perubahan sebelum checkout.');
  assert.deepEqual(response.error.remedies, ['commit', 'stash', 'cancel']);
});

test('reset-hard needs confirm plus forceAcknowledgement, enforced host-side', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // No flags: blocked, level 2, high risk.
  const bare = await h.webview.send(
    req('actions/git', { action: 'reset-hard', hash: head, idempotencyKey: 'rh1' }),
  );
  assert.equal(bare.ok, false);
  if (bare.ok) return;
  assert.equal(bare.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(bare.error.confirmationLevel, 2);
  assert.equal(bare.error.risk, 'high');
  assert.equal(bare.error.message, 'Hard reset membuang perubahan permanen.');

  // confirm alone is not enough at level 2.
  const half = await h.webview.send(
    req('actions/git', { action: 'reset-hard', hash: head, confirm: true, idempotencyKey: 'rh2' }),
  );
  assert.equal(half.ok, false);

  // Both flags: allowed through to git.
  const full = await h.webview.send(
    req('actions/git', {
      action: 'reset-hard',
      hash: head,
      confirm: true,
      forceAcknowledgement: true,
      idempotencyKey: 'rh3',
    }),
  );
  assert.equal(full.ok, true);
});

test('level 1 confirmation passes with confirm alone', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const blocked = await h.webview.send(
    req('actions/git', { action: 'reset-soft', hash: head, idempotencyKey: 'rs1' }),
  );
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.error.confirmationLevel, 1);

  const allowed = await h.webview.send(
    req('actions/git', { action: 'reset-soft', hash: head, confirm: true, idempotencyKey: 'rs2' }),
  );
  assert.equal(allowed.ok, true);
});

test('push without a recent fetch is blocked as stale', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/git', { action: 'push', remote: 'origin', branch: 'main', idempotencyKey: 'p1' }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'STALE_STATUS');
  assert.equal(response.error.message, 'Status remote kedaluwarsa.');
  assert.deepEqual(response.error.remedies, ['fetch']);
});

test('staging succeeds, invalidates status, and emits repoChanged', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'new.txt'), 'x\n', 'utf8');
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const token = (await repo.status()).statusToken;
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/stage', { paths: ['new.txt'], stage: true, statusToken: token, idempotencyKey: 's1' }),
  );
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal((await repo.status()).staged, true);
  assert.ok(h.webview.events().some((e) => e.kind === 'event/repoChanged'));
  assert.ok(h.webview.events().some((e) => e.kind === 'event/operationProgress'));
});

test('a stale statusToken is rejected with 409', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'new.txt'), 'x\n', 'utf8');
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/stage', {
      paths: ['new.txt'],
      stage: true,
      statusToken: 'deadbeefdeadbeef',
      idempotencyKey: 's2',
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 409);
  assert.equal(response.error.message, BRIDGE_MESSAGES.staleToken);
});

test('a repeated idempotencyKey replays the prior result without re-running git', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  let commits = 0;
  const realCommit = repo.git.commit.bind(repo.git);
  repo.git.commit = async (message: string): Promise<string | null> => {
    commits += 1;
    return realCommit(message);
  };

  await fs.writeFile(path.join(dir, 'idem.txt'), 'x\n', 'utf8');
  await repo.git.stage(['idem.txt']);
  repo.invalidate();
  const token = (await repo.status()).statusToken;

  const payload = { message: 'idempotent commit', statusToken: token, idempotencyKey: 'dup-1' };
  const first = await h.webview.send(req('actions/commit', payload));
  const second = await h.webview.send(req('actions/commit', payload));

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(commits, 1, 'git commit ran once');
  assert.deepEqual(second.data, first.data);
});

test('commit reports pushed: false with pushError when the push fails', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  // Fresh fetch so the guard lets the push attempt reach git, which then fails
  // because there is no `origin` remote.
  await repo.markFetched(Date.now());
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await fs.writeFile(path.join(dir, 'pushy.txt'), 'x\n', 'utf8');
  await repo.git.stage(['pushy.txt']);
  repo.invalidate();
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/commit', {
      message: 'commit then failing push',
      push: true,
      statusToken: token,
      idempotencyKey: 'cp1',
    }),
  );
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const data = response.data as { success: boolean; commit: string | null; pushed: boolean; pushError?: string };
  assert.equal(data.success, true);
  assert.equal(data.pushed, false);
  assert.ok(typeof data.pushError === 'string' && data.pushError.length > 0);
  // The commit is NOT rolled back.
  assert.ok(data.commit !== null);
  assert.equal((await repo.git.log({ limit: 1 }))[0]?.subject, 'commit then failing push');
});

test('commit is blocked while conflicts are unresolved', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  await git.createBranch('side', 'main');
  await fs.writeFile(path.join(dir, 'a.txt'), 'side\n', 'utf8');
  await git.stage(['a.txt']);
  await git.commit('side edit');
  await git.switchBranch('main');
  await fs.writeFile(path.join(dir, 'a.txt'), 'main\n', 'utf8');
  await git.stage(['a.txt']);
  await git.commit('main edit');
  await assert.rejects(() => git.merge('side'));

  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/commit', { message: 'resolve merge', statusToken: '', idempotencyKey: 'mc1' }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'CONFLICT');
  assert.equal(response.error.message, 'Selesaikan semua file konflik.');

  // merge-abort is a resolution action and is allowed during the merge.
  const abort = await h.webview.send(req('actions/git', { action: 'merge-abort', idempotencyKey: 'ma1' }));
  assert.equal(abort.ok, true);
  assert.equal(await repo.git.operationState(), 'idle');
});

test('fetch records the fetch clock, unblocking a later push guard check', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  assert.equal(repo.lastFetchAt(), null);
  const response = await h.webview.send(req('actions/git', { action: 'fetch', idempotencyKey: 'f1' }));
  assert.equal(response.ok, true);
  assert.ok(repo.lastFetchAt() !== null);
});

test('a malformed envelope produces no response at all', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());
  await assert.rejects(
    () => h.webview.send({ id: '', kind: 'repos/status' } as unknown as Request, 20),
    /no response/,
  );
});

test('an unknown request kind is rejected with 400', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('repos/nonsense', {}));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 400);
});

// ------------------------------------------------------- newly wired handlers

test('repos/remotes parses the host and strips embedded credentials', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  await repo.git.run(['remote', 'add', 'origin', 'https://octocat:ghp_secret0123456789abcd@github.com/owner/repo.git']);
  await repo.git.run(['remote', 'add', 'ent', 'git@git.acme.example:team/tooling.git']);
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('repos/remotes', {}));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const remotes = (response.data as { remotes: RemoteInfo[] }).remotes;

  const origin = remotes.find((r) => r.name === 'origin');
  assert.equal(origin?.host, 'github.com');
  assert.equal(origin?.owner, 'owner');
  assert.equal(origin?.repo, 'repo');
  assert.equal(origin?.isGitHub, true);
  // The token never reaches the webview.
  assert.ok(!JSON.stringify(remotes).includes('ghp_secret0123456789abcd'));
  assert.equal(origin?.fetchUrl, 'https://github.com/owner/repo.git');

  const ent = remotes.find((r) => r.name === 'ent');
  assert.equal(ent?.host, 'git.acme.example');
  assert.equal(ent?.isGitHub, false);
});

test('actions/openDiff validates its payload before reaching the host callback', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  for (const payload of [
    { path: '../escape.txt' },
    { path: 'a.txt', hash: 'nope' },
    { path: 'a.txt', hash: '0'.repeat(40), parent: 'nope' },
  ]) {
    const response = await h.webview.send(req('actions/openDiff', payload));
    assert.equal(response.ok, false, JSON.stringify(payload));
    if (response.ok) return;
    assert.equal(response.error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(h.calls.openDiff, [], 'no invalid payload reached the host');

  const ok = await h.webview.send(req('actions/openDiff', { path: 'a.txt' }));
  assert.equal(ok.ok, true);
  assert.deepEqual(h.calls.openDiff, [{ path: 'a.txt' }]);
});

test('actions/openDiff reports UNAVAILABLE when the host cannot open editors', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo, { openDiff: undefined });
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('actions/openDiff', { path: 'a.txt' }));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 503);
  assert.equal(response.error.code, 'UNAVAILABLE');
});

test('actions/showLogs only reveals the channel and takes no parameters', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('actions/showLogs', {}));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(response.data, { shown: true });
  assert.equal(h.calls.showLogs, 1);

  // Extra fields are ignored, so the kind cannot smuggle a command.
  await h.webview.send(req('actions/showLogs', { command: 'workbench.action.terminal.new' }));
  assert.equal(h.calls.showLogs, 2);
});

test('actions/openExternal only accepts https URLs', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());

  for (const url of ['file:///etc/passwd', 'vscode://extension/evil', 'http://github.com/o/r', 'javascript:alert(1)']) {
    const response = await h.webview.send(req('actions/openExternal', { url }));
    assert.equal(response.ok, false, url);
    if (response.ok) return;
    assert.equal(response.error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(h.calls.external, []);

  const ok = await h.webview.send(
    req('actions/openExternal', { url: 'https://github.com/owner/repo/commit/abc1234' }),
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(h.calls.external, ['https://github.com/owner/repo/commit/abc1234']);
});

test('commits/detail rejects a negative fileCursor and forwards a valid one', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({
    folderPath: dir,
    gitPath: 'git',
    store: new MemoryStore(),
    fileLimit: 1,
  });
  const head = (await repo.status()).head as string;
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const bad = await h.webview.send(req('commits/detail', { hash: head, fileCursor: -1 }));
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.code, 'VALIDATION_ERROR');
  assert.equal(bad.error.detail, 'fileCursor');

  const good = await h.webview.send(req('commits/detail', { hash: head, fileCursor: 0 }));
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.equal((good.data as { fileCursor: number }).fileCursor, 0);
});

test('github handlers reach the host and report UNAVAILABLE without one', async (t) => {
  const withHost = harness(null, {
    githubRepo: () =>
      Promise.resolve({
        defaultBranch: 'main',
        private: false,
        htmlUrl: 'https://github.com/o/r',
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      }),
    githubPullRequests: () =>
      Promise.resolve({
        pullRequests: [],
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      }),
    githubLinkage: () =>
      Promise.resolve({
        available: true,
        host: 'github.com',
        owner: 'o',
        repo: 'r',
        webUrl: 'https://github.com/o/r',
        commitUrlTemplate: 'https://github.com/o/r/commit/{hash}',
        apiUrl: 'https://api.github.com',
      }),
  });
  t.after(() => withHost.bridge.dispose());

  const repoInfo = await withHost.webview.send(req('github/repo', { owner: 'o', repo: 'r' }));
  assert.equal(repoInfo.ok, true);
  if (!repoInfo.ok) return;
  assert.equal((repoInfo.data as { defaultBranch: string }).defaultBranch, 'main');

  const prs = await withHost.webview.send(req('github/pullRequests', { owner: 'o', repo: 'r' }));
  assert.equal(prs.ok, true);

  const linkage = await withHost.webview.send(req('github/linkage', {}));
  assert.equal(linkage.ok, true);

  // A bad slug never reaches GitHub.
  const bad = await withHost.webview.send(req('github/repo', { owner: '../etc', repo: 'r' }));
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.equal(bad.error.code, 'VALIDATION_ERROR');

  const withoutHost = harness(null);
  t.after(() => withoutHost.bridge.dispose());
  const stub = await withoutHost.webview.send(req('github/repo', { owner: 'o', repo: 'r' }));
  assert.equal(stub.ok, false);
  if (stub.ok) return;
  assert.equal(stub.error.status, 503);
});

test('a GitHubError maps to its own status and code', () => {
  const auth = toErrorBody(
    new GitHubError({ status: 401, code: 'AUTH_ERROR', message: 'Token GitHub tidak valid.' }),
  );
  assert.equal(auth.status, 401);
  assert.equal(auth.code, 'AUTH_ERROR');
  assert.equal(auth.message, 'Token GitHub tidak valid.');

  const limited = toErrorBody(
    new GitHubError({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Batas permintaan GitHub tercapai.',
      resetAt: 1_700_000_600_000,
    }),
  );
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.equal(limited.detail, 'resetAt=1700000600000');
});

