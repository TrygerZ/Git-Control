import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitError, GitRunner } from '../src/git';
import { GitHubError } from '../src/github';
import { MessageBridge, toErrorBody, type BridgeHost, type WebviewLike } from '../src/bridge';
import { hostText } from '../src/hostText';
import { Logger, type LogSink } from '../src/logger';
import { RepositoryService, type PersistentStore } from '../src/repository';
import { cleanup, makeFixture } from './repoFixture';
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
  const bodyId = toErrorBody(new GitError({ code: 'REPOSITORY_LOCKED', message: 'locked' }), 'id');
  assert.equal(bodyId.status, 409);
  assert.equal(bodyId.code, 'REPOSITORY_LOCKED');
  assert.equal(bodyId.message, hostText('id').bridge.locked);

  const bodyEn = toErrorBody(new GitError({ code: 'REPOSITORY_LOCKED', message: 'locked' }), 'en');
  assert.equal(bodyEn.status, 409);
  assert.equal(bodyEn.code, 'REPOSITORY_LOCKED');
  assert.equal(bodyEn.message, hostText('en').bridge.locked);
});

test('hook rejection maps to 409 HOOK_REJECTED with hook output in detail', () => {
  const stderr = 'pre-commit hook failed\nlint: 3 errors';
  const bodyId = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 1, stderr }),
    'id',
  );
  assert.equal(bodyId.status, 409);
  assert.equal(bodyId.code, 'HOOK_REJECTED');
  assert.equal(bodyId.message, hostText('id').bridge.hookRejected);
  assert.equal(bodyId.detail, stderr);

  const bodyEn = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 1, stderr }),
    'en',
  );
  assert.equal(bodyEn.message, hostText('en').bridge.hookRejected);
});

test('non-fast-forward push maps to 409 NON_FAST_FORWARD with a fetch remedy only', () => {
  const stderr = '! [rejected] main -> main (non-fast-forward)';
  const bodyId = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 1, stderr }),
    'id',
  );
  assert.equal(bodyId.status, 409);
  assert.equal(bodyId.code, 'NON_FAST_FORWARD');
  assert.equal(bodyId.message, hostText('id').bridge.nonFastForward);
  assert.deepEqual(bodyId.remedies, ['fetch']);

  const bodyEn = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 1, stderr }),
    'en',
  );
  assert.equal(bodyEn.message, hostText('en').bridge.nonFastForward);
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
  language: 'en',
  ui: { zoom: 1, branchFilter: '' },
};

/** One commit, `a.txt` = `one\n`, on `main`. Copied from a shared template. */
function makeRepo(): Promise<string> {
  return makeFixture('single');
}

interface Harness {
  webview: FakeWebview;
  bridge: MessageBridge;
  repo: RepositoryService | null;
  /** Calls recorded by the optional host callbacks. */
  calls: { showLogs: number; openExplorer: number; openDiff: OpenDiffPayload[]; external: string[] };
}

function harness(repo: RepositoryService | null, overrides: Partial<BridgeHost> = {}): Harness {
  const webview = new FakeWebview();
  const calls = { showLogs: 0, openExplorer: 0, openDiff: [] as OpenDiffPayload[], external: [] as string[] };
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
    openExplorer: () => {
      calls.openExplorer += 1;
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
  const h = harness(null, { settings: () => ({ ...SETTINGS, language: 'id' }) });
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('repos/status', {}));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 404);
  assert.equal(response.error.code, 'NOT_FOUND');
  assert.equal(response.error.message, hostText('id').bridge.noRepository);

  const hEn = harness(null, { settings: () => ({ ...SETTINGS, language: 'en' }) });
  t.after(() => hEn.bridge.dispose());
  const responseEn = await hEn.webview.send(req('repos/status', {}));
  assert.equal(responseEn.ok, false);
  if (responseEn.ok) return;
  assert.equal(responseEn.error.message, hostText('en').bridge.noRepository);
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
  const hId = harness(repo, { settings: () => ({ ...SETTINGS, language: 'id' }) });
  t.after(() => hId.bridge.dispose());

  const responseId = await hId.webview.send(
    req('actions/git', { action: 'checkout-branch', branch: 'main', idempotencyKey: 'co1' }),
  );
  assert.equal(responseId.ok, false);
  if (responseId.ok) return;
  assert.equal(responseId.error.code, 'DIRTY_TREE');
  assert.equal(responseId.error.message, 'Commit atau stash perubahan sebelum checkout.');
  assert.deepEqual(responseId.error.remedies, ['commit', 'stash', 'cancel']);

  const hEn = harness(repo, { settings: () => ({ ...SETTINGS, language: 'en' }) });
  t.after(() => hEn.bridge.dispose());

  const responseEn = await hEn.webview.send(
    req('actions/git', { action: 'checkout-branch', branch: 'main', idempotencyKey: 'co1-en' }),
  );
  assert.equal(responseEn.ok, false);
  if (responseEn.ok) return;
  assert.equal(responseEn.error.message, 'Commit or stash changes before checkout.');
});

