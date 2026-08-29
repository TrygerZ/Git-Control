import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitError, GitRunner } from '../src/git';
import { BRIDGE_MESSAGES, MessageBridge, toErrorBody, type BridgeHost, type WebviewLike } from '../src/bridge';
import { Logger, type LogSink } from '../src/logger';
import { RepositoryService, type PersistentStore } from '../src/repository';
import type { HostEvent, HostMessage, Request, Response, SettingsSnapshot } from '../src/messages';

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
}

function harness(repo: RepositoryService | null): Harness {
  const webview = new FakeWebview();
  const host: BridgeHost = {
    logger: new Logger(new NullSink()),
    resolveRepository: () => Promise.resolve(repo),
    settings: () => SETTINGS,
    setUiPreference: () => Promise.resolve(SETTINGS),
    githubAuth: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
    connectGitHub: () => Promise.resolve({ connected: true, login: null, scopes: [] }),
    disconnectGitHub: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
  };
  return { webview, bridge: new MessageBridge(webview, host), repo };
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