test('reset-hard needs confirm plus forceAcknowledgement, enforced host-side', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  const hId = harness(repo, { settings: () => ({ ...SETTINGS, language: 'id' }) });
  t.after(() => hId.bridge.dispose());

  // No flags: blocked, level 2, high risk.
  const bareId = await hId.webview.send(
    req('actions/git', { action: 'reset-hard', hash: head, idempotencyKey: 'rh1' }),
  );
  assert.equal(bareId.ok, false);
  if (bareId.ok) return;
  assert.equal(bareId.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(bareId.error.confirmationLevel, 2);
  assert.equal(bareId.error.risk, 'high');
  assert.equal(bareId.error.message, 'Hard reset membuang perubahan permanen.');

  const hEn = harness(repo, { settings: () => ({ ...SETTINGS, language: 'en' }) });
  t.after(() => hEn.bridge.dispose());
  const bareEn = await hEn.webview.send(
    req('actions/git', { action: 'reset-hard', hash: head, idempotencyKey: 'rh1-en' }),
  );
  assert.equal(bareEn.ok, false);
  if (bareEn.ok) return;
  assert.equal(bareEn.error.message, 'Hard reset discards changes permanently.');

  // confirm alone is not enough at level 2.
  const half = await hId.webview.send(
    req('actions/git', { action: 'reset-hard', hash: head, confirm: true, idempotencyKey: 'rh2' }),
  );
  assert.equal(half.ok, false);

  // Both flags: allowed through to git.
  const full = await hId.webview.send(
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
  const hId = harness(repo, { settings: () => ({ ...SETTINGS, language: 'id' }) });
  t.after(() => hId.bridge.dispose());

  const responseId = await hId.webview.send(
    req('actions/git', { action: 'push', remote: 'origin', branch: 'main', idempotencyKey: 'p1' }),
  );
  assert.equal(responseId.ok, false);
  if (responseId.ok) return;
  assert.equal(responseId.error.code, 'STALE_STATUS');
  assert.equal(responseId.error.message, 'Status remote kedaluwarsa.');
  assert.deepEqual(responseId.error.remedies, ['fetch']);

  const hEn = harness(repo, { settings: () => ({ ...SETTINGS, language: 'en' }) });
  t.after(() => hEn.bridge.dispose());

  const responseEn = await hEn.webview.send(
    req('actions/git', { action: 'push', remote: 'origin', branch: 'main', idempotencyKey: 'p1-en' }),
  );
  assert.equal(responseEn.ok, false);
  if (responseEn.ok) return;
  assert.equal(responseEn.error.message, 'Remote status is stale.');
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
  const hId = harness(repo, { settings: () => ({ ...SETTINGS, language: 'id' }) });
  t.after(() => hId.bridge.dispose());

  const responseId = await hId.webview.send(
    req('actions/stage', {
      paths: ['new.txt'],
      stage: true,
      statusToken: 'deadbeefdeadbeef',
      idempotencyKey: 's2',
    }),
  );
  assert.equal(responseId.ok, false);
  if (responseId.ok) return;
  assert.equal(responseId.error.status, 409);
  assert.equal(responseId.error.message, hostText('id').bridge.staleToken);

  const hEn = harness(repo, { settings: () => ({ ...SETTINGS, language: 'en' }) });
  t.after(() => hEn.bridge.dispose());
  const responseEn = await hEn.webview.send(
    req('actions/stage', {
      paths: ['new.txt'],
      stage: true,
      statusToken: 'deadbeefdeadbeef',
      idempotencyKey: 's2_en',
    }),
  );
  assert.equal(responseEn.ok, false);
  if (responseEn.ok) return;
  assert.equal(responseEn.error.message, hostText('en').bridge.staleToken);
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
  const hId = harness(repo, { settings: () => ({ ...SETTINGS, language: 'id' }) });
  t.after(() => hId.bridge.dispose());

  const responseId = await hId.webview.send(
    req('actions/commit', { message: 'resolve merge', statusToken: '', idempotencyKey: 'mc1' }),
  );
  assert.equal(responseId.ok, false);
  if (responseId.ok) return;
  assert.equal(responseId.error.code, 'CONFLICT');
  assert.equal(responseId.error.message, 'Selesaikan semua file konflik.');

  const hEn = harness(repo, { settings: () => ({ ...SETTINGS, language: 'en' }) });
  t.after(() => hEn.bridge.dispose());

  const responseEn = await hEn.webview.send(
    req('actions/commit', { message: 'resolve merge', statusToken: '', idempotencyKey: 'mc1-en' }),
  );
  assert.equal(responseEn.ok, false);
  if (responseEn.ok) return;
  assert.equal(responseEn.error.message, 'Resolve all conflicted files.');
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

test('actions/openExplorer only opens the explorer panel and takes no parameters', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('actions/openExplorer', {}));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(response.data, { opened: true });
  assert.equal(h.calls.openExplorer, 1);

  // Extra fields are ignored, so the kind cannot smuggle a command.
  await h.webview.send(req('actions/openExplorer', { command: 'workbench.action.terminal.new' }));
  assert.equal(h.calls.openExplorer, 2);
});

test('actions/openExternal rejects every non-https scheme (SEC-006)', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());

  for (const url of [
    'file:///etc/passwd',
    'vscode://extension/evil',
    'command:workbench.action.terminal.new',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'http://github.com/o/r',
    'ftp://github.com/o/r',
    'HTTPS:/\\/\\github.com/o/r',
    'not a url',
    '',
  ]) {
    const response = await h.webview.send(req('actions/openExternal', { url }));
    assert.equal(response.ok, false, url);
    if (response.ok) return;
    assert.equal(response.error.code, 'VALIDATION_ERROR', url);
  }
  assert.deepEqual(h.calls.external, [], 'nothing reached the host');

  const ok = await h.webview.send(
    req('actions/openExternal', { url: 'https://github.com/owner/repo/commit/abc1234' }),
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(h.calls.external, ['https://github.com/owner/repo/commit/abc1234']);
});

test('actions/openExternal restricts the host to an allowlist (SEC-006)', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());

  // With no repository the allowlist is the static pair only.
  for (const url of [
    'https://evil.example/anything',
    'https://github.com.evil.example/o/r',
    'https://notgithub.com/o/r',
    'https://api.github.com.evil.example/user',
  ]) {
    const response = await h.webview.send(req('actions/openExternal', { url }));
    assert.equal(response.ok, false, url);
    if (response.ok) return;
    assert.equal(response.error.code, 'VALIDATION_ERROR', url);
    assert.equal(response.error.detail, 'host', url);
  }

  for (const url of ['https://github.com/o/r', 'https://www.github.com/o/r', 'https://git-scm.com/downloads']) {
    const response = await h.webview.send(req('actions/openExternal', { url }));
    assert.equal(response.ok, true, url);
  }
  assert.equal(h.calls.external.length, 3);
});

test('actions/openExternal rejects embedded userinfo that fakes a host (SEC-006)', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());

  // Reads as GitHub to a human, resolves to `evil.example`.
  for (const url of [
    'https://github.com@evil.example/',
    'https://github.com:x@evil.example/o/r',
    // And the reverse: real host, but userinfo present, which we refuse anyway.
    'https://user:pass@github.com/o/r',
  ]) {
    const response = await h.webview.send(req('actions/openExternal', { url }));
    assert.equal(response.ok, false, url);
  }
  assert.deepEqual(h.calls.external, []);
});

test("actions/openExternal admits the repository's own remote host (SEC-006)", async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  await repo.git.run(['remote', 'add', 'origin', 'https://git.acme.example/team/tooling.git']);
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const allowed = await h.webview.send(
    req('actions/openExternal', { url: 'https://git.acme.example/team/tooling/commit/abc1234' }),
  );
  assert.equal(allowed.ok, true, 'the configured remote host is a legitimate link target');

  // A host the repository has no relationship with is still refused, so a
  // malicious `origin` can only aim a link at itself.
  const blocked = await h.webview.send(
    req('actions/openExternal', { url: 'https://unrelated.example/x' }),
  );
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.error.detail, 'host');
});

test('actions/openExternal admits the configured GitHub API host (SEC-006)', async (t) => {
  const h = harness(null, {
    settings: () => ({ ...SETTINGS, githubApiUrl: 'https://ghe.acme.example/api/v3' }),
  });
  t.after(() => h.bridge.dispose());

  const ok = await h.webview.send(req('actions/openExternal', { url: 'https://ghe.acme.example/o/r' }));
  assert.equal(ok.ok, true);
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
    githubCommitAuthors: () =>
      Promise.resolve({
        authors: [{ hash: 'a'.repeat(40), login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/1' }],
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

  const authors = await withHost.webview.send(
    req('github/commitAuthors', { owner: 'o', repo: 'r', hashes: ['a'.repeat(40)] }),
  );
  assert.equal(authors.ok, true);

  const badAuthors = await withHost.webview.send(
    req('github/commitAuthors', { owner: 'o', repo: 'r', hashes: ['not-a-hash'] }),
  );
  assert.equal(badAuthors.ok, false);
  if (!badAuthors.ok) assert.equal(badAuthors.error.code, 'VALIDATION_ERROR');

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

test('persisted zoom is normalized to valid range host-side', async (t) => {
  const store = new MemoryStore();
  // Simulate an out-of-range legacy stored zoom value (e.g. 0.25 when MIN_ZOOM is now 0.35)
  await store.update('gitControl.uiPreferences', { zoom: 0.25, branchFilter: 'main' });

  // Stand-in host mirroring Controller.uiPreferences and setUiPreference
  const readPreferences = () => {
    const stored = store.get<Partial<{ zoom: number; branchFilter: string }>>('gitControl.uiPreferences', {});
    const raw = typeof stored.zoom === 'number' ? stored.zoom : 1;
    const clamped = Math.min(4, Math.max(0.35, raw));
    if (stored.zoom !== undefined && stored.zoom !== clamped) {
      void store.update('gitControl.uiPreferences', { ...stored, zoom: clamped });
    }
    return { zoom: clamped, branchFilter: typeof stored.branchFilter === 'string' ? stored.branchFilter : '' };
  };

  const hostSnapshot = (): SettingsSnapshot => ({
    ...SETTINGS,
    ui: readPreferences(),
  });

  const withHost = harness(null, {
    settings: hostSnapshot,
    setUiPreference: async (payload) => {
      const prefs = readPreferences();
      if (payload.key === 'zoom' && typeof payload.value === 'number') {
        prefs.zoom = Math.min(4, Math.max(0.35, payload.value));
      }
      await store.update('gitControl.uiPreferences', prefs);
      return hostSnapshot();
    },
  });
  t.after(() => withHost.bridge.dispose());

  // 1. Initial settings/get returns normalized zoom (0.35 instead of 0.25)
  const getRes = await withHost.webview.send(req('settings/get', {}));
  assert.equal(getRes.ok, true);
  if (!getRes.ok) return;
  assert.equal((getRes.data as SettingsSnapshot).ui.zoom, 0.35);

  // 2. Underlying store was updated to the normalized value
  const persisted = store.get<{ zoom: number }>('gitControl.uiPreferences', { zoom: 1 });
  assert.equal(persisted.zoom, 0.35);

  // 3. Attempting to set an out-of-range zoom (e.g. 10 or 0.1) normalizes on write
  const setRes = await withHost.webview.send(req('settings/set', { key: 'zoom', value: 10 }));
  assert.equal(setRes.ok, true);
  if (!setRes.ok) return;
  assert.equal((setRes.data as SettingsSnapshot).ui.zoom, 4);
  const persistedAfterSet = store.get<{ zoom: number }>('gitControl.uiPreferences', { zoom: 1 });
  assert.equal(persistedAfterSet.zoom, 4);
});

test('persisted language is updated and normalized host-side', async (t) => {
  let activeLang: 'en' | 'id' = 'en';

  const hostSnapshot = (): SettingsSnapshot => ({
    ...SETTINGS,
    language: activeLang,
  });

  const withHost = harness(null, {
    settings: hostSnapshot,
    setUiPreference: async (payload) => {
      if (payload.key === 'language' && typeof payload.value === 'string') {
        activeLang = payload.value === 'id' ? 'id' : 'en';
      }
      return hostSnapshot();
    },
  });
  t.after(() => withHost.bridge.dispose());

  // 1. Initial settings/get returns default 'en'
  const getRes = await withHost.webview.send(req('settings/get', {}));
  assert.equal(getRes.ok, true);
  if (!getRes.ok) return;
  assert.equal((getRes.data as SettingsSnapshot).language, 'en');

  // 2. Setting valid 'id' updates snapshot
  const setRes = await withHost.webview.send(req('settings/set', { key: 'language', value: 'id' }));
  assert.equal(setRes.ok, true);
  if (!setRes.ok) return;
  assert.equal((setRes.data as SettingsSnapshot).language, 'id');

  // 3. Setting unknown language normalizes back to 'en'
  const setUnknown = await withHost.webview.send(req('settings/set', { key: 'language', value: 'fr' }));
  assert.equal(setUnknown.ok, true);
  if (!setUnknown.ok) return;
  assert.equal((setUnknown.data as SettingsSnapshot).language, 'en');
});

test('language change broadcasts event/settingsChanged to all attached bridges', async (t) => {
  let activeLang: 'en' | 'id' = 'en';

  const hostSnapshot = (): SettingsSnapshot => ({
    ...SETTINGS,
    language: activeLang,
  });

  const bridges = new Set<MessageBridge>();
  const broadcastSettings = () => {
    const snapshot = hostSnapshot();
    for (const b of bridges) b.emit('event/settingsChanged', snapshot);
  };

  const bridgeHost: BridgeHost = {
    logger: new Logger(new NullSink()),
    resolveRepository: () => Promise.resolve(null),
    settings: hostSnapshot,
    setUiPreference: async (payload) => {
      if (payload.key === 'language' && typeof payload.value === 'string') {
        activeLang = payload.value === 'id' ? 'id' : 'en';
      }
      broadcastSettings();
      return hostSnapshot();
    },
    githubAuth: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
    connectGitHub: () => Promise.resolve({ connected: true, login: null, scopes: [] }),
    disconnectGitHub: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
  };

  const webview1 = new FakeWebview();
  const bridge1 = new MessageBridge(webview1, bridgeHost);
  bridges.add(bridge1);
  t.after(() => bridge1.dispose());

  const webview2 = new FakeWebview();
  const bridge2 = new MessageBridge(webview2, bridgeHost);
  bridges.add(bridge2);
  t.after(() => bridge2.dispose());

  // Trigger language change on bridge1 (e.g. Pending Changes panel)
  const res = await webview1.send(req('settings/set', { key: 'language', value: 'id' }));
  assert.equal(res.ok, true);

  // Both webviews receive event/settingsChanged with updated snapshot
  const events1 = webview1.events().filter((e) => e.kind === 'event/settingsChanged');
  const events2 = webview2.events().filter((e) => e.kind === 'event/settingsChanged');

  assert.equal(events1.length, 1);
  assert.equal(events2.length, 1);
  const ev1 = events1[0];
  const ev2 = events2[0];
  assert.ok(ev1 !== undefined && ev2 !== undefined);
  assert.equal((ev1.payload as SettingsSnapshot).language, 'id');
  assert.equal((ev2.payload as SettingsSnapshot).language, 'id');
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

// ------------------------------------------------------------------- SEC-008

test('actions/git rejects a stale statusToken with 409, like stage and commit (SEC-008)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  const hId = harness(repo, { settings: () => ({ ...SETTINGS, language: 'id' }) });
  t.after(() => hId.bridge.dispose());

  const staleId = await hId.webview.send(
    req('actions/git', {
      action: 'reset-soft',
      hash: head,
      confirm: true,
      statusToken: 'deadbeefdeadbeef',
      idempotencyKey: 'st-1',
    }),
  );
  assert.equal(staleId.ok, false);
  if (staleId.ok) return;
  assert.equal(staleId.error.status, 409);
  assert.equal(staleId.error.code, 'CONFLICT');
  assert.equal(staleId.error.message, hostText('id').bridge.staleToken);

  const hEn = harness(repo, { settings: () => ({ ...SETTINGS, language: 'en' }) });
  t.after(() => hEn.bridge.dispose());

  const staleEn = await hEn.webview.send(
    req('actions/git', {
      action: 'reset-soft',
      hash: head,
      confirm: true,
      statusToken: 'deadbeefdeadbeef',
      idempotencyKey: 'st-1-en',
    }),
  );
  assert.equal(staleEn.ok, false);
  if (staleEn.ok) return;
  assert.equal(staleEn.error.message, hostText('en').bridge.staleToken);

  // The mutation did not run: HEAD is unchanged.
  assert.equal((await repo.status()).head, head);

  // The matching token is accepted.
  repo.invalidate();
  const fresh = (await repo.status()).statusToken;
  const ok = await hId.webview.send(
    req('actions/git', {
      action: 'reset-soft',
      hash: head,
      confirm: true,
      statusToken: fresh,
      idempotencyKey: 'st-2',
    }),
  );
  assert.equal(ok.ok, true);
});

test('actions/git still accepts an absent statusToken for compatibility (SEC-008)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('actions/git', { action: 'fetch', idempotencyKey: 'st-3' }));
  assert.equal(response.ok, true, 'no token means "no snapshot to compare", not a rejection');
});

test('reset-hard re-evaluates the guard inside the exclusive lock (SEC-008)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // Dirty the tree AFTER the outer guard has seen a clean status, by hooking the
  // point where the lock is already held. This is exactly the TOCTOU the finding
  // describes: an external process writing between the check and the mutation.
  let resets = 0;
  const realRun = repo.git.run.bind(repo.git);
  repo.git.run = async (args, opts) => {
    if (args[0] === 'reset') resets += 1;
    return realRun(args, opts);
  };
  const realResetHard = repo.git.resetHard.bind(repo.git);
  repo.git.resetHard = (hash, opts = {}) =>
    realResetHard(hash, {
      precheck: async () => {
        // Simulate the external writer. `precheck` runs after this, inside the
        // lock, and must see the file.
        await fs.writeFile(path.join(dir, 'raced.txt'), 'x\n', 'utf8');
        if (opts.precheck !== undefined) await opts.precheck();
      },
    });

  const response = await h.webview.send(
    req('actions/git', {
      action: 'reset-hard',
      hash: head,
      confirm: true,
      forceAcknowledgement: true,
      idempotencyKey: 'race-1',
    }),
  );

  // The in-lock re-check saw the dirty tree and refused. Without it `git reset
  // --hard` would have run and discarded `raced.txt`.
  assert.equal(response.ok, false, 'the in-lock guard must reject a tree dirtied after the outer check');
  if (response.ok) return;
  assert.equal(response.error.code, 'DIRTY_TREE');
  assert.equal(resets, 0, 'git reset never ran');
  // The work the guard protected is still there.
  assert.equal(await fs.readFile(path.join(dir, 'raced.txt'), 'utf8'), 'x\n');
});

test('reset-hard still succeeds when nothing changes under the lock (SEC-008)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/git', {
      action: 'reset-hard',
      hash: head,
      confirm: true,
      forceAcknowledgement: true,
      idempotencyKey: 'race-2',
    }),
  );
  assert.equal(response.ok, true, 'the added re-check must not break the ordinary path');
});

// ------------------------------------------------------------------- SEC-012

test('git stderr is redacted before it crosses into the webview (SEC-012)', () => {
  const token = 'ghp_secret0123456789abcdefgh';
  // Hook rejection: `detail` is the whole point of this arm.
  const hook = toErrorBody(
    new GitError({
      code: 'GIT_FAILED',
      message: 'failed',
      exitCode: 1,
      stderr: `pre-push hook declined\nremote: https://x-access-token:${token}@github.com/o/r.git`,
    }),
  );
  assert.equal(hook.code, 'HOOK_REJECTED');
  assert.ok(hook.detail !== undefined);
  assert.ok(!hook.detail.includes(token), 'the token must not reach the webview');
  assert.ok(hook.detail.includes('[redacted]'));
  // The useful part of the hook message survives.
  assert.ok(hook.detail.includes('pre-push hook declined'));

  // Non-fast-forward.
  const nonFf = toErrorBody(
    new GitError({
      code: 'GIT_FAILED',
      message: 'failed',
      exitCode: 1,
      stderr: `! [rejected] main -> main (non-fast-forward)\nurl: https://user:${token}@github.com/o/r`,
    }),
  );
  assert.equal(nonFf.code, 'NON_FAST_FORWARD');
  assert.ok(nonFf.detail !== undefined && !nonFf.detail.includes(token));

  // Generic 500, where both `message` and `detail` come from git.
  const generic = toErrorBody(
    new GitError({
      code: 'GIT_FAILED',
      message: `fatal: unable to access https://user:${token}@github.com/o/r`,
      exitCode: 128,
      stderr: `fatal: unable to access https://user:${token}@github.com/o/r`,
    }),
  );
  assert.equal(generic.code, 'SERVER_ERROR');
  assert.ok(!generic.message.includes(token), 'message is redacted too');
  assert.ok(generic.detail !== undefined && !generic.detail.includes(token));

  // Timeout and spawn failures carry `err.message`, which can hold a URL.
  for (const code of ['GIT_TIMEOUT', 'GIT_SPAWN_FAILED', 'VALIDATION_ERROR'] as const) {
    const body = toErrorBody(
      new GitError({ code, message: `boom https://user:${token}@github.com/o/r` }),
    );
    assert.ok(body.detail !== undefined && !body.detail.includes(token), code);
  }
});

test('a fine-grained PAT in stderr is redacted on the webview path too (SEC-012)', () => {
  const token = 'github_pat_11ABCDEFG0aBcDeFgHiJk_ZZZZZZZZZZZZZZZZZZ';
  const body = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 1, stderr: `sent Bearer ${token}` }),
  );
  assert.ok(body.detail !== undefined && !body.detail.includes(token));
});

// ------------------------------------------------------------------- SEC-014

test('a guard rejection is not cached, so a confirmed retry reaches the guard (SEC-014)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // The flow the webview actually performs: ONE idempotency key across the
  // confirmation dialog.
  const key = 'guard-retry-1';

  const blocked = await h.webview.send(
    req('actions/git', { action: 'reset-hard', hash: head, idempotencyKey: key }),
  );
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(blocked.error.confirmationLevel, 2);

  // Same key, now with both flags. Pre-fix this replayed the cached rejection and
  // the dialog could never be confirmed.
  const confirmed = await h.webview.send(
    req('actions/git', {
      action: 'reset-hard',
      hash: head,
      confirm: true,
      forceAcknowledgement: true,
      idempotencyKey: key,
    }),
  );
  assert.equal(confirmed.ok, true, 'confirming must actually run the action');
});

test('a level-1 guard rejection is retryable under the same key (SEC-014)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const key = 'guard-retry-2';
  const blocked = await h.webview.send(
    req('actions/git', { action: 'reset-soft', hash: head, idempotencyKey: key }),
  );
  assert.equal(blocked.ok, false);
  const confirmed = await h.webview.send(
    req('actions/git', { action: 'reset-soft', hash: head, confirm: true, idempotencyKey: key }),
  );
  assert.equal(confirmed.ok, true);
});

test('a DIRTY_TREE rejection is retryable once the tree is clean (SEC-014)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'dirty.txt'), 'x\n', 'utf8');
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const key = 'guard-retry-3';
  const blocked = await h.webview.send(
    req('actions/git', { action: 'checkout-branch', branch: 'main', idempotencyKey: key }),
  );
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.error.code, 'DIRTY_TREE');

  // The user takes the offered remedy, then retries with the same key.
  await fs.rm(path.join(dir, 'dirty.txt'));
  repo.invalidate();
  const retried = await h.webview.send(
    req('actions/git', { action: 'checkout-branch', branch: 'main', idempotencyKey: key }),
  );
  assert.equal(retried.ok, true, 'a resolved DIRTY_TREE must not be replayed from cache');
});

test('a genuine failure IS still replayed for a repeated key (SEC-014)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  // Fresh fetch so the guard lets the push reach git, which fails: no `origin`.
  await repo.markFetched(Date.now());
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  let pushes = 0;
  const realPush = repo.git.push.bind(repo.git);
  repo.git.push = async (opts) => {
    pushes += 1;
    return realPush(opts);
  };

  const key = 'push-fail-1';
  const payload = { action: 'push', remote: 'origin', branch: 'main', idempotencyKey: key };
  const first = await h.webview.send(req('actions/git', payload));
  const second = await h.webview.send(req('actions/git', payload));

  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  if (first.ok || second.ok) return;
  assert.deepEqual(second.error, first.error, 'the same failure is replayed verbatim');
  assert.equal(pushes, 1, 'git push ran once: a repository fact is not re-attempted');
});

test('the double-click guarantee survives: a successful mutation still replays (SEC-014)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  let reverts = 0;
  const realRevert = repo.git.revert.bind(repo.git);
  repo.git.revert = async (hash) => {
    reverts += 1;
    return realRevert(hash);
  };

  const payload = {
    action: 'revert',
    hash: head,
    confirm: true,
    idempotencyKey: 'revert-dup-1',
  };
  const first = await h.webview.send(req('actions/git', payload));
  const second = await h.webview.send(req('actions/git', payload));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(second.data, first.data);
  assert.equal(reverts, 1, 'PRD Kasus 2: one logical operation runs once');
});


// --------------------------------------------------------------- Bug 1 regression

test('unstaging an untracked path is a no-op success, never a pathspec error', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'lambada.txt'), 'x\n', 'utf8');
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // The webview filters its own selection, but it is untrusted input: the host
  // must filter again. `git restore --staged` on an untracked path fails with
  // `pathspec ... did not match any file(s) known to git`, so git must not run.
  let unstages = 0;
  const realUnstage = repo.git.unstage.bind(repo.git);
  repo.git.unstage = async (paths) => {
    unstages += 1;
    return realUnstage(paths);
  };

  const token = (await repo.status()).statusToken;
  const response = await h.webview.send(
    req('actions/stage', {
      paths: ['lambada.txt'],
      stage: false,
      statusToken: token,
      idempotencyKey: 'u1',
    }),
  );
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(unstages, 0, 'git was never asked to unstage an untracked path');
  // The file is untouched and still untracked.
  assert.ok((await repo.status()).changes.some((c) => c.path === 'lambada.txt' && c.untracked));
});

test('a mixed unstage batch drops only the untracked paths', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'lambada.txt'), 'x\n', 'utf8');
  await fs.writeFile(path.join(dir, 'a.txt'), 'changed\n', 'utf8');
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  await repo.git.stage(['a.txt']);
  repo.invalidate();
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const seen: string[][] = [];
  const realUnstage = repo.git.unstage.bind(repo.git);
  repo.git.unstage = async (paths) => {
    seen.push([...paths]);
    return realUnstage(paths);
  };

  const token = (await repo.status()).statusToken;
  const response = await h.webview.send(
    req('actions/stage', {
      paths: ['a.txt', 'lambada.txt'],
      stage: false,
      statusToken: token,
      idempotencyKey: 'u2',
    }),
  );
  assert.equal(response.ok, true);
  assert.deepEqual(seen, [['a.txt']]);
  const after = await repo.status();
  assert.equal(after.staged, false);
  assert.ok(after.changes.some((c) => c.path === 'lambada.txt' && c.untracked));
});

test('a mixed stage batch keeps untracked paths', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'lambada.txt'), 'x\n', 'utf8');
  await fs.writeFile(path.join(dir, 'a.txt'), 'changed\n', 'utf8');
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const seen: string[][] = [];
  const realStage = repo.git.stage.bind(repo.git);
  repo.git.stage = async (paths) => {
    seen.push([...paths]);
    return realStage(paths);
  };

  const token = (await repo.status()).statusToken;
  const response = await h.webview.send(
    req('actions/stage', {
      paths: ['a.txt', 'lambada.txt'],
      stage: true,
      statusToken: token,
      idempotencyKey: 's1',
    }),
  );
  assert.equal(response.ok, true);
  assert.deepEqual(seen, [['a.txt', 'lambada.txt']]);
  const after = await repo.status();
  assert.ok(after.changes.every((c) => c.staged));
});

test('staging an ignored path is dropped, not failed', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n', 'utf8');
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  await repo.git.stage(['.gitignore']);
  await repo.git.commit('ignore rule');
  await fs.writeFile(path.join(dir, 'ignored.txt'), 'secret\n', 'utf8');
  await fs.writeFile(path.join(dir, 'a.txt'), 'changed\n', 'utf8');
  repo.invalidate();
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const seen: string[][] = [];
  const realStage = repo.git.stage.bind(repo.git);
  repo.git.stage = async (paths) => {
    seen.push([...paths]);
    return realStage(paths);
  };

  const token = (await repo.status({ includeIgnored: true })).statusToken;
  const response = await h.webview.send(
    req('actions/stage', {
      paths: ['a.txt', 'ignored.txt'],
      stage: true,
      statusToken: token,
      idempotencyKey: 's2',
    }),
  );
  assert.equal(response.ok, true);
  assert.deepEqual(seen, [['a.txt']]);
  const after = await repo.status();
  assert.ok(after.changes.some((c) => c.path === 'a.txt' && c.staged));
});
