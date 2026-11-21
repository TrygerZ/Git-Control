import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitError, GitRunner } from '../src/git';
import { GitHubError } from '../src/github';
import { MessageBridge, toErrorBody, type BridgeHost, type WebviewLike } from '../src/bridge';
import { idempotencyKeyOf, shouldRemember } from '../src/bridgePure';
import { hostText } from '../src/hostText';
import { Logger, type LogSink } from '../src/logger';
import { RepositoryService, type PersistentStore } from '../src/repository';
import { advancePullRequest, advanceRemote, cleanup, makeFixture, setPullRequestHead } from './repoFixture';
import type {
  ActionsJobsPayload,
  ActionsRunsPayload,
  ContributorInfo,
  HostEvent,
  HostMessage,
  OpenDiffPayload,
  OpenStashDiffHostPayload,
  PullDetail,
  RemoteInfo,
  Request,
  Response,
  SettingsSnapshot,
  WorkflowInfo,
  WorkflowInputsResult,
  WorkflowRunInfo,
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

test('dirty tree git rejection maps to 412 DIRTY_TREE with commit/stash/cancel remedies', () => {
  const stderr =
    'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\nPlease commit your changes or stash them before you merge.\nAborting\nfatal: revert failed';
  const bodyId = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 128, stderr }),
    'id',
  );
  assert.equal(bodyId.status, 412);
  assert.equal(bodyId.code, 'DIRTY_TREE');
  assert.equal(bodyId.message, hostText('id').guard.dirty);
  assert.equal(bodyId.detail, stderr);
  assert.deepEqual(bodyId.remedies, ['commit', 'stash', 'cancel']);

  const bodyEn = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 128, stderr }),
    'en',
  );
  assert.equal(bodyEn.status, 412);
  assert.equal(bodyEn.code, 'DIRTY_TREE');
  assert.equal(bodyEn.message, hostText('en').guard.dirty);
  assert.deepEqual(bodyEn.remedies, ['commit', 'stash', 'cancel']);
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

/**
 * A diverged `pr/<n>` is a refusal the user is meant to read, not a crash. The
 * git layer raises it with its own `CONFLICT` code, and the transport must map
 * that code rather than fall through to the generic 500 arm: the whole point of
 * the refusal is that its message names the branch.
 */
test('P23: a diverged pull request branch maps to 409 CONFLICT with a cancel remedy', () => {
  const message = 'Local pr/2 has commits that are not on the pull request.';
  const bodyId = toErrorBody(new GitError({ code: 'CONFLICT', message }), 'id');
  assert.equal(bodyId.status, 409);
  assert.equal(bodyId.code, 'CONFLICT');
  assert.equal(bodyId.message, message, 'the branch name reaches the user');
  assert.deepEqual(bodyId.remedies, ['cancel'], 'fetch does not help a diverged local branch');

  const bodyEn = toErrorBody(new GitError({ code: 'CONFLICT', message }), 'en');
  assert.equal(bodyEn.status, 409);
  assert.equal(bodyEn.code, 'CONFLICT');
});

/**
 * The checked-out refresh path cannot move a diverged branch either, and git says
 * so with its own sentence rather than a code we raised. Both spellings have to
 * land on the same refusal, or the user sees a crash screen for the case the
 * changelog describes.
 */
test('P23: a refused fast-forward maps to 409 CONFLICT, not a server error', () => {
  const diverged =
    'hint: Diverging branches can be fast-forwarded, you need to either:\nfatal: Not possible to fast-forward, aborting.';
  const body = toErrorBody(new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 128, stderr: diverged }), 'en');
  assert.equal(body.status, 409);
  assert.equal(body.code, 'CONFLICT');
  assert.deepEqual(body.remedies, ['cancel']);
  assert.equal(body.message, hostText('en').bridge.prBranchDiverged);

  // A dirty tree is still a dirty tree: git refusing to overwrite local changes
  // is the case the commit and stash remedies exist for, and classifying it as a
  // divergence would offer no way out.
  const dirty =
    'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\nPlease commit your changes or stash them before you merge.\nAborting';
  const dirtyBody = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 128, stderr: dirty }),
    'en',
  );
  assert.equal(dirtyBody.status, 412, 'a dirty tree keeps its own classification');
  assert.equal(dirtyBody.code, 'DIRTY_TREE');
  assert.deepEqual(dirtyBody.remedies, ['commit', 'stash', 'cancel']);

  // A real merge with staged-only changes: the guard does not block it (a staged
  // file is not "dirty"), git's ort path refuses with the bare merge line and no
  // advice sentence, and the user must still get the commit/stash escape. Treating
  // this as a divergence would tell them a false story about their pull request.
  const mergeNoAdvice =
    'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\nAborting';
  const mergeBody = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 128, stderr: mergeNoAdvice }),
    'en',
  );
  assert.equal(mergeBody.code, 'DIRTY_TREE', 'a bare merge refusal is a dirty tree, not a divergence');
  assert.deepEqual(mergeBody.remedies, ['commit', 'stash', 'cancel']);

  // The same overwrite line without git's advice sentence must not be mistaken
  // for a divergence either: the checkout spelling is still a dirty tree.
  const dirtyNoAdvice =
    'error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nAborting';
  const noAdvice = toErrorBody(
    new GitError({ code: 'GIT_FAILED', message: 'failed', exitCode: 128, stderr: dirtyNoAdvice }),
    'en',
  );
  assert.equal(noAdvice.code, 'DIRTY_TREE', 'the checkout spelling stays a dirty tree');
})

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
  ui: { zoom: 1, branchFilter: '', checklistDismissed: false },
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
  calls: {
    showLogs: number;
    openExplorer: number;
    revealCommit: string[];
    openDiff: OpenDiffPayload[];
    openStashDiff: OpenStashDiffHostPayload[];
    external: string[];
  };
}

function harness(repo: RepositoryService | null, overrides: Partial<BridgeHost> = {}): Harness {
  const webview = new FakeWebview();
  const calls = {
    showLogs: 0,
    openExplorer: 0,
    revealCommit: [] as string[],
    openDiff: [] as OpenDiffPayload[],
    openStashDiff: [] as OpenStashDiffHostPayload[],
    external: [] as string[],
  };
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
    openStashDiff: (payload) => {
      calls.openStashDiff.push(payload);
      return Promise.resolve({ opened: true, mode: 'stash' });
    },
    showLogs: () => {
      calls.showLogs += 1;
    },
    openExplorer: () => {
      calls.openExplorer += 1;
    },
    revealCommit: (hash) => {
      calls.revealCommit.push(hash);
      return Promise.resolve(true);
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

test('discard-file needs confirm plus forceAcknowledgement, enforced host-side', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const hId = harness(repo, { settings: () => ({ ...SETTINGS, language: 'id' }) });
  t.after(() => hId.bridge.dispose());

  // No flags: blocked, level 2, high risk
  const bareId = await hId.webview.send(
    req('actions/git', { action: 'discard-file', path: 'a.txt', idempotencyKey: 'df1' }),
  );
  assert.equal(bareId.ok, false);
  if (bareId.ok) return;
  assert.equal(bareId.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(bareId.error.confirmationLevel, 2);
  assert.equal(bareId.error.risk, 'high');
  assert.equal(bareId.error.message, 'Membuang perubahan lokal bersifat permanen.');

  const hEn = harness(repo, { settings: () => ({ ...SETTINGS, language: 'en' }) });
  t.after(() => hEn.bridge.dispose());
  const bareEn = await hEn.webview.send(
    req('actions/git', { action: 'discard-file', path: 'a.txt', idempotencyKey: 'df1-en' }),
  );
  assert.equal(bareEn.ok, false);
  if (bareEn.ok) return;
  assert.equal(bareEn.error.message, 'Discarding local changes is permanent.');

  // confirm alone is not enough at level 2
  const half = await hId.webview.send(
    req('actions/git', { action: 'discard-file', path: 'a.txt', confirm: true, idempotencyKey: 'df2' }),
  );
  assert.equal(half.ok, false);
});

test('discard-file restores local file content back to HEAD when confirmed', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const original = (await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n');
  await fs.writeFile(path.join(dir, 'a.txt'), 'modified locally\n', 'utf8');

  const res = await h.webview.send(
    req('actions/git', {
      action: 'discard-file',
      path: 'a.txt',
      confirm: true,
      forceAcknowledgement: true,
      idempotencyKey: 'df-restore',
    }),
  );
  assert.equal(res.ok, true);

  const after = (await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(after, original);

  const status = await repo.status();
  assert.equal(status.changes.some((c) => c.path === 'a.txt' && c.unstaged), false);
});

test('discard-file rejects invalid path with 400 validation error before touching git', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // Traversal path
  const traversal = await h.webview.send(
    req('actions/git', {
      action: 'discard-file',
      path: '../outside.txt',
      confirm: true,
      forceAcknowledgement: true,
      idempotencyKey: 'df-traversal',
    }),
  );
  assert.equal(traversal.ok, false);
  if (traversal.ok) return;
  assert.equal(traversal.error.code, 'VALIDATION_ERROR');

  // Absolute path
  const absolute = await h.webview.send(
    req('actions/git', {
      action: 'discard-file',
      path: '/etc/passwd',
      confirm: true,
      forceAcknowledgement: true,
      idempotencyKey: 'df-abs',
    }),
  );
  assert.equal(absolute.ok, false);
  if (absolute.ok) return;
  assert.equal(absolute.error.code, 'VALIDATION_ERROR');
});

test('discard-file rejects mismatched statusToken with 409', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const res = await h.webview.send(
    req('actions/git', {
      action: 'discard-file',
      path: 'a.txt',
      confirm: true,
      forceAcknowledgement: true,
      statusToken: 'stale-token-12345',
      idempotencyKey: 'df-stale',
    }),
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.error.status, 409);
  assert.equal(res.error.code, 'CONFLICT');
  assert.equal(res.error.message, hostText('en').bridge.staleToken);
});

test('discard-file leaves staged-only changes in index intact', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await fs.writeFile(path.join(dir, 'a.txt'), 'staged content\n', 'utf8');
  await repo.git.stage(['a.txt']);
  const stagedStatus = await repo.status();
  assert.equal(stagedStatus.changes.some((c) => c.path === 'a.txt' && c.staged), true);

  const res = await h.webview.send(
    req('actions/git', {
      action: 'discard-file',
      path: 'a.txt',
      confirm: true,
      forceAcknowledgement: true,
      idempotencyKey: 'df-staged',
    }),
  );
  assert.equal(res.ok, true);

  const afterStatus = await repo.status();
  assert.equal(afterStatus.changes.some((c) => c.path === 'a.txt' && c.staged), true);
});

test('create-branch creates and switches to new branch via bridge', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/git', {
      action: 'create-branch',
      name: 'feature-test',
      startPoint: head,
      idempotencyKey: 'cb1',
    }),
  );
  assert.equal(response.ok, true);
  const status = await repo.status();
  assert.equal(status.branch, 'feature-test');
  assert.equal(status.head, head);
});

test('reset-hard on dirty tree is allowed with level 2 confirmation and cleans tree', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  // make an initial tracked file committed, then modify it to make tree dirty (since reset --hard removes tracked changes, untracked files are ignored by git reset --hard without git clean)
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'tracked initial\n', 'utf8');
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  await git.stage(['tracked.txt']);
  await git.commit('add tracked file');

  await fs.writeFile(path.join(dir, 'tracked.txt'), 'dirty modification\n', 'utf8');
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const head = (await repo.status()).head as string;
  assert.equal((await repo.status()).dirty, true);

  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // Blocked first with CONFIRMATION_REQUIRED level 2 (NOT DIRTY_TREE)
  const bare = await h.webview.send(
    req('actions/git', { action: 'reset-hard', hash: head, idempotencyKey: 'rh-dirty-1' }),
  );
  assert.equal(bare.ok, false);
  if (bare.ok) return;
  assert.equal(bare.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(bare.error.confirmationLevel, 2);
  assert.ok(bare.error.remedies?.includes('confirm'));

  // Retry with full confirmation succeeds and cleans the dirty tree
  const retry = await h.webview.send(
    req('actions/git', {
      action: 'reset-hard',
      hash: head,
      confirm: true,
      forceAcknowledgement: true,
      idempotencyKey: 'rh-dirty-2',
    }),
  );
  assert.equal(retry.ok, true);
  const freshStatus = await repo.status();
  assert.equal(freshStatus.dirty, false);
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

test('repos/contributors returns contributor list and validates empty payload', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('repos/contributors', {}));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const list = response.data as ContributorInfo[];
  assert.equal(list.length, 1);
  assert.equal(list[0]?.name, 'Test User');
  assert.equal(list[0]?.email, 'test@example.com');
  assert.equal(list[0]?.count, 1);

  const invalid = await h.webview.send(req('repos/contributors', { unexpected: true }));
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  assert.equal(invalid.error.code, 'VALIDATION_ERROR');
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

test('actions/openStashDiff validates its payload before reaching the host callback', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  for (const payload of [
    { index: -1, path: 'a.txt' },
    { index: '0' as unknown as number, path: 'a.txt' },
    { index: 1.5, path: 'a.txt' },
    { index: 1000, path: 'a.txt' },
    { index: 0, path: '../escape.txt' },
    { index: 0, path: 'C:\\abs\\path.txt' },
  ]) {
    const response = await h.webview.send(req('actions/openStashDiff', payload));
    assert.equal(response.ok, false, JSON.stringify(payload));
    if (response.ok) return;
    assert.equal(response.error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(h.calls.openStashDiff, [], 'no invalid payload reached the host');
});

test('actions/openStashDiff reports UNAVAILABLE when the host cannot open editors', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo, { openStashDiff: undefined });
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('actions/openStashDiff', { index: 0, path: 'a.txt' }));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 503);
  assert.equal(response.error.code, 'UNAVAILABLE');
});

test('actions/openStashDiff forwards valid payload with resolved refs to the host callback', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // Non-existent stash index returns NOT_FOUND
  const notFound = await h.webview.send(req('actions/openStashDiff', { index: 0, path: 'a.txt' }));
  assert.equal(notFound.ok, false);
  if (notFound.ok) return;
  assert.equal(notFound.error.code, 'NOT_FOUND');

  // Create a stash entry
  await fs.writeFile(path.join(dir, 'stashed.txt'), 'stash line\n', 'utf8');
  await repo.git.stashPush('test stash diff', { includeUntracked: true });

  const hashes = await repo.git.stashHashes(0);
  assert.ok(hashes !== null);

  const ok = await h.webview.send(req('actions/openStashDiff', { index: 0, path: 'stashed.txt' }));
  assert.equal(ok.ok, true);
  assert.equal(h.calls.openStashDiff.length, 1);
  assert.equal(h.calls.openStashDiff[0]?.index, 0);
  assert.equal(h.calls.openStashDiff[0]?.path, 'stashed.txt');
  assert.equal(h.calls.openStashDiff[0]?.stashHash, hashes.stashHash);
  assert.equal(h.calls.openStashDiff[0]?.parentHash, hashes.parentHash);
});

test('openStashDiff host edge cases: handles missing sides and read failures gracefully', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });

  // Commit tracked file
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'version 1\n', 'utf8');
  await repo.git.stage(['tracked.txt']);
  await repo.git.commit('add tracked');

  // Stash: modified tracked file and new untracked file
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'version 2\n', 'utf8');
  await fs.writeFile(path.join(dir, 'newfile.txt'), 'new content\n', 'utf8');
  await repo.git.stashPush('stash with untracked', { includeUntracked: true });

  const hashes = await repo.git.stashHashes(0);
  assert.ok(hashes !== null);

  // Case 1: Untracked / new file absent in parent -> left is empty, right is found
  let leftAbsent = false;
  try {
    await repo.git.showFile(hashes.parentHash, 'newfile.txt');
  } catch {
    leftAbsent = true;
  }
  assert.equal(leftAbsent, true, 'new file should not exist in parent');

  // Right side exists in stash untracked commit
  assert.ok(hashes.untrackedHash !== undefined);
  const untrackedContent = await repo.git.showFile(hashes.untrackedHash, 'newfile.txt');
  assert.equal(untrackedContent, 'new content\n');

  // Case 2: File absent in stash commit -> right is empty
  let rightAbsent = false;
  try {
    await repo.git.showFile(hashes.stashHash, 'nonexistent.txt');
  } catch {
    rightAbsent = true;
  }
  assert.equal(rightAbsent, true, 'nonexistent file should not exist in stash');
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

test('actions/openQuickActions opens the palette and rejects any payload', async (t) => {
  let opened = 0;
  const h = harness(null, {
    openQuickActions: () => {
      opened += 1;
    },
  });
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('actions/openQuickActions', {}));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(response.data, { opened: true });
  assert.equal(opened, 1);

  // Empty by contract: a non-empty payload is refused before the host is touched,
  // so the kind can never grow into a command channel.
  const rejected = await h.webview.send(req('actions/openQuickActions', { command: 'workbench.action.terminal.new' }));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'VALIDATION_ERROR');
  assert.equal(opened, 1);

  // A host without the callback degrades to `opened: false`, not an error.
  const absent = harness(null);
  t.after(() => absent.bridge.dispose());
  const missing = await absent.webview.send(req('actions/openQuickActions', {}));
  assert.equal(missing.ok, true);
  if (missing.ok) assert.deepEqual(missing.data, { opened: false });
});

test('graph/revealCommit validates hash and dispatches to host.revealCommit', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());

  // Valid 40-character hex hash
  const hash = 'a'.repeat(40);
  const response = await h.webview.send(req('graph/revealCommit', { hash }));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(response.data, { revealed: true });
  assert.deepEqual(h.calls.revealCommit, [hash]);

  // Valid 7-character short hash
  const shortH = 'b'.repeat(7);
  const shortResp = await h.webview.send(req('graph/revealCommit', { hash: shortH }));
  assert.equal(shortResp.ok, true);
  assert.equal(h.calls.revealCommit.length, 2);

  // Rejects invalid hashes: command injection, too short, too long, non-hex
  for (const bad of ['--force', 'abc', 'x'.repeat(40), '123456', '']) {
    const errResp = await h.webview.send(req('graph/revealCommit', { hash: bad }));
    assert.equal(errResp.ok, false);
    if (errResp.ok) return;
    assert.equal(errResp.error.code, 'VALIDATION_ERROR');
    assert.equal(errResp.error.detail, 'hash');
  }
});

test('graph/revealCommit returns revealed false when host handler returns false or is absent', async (t) => {
  const hAbsent = harness(null, { revealCommit: undefined });
  t.after(() => hAbsent.bridge.dispose());
  const r1 = await hAbsent.webview.send(req('graph/revealCommit', { hash: 'c'.repeat(40) }));
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  assert.deepEqual(r1.data, { revealed: false });

  const hFalse = harness(null, { revealCommit: () => false });
  t.after(() => hFalse.bridge.dispose());
  const r2 = await hFalse.webview.send(req('graph/revealCommit', { hash: 'd'.repeat(40) }));
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.deepEqual(r2.data, { revealed: false });
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
    githubIssues: () =>
      Promise.resolve({
        issues: [],
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      }),
    githubCommitAuthors: () =>
      Promise.resolve({
        authors: [{ hash: 'a'.repeat(40), login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/1' }],
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      }),
    githubContributorIdentity: () =>
      Promise.resolve({
        login: 'octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1?s=64',
        htmlUrl: 'https://github.com/octocat',
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

  const issues = await withHost.webview.send(
    req('github/issues', { owner: 'o', repo: 'r', filter: 'assigned', state: 'open' }),
  );
  assert.equal(issues.ok, true);

  const badIssues = await withHost.webview.send(
    req('github/issues', { owner: 'o', repo: 'r', filter: 'invalid-filter' }),
  );
  assert.equal(badIssues.ok, false);
  if (!badIssues.ok) assert.equal(badIssues.error.code, 'VALIDATION_ERROR');

  const badIssuesState = await withHost.webview.send(
    req('github/issues', { owner: 'o', repo: 'r', filter: 'assigned', state: 'invalid-state' }),
  );
  assert.equal(badIssuesState.ok, false);
  if (!badIssuesState.ok) assert.equal(badIssuesState.error.code, 'VALIDATION_ERROR');

  const authors = await withHost.webview.send(
    req('github/commitAuthors', { owner: 'o', repo: 'r', hashes: ['a'.repeat(40)] }),
  );
  assert.equal(authors.ok, true);

  const badAuthors = await withHost.webview.send(
    req('github/commitAuthors', { owner: 'o', repo: 'r', hashes: ['not-a-hash'] }),
  );
  assert.equal(badAuthors.ok, false);
  if (!badAuthors.ok) assert.equal(badAuthors.error.code, 'VALIDATION_ERROR');

  const identity = await withHost.webview.send(
    req('github/contributorIdentity', { email: 'octocat@github.com' }),
  );
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  assert.deepEqual(identity.data, {
    login: 'octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?s=64',
    htmlUrl: 'https://github.com/octocat',
  });

  const badIdentity = await withHost.webview.send(
    req('github/contributorIdentity', { email: '' }),
  );
  assert.equal(badIdentity.ok, false);
  if (!badIdentity.ok) assert.equal(badIdentity.error.code, 'VALIDATION_ERROR');

  const oversizedIdentity = await withHost.webview.send(
    req('github/contributorIdentity', { email: 'x'.repeat(255) }),
  );
  assert.equal(oversizedIdentity.ok, false);
  if (!oversizedIdentity.ok) assert.equal(oversizedIdentity.error.code, 'VALIDATION_ERROR');

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

  const stubIdentity = await withoutHost.webview.send(
    req('github/contributorIdentity', { email: 'octocat@github.com' }),
  );
  assert.equal(stubIdentity.ok, false);
  if (stubIdentity.ok) return;
  assert.equal(stubIdentity.error.status, 503);

  const stubIssues = await withoutHost.webview.send(
    req('github/issues', { owner: 'o', repo: 'r', filter: 'assigned' }),
  );
  assert.equal(stubIssues.ok, false);
  if (stubIssues.ok) return;
  assert.equal(stubIssues.error.status, 503);
});

test('github/pullRequests forwards a boolean refresh and rejects any other type', async (t) => {
  const seen: Array<{ refresh?: unknown }> = [];
  const withHost = harness(null, {
    githubPullRequests: (payload) => {
      seen.push(payload);
      return Promise.resolve({
        pullRequests: [],
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      });
    },
  });
  t.after(() => withHost.bridge.dispose());

  const plain = await withHost.webview.send(req('github/pullRequests', { owner: 'o', repo: 'r' }));
  assert.equal(plain.ok, true);
  assert.equal(seen[0]?.refresh, undefined, 'absent stays absent, so the client keeps its default');

  const refreshing = await withHost.webview.send(
    req('github/pullRequests', { owner: 'o', repo: 'r', refresh: true }),
  );
  assert.equal(refreshing.ok, true);
  assert.equal(seen[1]?.refresh, true, 'the flag reaches the host');

  for (const bad of ['true', 1, {}, null]) {
    const response = await withHost.webview.send(
      req('github/pullRequests', { owner: 'o', repo: 'r', refresh: bad }),
    );
    assert.equal(response.ok, false, `refresh: ${JSON.stringify(bad)} must be refused`);
    if (response.ok) return;
    assert.equal(response.error.code, 'VALIDATION_ERROR');
    assert.equal(response.error.detail, 'refresh');
  }
  assert.equal(seen.length, 2, 'a rejected payload never reaches the host');
});

test('persisted zoom is normalized to valid range host-side', async (t) => {
  const store = new MemoryStore();
  // Simulate an out-of-range legacy stored zoom value (e.g. 0.25 when MIN_ZOOM is now 0.35)
  await store.update('gitControl.uiPreferences', { zoom: 0.25, branchFilter: 'main' });

  // Stand-in host mirroring Controller.uiPreferences and setUiPreference
  const readPreferences = () => {
    const stored = store.get<Partial<{ zoom: number; branchFilter: string; checklistDismissed: boolean }>>(
      'gitControl.uiPreferences',
      {},
    );
    const raw = typeof stored.zoom === 'number' ? stored.zoom : 1;
    const clamped = Math.min(4, Math.max(0.35, raw));
    if (stored.zoom !== undefined && stored.zoom !== clamped) {
      void store.update('gitControl.uiPreferences', { ...stored, zoom: clamped });
    }
    return {
      zoom: clamped,
      branchFilter: typeof stored.branchFilter === 'string' ? stored.branchFilter : '',
      checklistDismissed: stored.checklistDismissed === true,
    };
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

test('persisted checklistDismissed is a boolean in workspace state and rejects other types', async (t) => {
  const store = new MemoryStore();

  // Stand-in host mirroring Controller.uiPreferences and setUiPreference (P16).
  const readPreferences = () => {
    const stored = store.get<Partial<{ zoom: number; branchFilter: string; checklistDismissed: boolean }>>(
      'gitControl.uiPreferences',
      {},
    );
    return {
      zoom: typeof stored.zoom === 'number' ? stored.zoom : 1,
      branchFilter: typeof stored.branchFilter === 'string' ? stored.branchFilter : '',
      checklistDismissed: stored.checklistDismissed === true,
    };
  };

  const hostSnapshot = (): SettingsSnapshot => ({ ...SETTINGS, ui: readPreferences() });

  const withHost = harness(null, {
    settings: hostSnapshot,
    setUiPreference: async (payload) => {
      const prefs = readPreferences();
      if (payload.key === 'checklistDismissed' && typeof payload.value === 'boolean') {
        prefs.checklistDismissed = payload.value;
        await store.update('gitControl.uiPreferences', prefs);
      }
      return hostSnapshot();
    },
  });
  t.after(() => withHost.bridge.dispose());

  const initial = await withHost.webview.send(req('settings/get', {}));
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  assert.equal((initial.data as SettingsSnapshot).ui.checklistDismissed, false, 'defaults to not dismissed');

  const setRes = await withHost.webview.send(req('settings/set', { key: 'checklistDismissed', value: true }));
  assert.equal(setRes.ok, true);
  if (!setRes.ok) return;
  assert.equal((setRes.data as SettingsSnapshot).ui.checklistDismissed, true);
  const persisted = store.get<{ checklistDismissed?: unknown }>('gitControl.uiPreferences', {});
  assert.equal(persisted.checklistDismissed, true, 'the value reaches workspace state');

  // A non-boolean is refused before it can be stored.
  const badRes = await withHost.webview.send(req('settings/set', { key: 'checklistDismissed', value: 'yes' }));
  assert.equal(badRes.ok, true, 'settings/set accepts any primitive and the host decides');
  if (!badRes.ok) return;
  assert.equal(
    (badRes.data as SettingsSnapshot).ui.checklistDismissed,
    true,
    'a string leaves the stored boolean alone',
  );
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

  // Induce a merge operation AFTER the outer guard has seen an idle status, by hooking the
  // point where the lock is already held. This is exactly the TOCTOU the finding
  // describes: an external process starting a merge between the check and the mutation.
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
        // Simulate in-progress operation. `precheck` runs after this, inside the
        // lock, and must see the conflict.
        const gitDir = path.join(dir, '.git');
        await fs.writeFile(path.join(gitDir, 'MERGE_HEAD'), `${head}\n`, 'utf8');
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

  // The in-lock re-check saw the merge conflict in progress and refused.
  assert.equal(response.ok, false, 'the in-lock guard must reject an operation started after the outer check');
  if (response.ok) return;
  assert.equal(response.error.code, 'CONFLICT');
  assert.equal(resets, 0, 'git reset never ran');
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

// ------------------------------------------------------------------- SEC-H2

test('stderr progress stream is redacted before crossing to webview (SEC-H2)', () => {
  const h = harness(null);
  const sink = (h.bridge as any).progressSink('op-progress', 'push');
  const token = 'ghp_secret0123456789abcdefgh';
  sink(`Writing objects: 100% (1/1), done.\nremote: https://x-access-token:${token}@github.com/o/r.git`);

  const event = h.webview
    .events()
    .find((e): e is HostEvent<'event/operationProgress'> => e.kind === 'event/operationProgress');
  assert.ok(event !== undefined);
  assert.equal(event.payload.id, 'op-progress');
  assert.equal(event.payload.operation, 'push');
  assert.equal(event.payload.phase, 'progress');
  assert.ok(event.payload.message !== undefined);
  assert.ok(!event.payload.message.includes(token));
  assert.ok(event.payload.message.includes('[redacted]'));
  assert.ok(event.payload.message.includes('Writing objects: 100%'));

  // Also verify ssh credential form in streamed stderr line
  sink('fatal: unable to access ssh://user:secret123@corp.example/repo.git');
  const events = h.webview
    .events()
    .filter((e): e is HostEvent<'event/operationProgress'> => e.kind === 'event/operationProgress');
  const second = events[1];
  assert.ok(second?.payload.message !== undefined);
  assert.ok(!second.payload.message.includes('secret123'));
  assert.ok(second.payload.message.includes('ssh://user:[redacted]@corp.example/repo.git'));
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

test('shouldRemember treats transient remote guard failures as retryable (BUG2)', () => {
  assert.equal(shouldRemember({ ok: false, error: { code: 'REMOTE_AHEAD' } }), false);
  assert.equal(shouldRemember({ ok: false, error: { code: 'NON_FAST_FORWARD' } }), false);
  assert.equal(shouldRemember({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } }), false);
  assert.equal(shouldRemember({ ok: false, error: { code: 'DIRTY_TREE' } }), false);
  assert.equal(shouldRemember({ ok: false, error: { code: 'STALE_STATUS' } }), false);
  assert.equal(shouldRemember({ ok: false, error: { code: 'NOT_FOUND' } }), true);
  assert.equal(shouldRemember({ ok: true, data: { success: true } }), true);
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

test('merge-into performs switch then merge and stays on target branch', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // Create side branch off main with a unique commit
  await repo.git.createBranch('side', 'main');
  await fs.writeFile(path.join(dir, 'side.txt'), 'side content\n', 'utf8');
  await repo.git.stage(['side.txt']);
  const sideCommit = await repo.git.commit('side commit');
  await repo.git.switchBranch('side'); // currently on side branch

  repo.invalidate();
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'merge-into',
      target: 'main',
      source: 'side',
      confirm: true,
      statusToken: token,
      idempotencyKey: 'merge-into-1',
    }),
  );
  assert.equal(response.ok, true);

  // Verify real git repository state
  const current = await repo.git.currentBranch();
  assert.equal(current.branch, 'main');

  // Verify side commit is reachable from main
  assert.ok(sideCommit !== null);
  const logOnMain = await repo.git.run(['log', '--format=%H', '-n', '5', 'main']);
  assert.ok(logOnMain.stdout.includes(sideCommit));
});

test('merge-into with noFf creates a dedicated merge commit', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // Create side branch off main with a unique commit
  await repo.git.createBranch('side', 'main');
  await fs.writeFile(path.join(dir, 'side.txt'), 'side content\n', 'utf8');
  await repo.git.stage(['side.txt']);
  const sideCommit = await repo.git.commit('side commit');
  await repo.git.switchBranch('side'); // currently on side branch

  repo.invalidate();
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'merge-into',
      target: 'main',
      source: 'side',
      noFf: true,
      confirm: true,
      statusToken: token,
      idempotencyKey: 'merge-into-noff-1',
    }),
  );
  assert.equal(response.ok, true);

  // Verify real git repository state
  const current = await repo.git.currentBranch();
  assert.equal(current.branch, 'main');

  // Verify head commit is a merge commit with 2 parents because of --no-ff
  const head = await repo.git.headHash();
  assert.ok(head !== null);
  const meta = await repo.git.commitMeta(head);
  assert.equal(meta?.parents.length, 2, 'must be a merge commit with two parents');
  assert.ok(meta?.parents.includes(sideCommit as string));
});

test('merge-into rejects invalid target with VALIDATION_ERROR before touching git', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const token = (await repo.status()).statusToken;
  const response = await h.webview.send(
    req('actions/git', {
      action: 'merge-into',
      target: 'bad..branch..name',
      source: 'main',
      confirm: true,
      statusToken: token,
      idempotencyKey: 'merge-into-2',
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 400);
  assert.equal(response.error.code, 'VALIDATION_ERROR');
});

test('merge-into on dirty tree is blocked with DIRTY_TREE', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await fs.writeFile(path.join(dir, 'dirty.txt'), 'uncommitted work\n', 'utf8');
  repo.invalidate();
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'merge-into',
      target: 'main',
      source: 'side',
      confirm: true,
      statusToken: token,
      idempotencyKey: 'merge-into-3',
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 412);
  assert.equal(response.error.code, 'DIRTY_TREE');
});

test('pull without confirm is blocked by guard with CONFIRMATION_REQUIRED', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const token = (await repo.status()).statusToken;
  const response = await h.webview.send(
    req('actions/git', {
      action: 'pull',
      statusToken: token,
      idempotencyKey: 'pull-unconfirmed-1',
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 428);
  assert.equal(response.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(response.error.confirmationLevel, 1);
  assert.deepEqual(response.error.remedies, ['confirm', 'cancel']);
});

test('pull with clean tree and confirm succeeds and advances HEAD', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const headBefore = await repo.git.headHash();
  const upstreamHash = await advanceRemote(dir, 'pull-test.txt', 'remote commit content\n');

  const token = (await repo.status()).statusToken;
  const response = await h.webview.send(
    req('actions/git', {
      action: 'pull',
      confirm: true,
      statusToken: token,
      idempotencyKey: 'pull-clean-1',
    }),
  );
  assert.equal(response.ok, true);

  const headAfter = await repo.git.headHash();
  assert.equal(headAfter, upstreamHash);
  assert.notEqual(headBefore, headAfter);
  assert.match(await fs.readFile(path.join(dir, 'pull-test.txt'), 'utf8'), /^remote commit content\r?\n$/);
});

test('pull on dirty tree is blocked with DIRTY_TREE and remedies', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await fs.writeFile(path.join(dir, 'dirty.txt'), 'dirty content\n', 'utf8');
  repo.invalidate();
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'pull',
      confirm: true,
      statusToken: token,
      idempotencyKey: 'pull-dirty-1',
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 412);
  assert.equal(response.error.code, 'DIRTY_TREE');
  assert.deepEqual(response.error.remedies, ['commit', 'stash', 'cancel']);
});

test('cherry-pick succeeds end-to-end on clean tree with confirmation', async (t) => {
  const dir = await makeFixture('triple');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const sideRev = await repo.git.run(['rev-parse', 'side']);
  const sideHash = sideRev.stdout.trim();
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'cherry-pick',
      hash: sideHash,
      confirm: true,
      statusToken: token,
      idempotencyKey: 'bridge-cp-1',
    }),
  );
  assert.equal(response.ok, true);
  const statusAfter = await repo.status();
  assert.equal(statusAfter.operation, 'idle');
  assert.equal(await repo.git.showFile('HEAD', 'side.txt'), 'side\n');
});

test('cherry-pick on dirty tree is rejected with 412 DIRTY_TREE', async (t) => {
  const dir = await makeFixture('triple');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const sideRev = await repo.git.run(['rev-parse', 'side']);
  const sideHash = sideRev.stdout.trim();

  await fs.writeFile(path.join(dir, 'dirty.txt'), 'dirty\n', 'utf8');
  repo.invalidate();
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'cherry-pick',
      hash: sideHash,
      confirm: true,
      statusToken: token,
      idempotencyKey: 'bridge-cp-dirty',
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 412);
  assert.equal(response.error.code, 'DIRTY_TREE');
  assert.deepEqual(response.error.remedies, ['commit', 'stash', 'cancel']);
});

test('cherry-pick conflict produces cherry-pick operation state, continue succeeds, abort restores idle', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await repo.git.createBranch('side', 'main');
  await fs.writeFile(path.join(dir, 'a.txt'), 'side line\n', 'utf8');
  await repo.git.stage(['a.txt']);
  const sideCommit = (await repo.git.commit('side commit')) as string;

  await repo.git.switchBranch('main');
  await fs.writeFile(path.join(dir, 'a.txt'), 'main line\n', 'utf8');
  await repo.git.stage(['a.txt']);
  const mainCommit = (await repo.git.commit('main commit')) as string;

  repo.invalidate();
  let token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'cherry-pick',
      hash: sideCommit,
      confirm: true,
      statusToken: token,
      idempotencyKey: 'bridge-cp-conflict',
    }),
  );
  assert.equal(response.ok, false);

  repo.invalidate();
  let status = await repo.status();
  assert.equal(status.operation, 'cherry-pick');
  assert.ok(status.conflicts.length > 0);

  const abortRes = await h.webview.send(
    req('actions/git', {
      action: 'cherry-pick-abort',
      idempotencyKey: 'bridge-cp-abort',
    }),
  );
  assert.equal(abortRes.ok, true);
  repo.invalidate();
  status = await repo.status();
  assert.equal(status.operation, 'idle');
  assert.equal(status.head, mainCommit);

  token = status.statusToken;
  await h.webview.send(
    req('actions/git', {
      action: 'cherry-pick',
      hash: sideCommit,
      confirm: true,
      statusToken: token,
      idempotencyKey: 'bridge-cp-conflict-2',
    }),
  );

  repo.invalidate();
  status = await repo.status();
  assert.equal(status.operation, 'cherry-pick');

  await fs.writeFile(path.join(dir, 'a.txt'), 'resolved line\n', 'utf8');
  token = status.statusToken;
  const stageRes = await h.webview.send(
    req('actions/stage', {
      paths: ['a.txt'],
      stage: true,
      statusToken: token,
      idempotencyKey: 'bridge-cp-stage',
    }),
  );
  assert.equal(stageRes.ok, true);

  repo.invalidate();
  status = await repo.status();
  assert.equal(status.conflicts.length, 0);

  const continueRes = await h.webview.send(
    req('actions/git', {
      action: 'cherry-pick-continue',
      idempotencyKey: 'bridge-cp-continue',
    }),
  );
  assert.equal(continueRes.ok, true);

  repo.invalidate();
  status = await repo.status();
  assert.equal(status.operation, 'idle');
  assert.equal(await repo.git.showFile('HEAD', 'a.txt'), 'resolved line\n');
});

test('cherry-pick rejects stale token with 409', async (t) => {
  const dir = await makeFixture('triple');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const sideRev = await repo.git.run(['rev-parse', 'side']);
  const sideHash = sideRev.stdout.trim();

  const response = await h.webview.send(
    req('actions/git', {
      action: 'cherry-pick',
      hash: sideHash,
      confirm: true,
      statusToken: 'definitely-stale-token',
      idempotencyKey: 'bridge-cp-stale',
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 409);
  assert.equal(response.error.code, 'CONFLICT');
});

test('cherry-pick rejects invalid hash with 400 VALIDATION_ERROR', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/git', {
      action: 'cherry-pick',
      hash: 'not-a-valid-hash',
      confirm: true,
      idempotencyKey: 'bridge-cp-invalid',
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 400);
  assert.equal(response.error.code, 'VALIDATION_ERROR');
});

test('actions/git: revert on a merge commit auto-detects merge and succeeds with -m 1', async (t) => {
  const dir = await makeFixture('triple');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // Create a merge commit on main by merging side with --no-ff
  await repo.git.merge('side', { noFf: true });
  repo.invalidate();
  const mergeHead = (await repo.git.headHash()) as string;

  const token = (await repo.status()).statusToken;
  const response = await h.webview.send(
    req('actions/git', {
      action: 'revert',
      hash: mergeHead,
      confirm: true,
      statusToken: token,
      idempotencyKey: 'revert-merge-1',
    }),
  );

  assert.equal(response.ok, true);
  const newHead = (await repo.git.headHash()) as string;
  assert.notEqual(newHead, mergeHead);

  const meta = await repo.git.commitMeta(newHead);
  assert.match(meta?.subject ?? '', /^Revert/);

  // side.txt merged from side branch should be removed by the revert
  const status = await repo.git.status();
  assert.equal(status.length, 0, 'working tree should be clean');
  const sideExists = await fs.access(path.join(dir, 'side.txt')).then(() => true, () => false);
  assert.equal(sideExists, false, 'reverted side.txt should not exist');
});

test('actions/git: revert on a regular non-merge commit succeeds without mainline flag', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await fs.writeFile(path.join(dir, 'regular.txt'), 'regular\n', 'utf8');
  await repo.git.stage(['regular.txt']);
  const regularCommit = (await repo.git.commit('add regular')) as string;

  repo.invalidate();
  const token = (await repo.status()).statusToken;
  const response = await h.webview.send(
    req('actions/git', {
      action: 'revert',
      hash: regularCommit,
      confirm: true,
      statusToken: token,
      idempotencyKey: 'revert-regular-1',
    }),
  );

  assert.equal(response.ok, true);
  const newHead = (await repo.git.headHash()) as string;
  assert.notEqual(newHead, regularCommit);

  const regularExists = await fs.access(path.join(dir, 'regular.txt')).then(() => true, () => false);
  assert.equal(regularExists, false, 'reverted regular.txt should not exist');
});

test('actions/git: revert rejects invalid hash with 400 VALIDATION_ERROR', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const token = (await repo.status()).statusToken;
  const response = await h.webview.send(
    req('actions/git', {
      action: 'revert',
      hash: 'invalid-hash!',
      confirm: true,
      statusToken: token,
      idempotencyKey: 'revert-bad-hash',
    }),
  );

  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 400);
  assert.equal(response.error.code, 'VALIDATION_ERROR');
});

test('pull rejects invalid remote or branch names before touching git', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const token = (await repo.status()).statusToken;
  const badRemoteResponse = await h.webview.send(
    req('actions/git', {
      action: 'pull',
      remote: '-bad-remote',
      confirm: true,
      statusToken: token,
      idempotencyKey: 'pull-invalid-1',
    }),
  );
  assert.equal(badRemoteResponse.ok, false);
  if (!badRemoteResponse.ok) {
    assert.equal(badRemoteResponse.error.status, 400);
    assert.equal(badRemoteResponse.error.code, 'VALIDATION_ERROR');
  }

  const badBranchResponse = await h.webview.send(
    req('actions/git', {
      action: 'pull',
      branch: '-bad-branch',
      confirm: true,
      statusToken: token,
      idempotencyKey: 'pull-invalid-2',
    }),
  );
  assert.equal(badBranchResponse.ok, false);
  if (!badBranchResponse.ok) {
    assert.equal(badBranchResponse.error.status, 400);
    assert.equal(badBranchResponse.error.code, 'VALIDATION_ERROR');
  }
});

test('stash/list returns stash entries DTO', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // Initially empty
  const emptyRes = await h.webview.send(req('stash/list', {}));
  assert.equal(emptyRes.ok, true);
  if (!emptyRes.ok) return;
  assert.deepEqual(emptyRes.data, []);

  // Create a stash entry
  await fs.writeFile(path.join(dir, 'test.txt'), 'stash me\n', 'utf8');
  await repo.git.stashPush('bridge stash', { includeUntracked: true });

  const res = await h.webview.send(req('stash/list', {}));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const list = res.data as { ref: string; hash: string; subject: string }[];
  assert.equal(list.length, 1);
  assert.equal(list[0]?.ref, 'stash@{0}');
  assert.ok(list[0]?.hash.length >= 7);
  assert.ok(list[0]?.subject.includes('bridge stash'));

  // Test stash/show on valid index
  const showRes = await h.webview.send(req('stash/show', { index: 0 }));
  assert.equal(showRes.ok, true);
  if (!showRes.ok) return;
  const files = showRes.data as { path: string; additions: number | null; deletions: number | null }[];
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, 'test.txt');
  assert.equal(files[0]?.additions, 1);
  assert.equal(files[0]?.deletions, 0);

  // Test stash/show on invalid index
  const invalidRes = await h.webview.send(req('stash/show', { index: -1 }));
  assert.equal(invalidRes.ok, false);
  if (!invalidRes.ok) {
    assert.equal(invalidRes.error.code, 'VALIDATION_ERROR');
    assert.equal(invalidRes.error.status, 400);
    assert.equal(invalidRes.error.detail, 'index');
  }

  const badTypeRes = await h.webview.send(req('stash/show', { index: 'zero' as unknown as number }));
  assert.equal(badTypeRes.ok, false);
  if (!badTypeRes.ok) {
    assert.equal(badTypeRes.error.code, 'VALIDATION_ERROR');
    assert.equal(badTypeRes.error.status, 400);
    assert.equal(badTypeRes.error.detail, 'index');
  }
});

test('stash-apply requires confirmation, is blocked on dirty tree, and rejects stale token or invalid index', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await fs.writeFile(path.join(dir, 'stashfile.txt'), 'stash content\n', 'utf8');
  await repo.git.stashPush('stash test', { includeUntracked: true });
  repo.invalidate();
  const token = (await repo.status()).statusToken;

  // Rejects invalid index with 400 VALIDATION_ERROR
  const invalidRes = await h.webview.send(
    req('actions/git', { action: 'stash-apply', index: -1, statusToken: token }),
  );
  assert.equal(invalidRes.ok, false);
  if (!invalidRes.ok) {
    assert.equal(invalidRes.error.status, 400);
    assert.equal(invalidRes.error.code, 'VALIDATION_ERROR');
  }

  // Rejects stale statusToken with 409
  const staleRes = await h.webview.send(
    req('actions/git', { action: 'stash-apply', index: 0, statusToken: 'stale-token-123' }),
  );
  assert.equal(staleRes.ok, false);
  if (!staleRes.ok) {
    assert.equal(staleRes.error.status, 409);
    assert.equal(staleRes.error.code, 'CONFLICT');
  }

  // Without confirm: blocked with 428 CONFIRMATION_REQUIRED
  const unconfirmed = await h.webview.send(
    req('actions/git', { action: 'stash-apply', index: 0, statusToken: token }),
  );
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) {
    assert.equal(unconfirmed.error.status, 428);
    assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED');
  }

  // When dirty: blocked with 412 DIRTY_TREE
  await fs.writeFile(path.join(dir, 'dirty.txt'), 'dirty tree\n', 'utf8');
  repo.invalidate();
  const dirtyToken = (await repo.status()).statusToken;
  const dirtyRes = await h.webview.send(
    req('actions/git', { action: 'stash-apply', index: 0, confirm: true, statusToken: dirtyToken }),
  );
  assert.equal(dirtyRes.ok, false);
  if (!dirtyRes.ok) {
    assert.equal(dirtyRes.error.status, 412);
    assert.equal(dirtyRes.error.code, 'DIRTY_TREE');
  }

  // Clean tree: succeeds with confirm: true
  await fs.rm(path.join(dir, 'dirty.txt'), { force: true });
  repo.invalidate();
  const cleanToken = (await repo.status()).statusToken;
  const successRes = await h.webview.send(
    req('actions/git', { action: 'stash-apply', index: 0, confirm: true, statusToken: cleanToken }),
  );
  assert.equal(successRes.ok, true);

  // Stash entry still exists in stash list after apply
  const afterList = await repo.stashList();
  assert.equal(afterList.length, 1);
});

test('stash-drop requires level 2 confirmation with forceAcknowledgement and deletes entry', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await fs.writeFile(path.join(dir, 'dropme.txt'), 'drop content\n', 'utf8');
  await repo.git.stashPush('to drop', { includeUntracked: true });
  repo.invalidate();
  const token = (await repo.status()).statusToken;

  // Rejects invalid index with 400
  const invalidRes = await h.webview.send(
    req('actions/git', { action: 'stash-drop', index: 'zero' as unknown as number, statusToken: token }),
  );
  assert.equal(invalidRes.ok, false);
  if (!invalidRes.ok) {
    assert.equal(invalidRes.error.status, 400);
    assert.equal(invalidRes.error.code, 'VALIDATION_ERROR');
  }

  // confirm: true alone is NOT sufficient for level 2 (requires forceAcknowledgement)
  const partialConfirm = await h.webview.send(
    req('actions/git', { action: 'stash-drop', index: 0, confirm: true, statusToken: token }),
  );
  assert.equal(partialConfirm.ok, false);
  if (!partialConfirm.ok) {
    assert.equal(partialConfirm.error.status, 428);
    assert.equal(partialConfirm.error.code, 'CONFIRMATION_REQUIRED');
  }

  // confirm: true AND forceAcknowledgement: true succeeds even on dirty tree
  await fs.writeFile(path.join(dir, 'unrelated.txt'), 'unrelated work\n', 'utf8');
  repo.invalidate();
  const dirtyToken = (await repo.status()).statusToken;
  const dropRes = await h.webview.send(
    req('actions/git', {
      action: 'stash-drop',
      index: 0,
      confirm: true,
      forceAcknowledgement: true,
      statusToken: dirtyToken,
    }),
  );
  assert.equal(dropRes.ok, true);

  // Stash list is now empty
  const afterDrop = await repo.stashList();
  assert.deepEqual(afterDrop, []);
});

test('ui/takePendingRoute returns the host value and is null when the host has none', async (t) => {
  const queued = { id: 'branches', sub: 'tags' } as const;
  const withRoute = harness(null, { takePendingRoute: () => ({ route: queued }) });
  t.after(() => withRoute.bridge.dispose());
  const found = await withRoute.webview.send(req('ui/takePendingRoute', {}));
  assert.equal(found.ok, true);
  if (found.ok) assert.deepEqual(found.data, { route: queued });

  const empty = harness(null, { takePendingRoute: () => null });
  t.after(() => empty.bridge.dispose());
  const none = await empty.webview.send(req('ui/takePendingRoute', {}));
  assert.equal(none.ok, true);
  if (none.ok) assert.deepEqual(none.data, { route: null });

  // A host without the callback degrades to "nothing queued", not an error.
  const absent = harness(null);
  t.after(() => absent.bridge.dispose());
  const missing = await absent.webview.send(req('ui/takePendingRoute', {}));
  assert.equal(missing.ok, true);
  if (missing.ok) assert.deepEqual(missing.data, { route: null });
});

test('ui/takePendingRoute rejects a non-empty payload without touching the host', async (t) => {
  let calls = 0;
  const h = harness(null, {
    takePendingRoute: () => {
      calls += 1;
      return null;
    },
  });
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('ui/takePendingRoute', { route: { id: 'prs' } }));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'VALIDATION_ERROR');
  assert.equal(response.error.status, 400);
  assert.equal(calls, 0);
});

test('amend of a published HEAD is refused with 409 before git runs', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  let commits = 0;
  const realCommit = repo.git.commit.bind(repo.git);
  repo.git.commit = async (message: string, opts?: { amend?: boolean }): Promise<string | null> => {
    commits += 1;
    return realCommit(message, opts);
  };

  const before = await repo.git.headHash();
  const token = (await repo.status()).statusToken;

  for (const [lang, h2] of [['en', h], ['id', harness(repo, { settings: () => ({ ...SETTINGS, language: 'id' }) })]] as const) {
    if (lang === 'id') t.after(() => h2.bridge.dispose());
    const response = await h2.webview.send(
      req('actions/commit', { message: 'reword', amend: true, statusToken: token, idempotencyKey: `pub-${lang}` }),
    );
    assert.equal(response.ok, false, lang);
    if (response.ok) return;
    assert.equal(response.error.status, 409, lang);
    assert.equal(response.error.code, 'NON_FAST_FORWARD', lang);
    assert.equal(response.error.message, hostText(lang).guard.amendPublished, lang);
    assert.deepEqual(response.error.remedies, ['cancel'], lang);
  }

  assert.equal(commits, 0, 'git commit never ran');
  assert.equal(await repo.git.headHash(), before, 'HEAD is untouched');
});

test('amend of an unpublished HEAD rewrites it and leaves the count alone', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await fs.writeFile(path.join(dir, 'b.txt'), 'two\n', 'utf8');
  await repo.git.stage(['b.txt']);
  const local = await repo.git.commit('local only');
  repo.invalidate();
  const before = await repo.git.log({ limit: 100, all: false });
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/commit', {
      message: 'local only, reworded',
      amend: true,
      statusToken: token,
      idempotencyKey: 'unpub-1',
    }),
  );
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const data = response.data as { success: boolean; commit: string | null; pushed: boolean };
  assert.equal(data.success, true);
  assert.ok(data.commit !== null && data.commit !== local, 'the tip hash changed');

  const after = await repo.git.log({ limit: 100, all: false });
  assert.equal(after.length, before.length, 'the history length is unchanged');
  assert.equal(after[0]?.subject, 'local only, reworded');
});

test('a non-boolean amend is rejected with 400 before git runs', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  let commits = 0;
  const realCommit = repo.git.commit.bind(repo.git);
  repo.git.commit = async (message: string, opts?: { amend?: boolean }): Promise<string | null> => {
    commits += 1;
    return realCommit(message, opts);
  };

  // `'yes'` is truthy but not `true`, and the runner tests `opts.amend === true`.
  // Without this check it would silently become a plain commit.
  for (const amend of ['yes', 1, {}] as unknown[]) {
    const response = await h.webview.send(
      req('actions/commit', { message: 'reword', amend, statusToken: '', idempotencyKey: `bad-${String(amend)}` }),
    );
    assert.equal(response.ok, false, JSON.stringify(amend));
    if (response.ok) return;
    assert.equal(response.error.status, 400);
    assert.equal(response.error.code, 'VALIDATION_ERROR');
    assert.equal(response.error.detail, 'amend');
  }
  assert.equal(commits, 0);
});

test('amend with push on an unpublished commit fast-forwards the upstream', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  await repo.markFetched(Date.now());
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await fs.writeFile(path.join(dir, 'b.txt'), 'two\n', 'utf8');
  await repo.git.stage(['b.txt']);
  await repo.git.commit('local only');
  repo.invalidate();
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/commit', {
      message: 'local only, reworded',
      amend: true,
      push: true,
      statusToken: token,
      idempotencyKey: 'amend-push-1',
    }),
  );
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const data = response.data as { success: boolean; commit: string | null; pushed: boolean };
  assert.equal(data.success, true);
  assert.equal(data.pushed, true, 'a local-only amend pushes as a fast-forward, no force needed');

  const upstream = await repo.git.run(['rev-parse', 'origin/main']);
  assert.equal(upstream.stdout.trim(), data.commit, 'origin/main now points at the amended commit');
});

test('amend is refused when the upstream is configured but its tracking ref is missing', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // `git remote prune`, a branch deleted upstream, or a narrowed refspec leave
  // `branch.<name>.remote` in place while the remote-tracking ref is gone.
  // `@{upstream}` then fails to resolve, which used to read as "no upstream"
  // and let the amend through against a commit the remote still has.
  const published = await repo.git.headHash();
  assert.ok(published !== null);
  await repo.git.run(['update-ref', '-d', 'refs/remotes/origin/main']);
  repo.invalidate();
  const status = await repo.status();
  assert.equal(status.upstream, null, 'the fixture reproduces the collapsed null');

  let commits = 0;
  const realCommit = repo.git.commit.bind(repo.git);
  repo.git.commit = async (message: string, opts?: { amend?: boolean }): Promise<string | null> => {
    commits += 1;
    return realCommit(message, opts);
  };

  const response = await h.webview.send(
    req('actions/commit', {
      message: 'reword',
      amend: true,
      statusToken: status.statusToken,
      idempotencyKey: 'gone-upstream',
    }),
  );
  assert.equal(response.ok, false, 'a configured upstream with no tracking ref must fail closed');
  if (response.ok) return;
  assert.equal(response.error.code, 'NON_FAST_FORWARD');
  assert.equal(commits, 0, 'git commit never ran');
  assert.equal(await repo.git.headHash(), published, 'HEAD is untouched');
});

test('amend is refused in a detached HEAD sitting on a published commit', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // `checkout-commit` from the graph context menu is a first-class route into
  // this state. A detached HEAD has no branch, so `upstream` is null, but the
  // commit it points at can still be on a remote ref.
  const published = await repo.git.headHash();
  assert.ok(published !== null);
  await repo.git.checkoutDetached(published);
  repo.invalidate();
  const status = await repo.status();
  assert.equal(status.branch, null);
  assert.equal(status.detached, true);
  assert.equal(status.upstream, null);

  let commits = 0;
  const realCommit = repo.git.commit.bind(repo.git);
  repo.git.commit = async (message: string, opts?: { amend?: boolean }): Promise<string | null> => {
    commits += 1;
    return realCommit(message, opts);
  };

  const response = await h.webview.send(
    req('actions/commit', {
      message: 'reword',
      amend: true,
      statusToken: status.statusToken,
      idempotencyKey: 'detached-amend',
    }),
  );
  assert.equal(response.ok, false, 'rewriting a published commit while detached must be refused');
  if (response.ok) return;
  assert.equal(response.error.code, 'NON_FAST_FORWARD');
  assert.equal(commits, 0, 'git commit never ran');
  assert.equal(await repo.git.headHash(), published);
});

test('amend in a detached HEAD on a local-only commit is still allowed', async (t) => {
  const dir = await makeFixture('remote');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await fs.writeFile(path.join(dir, 'b.txt'), 'two\n', 'utf8');
  await repo.git.stage(['b.txt']);
  const local = await repo.git.commit('local only');
  assert.ok(local !== null);
  await repo.git.checkoutDetached(local);
  repo.invalidate();
  const status = await repo.status();
  assert.equal(status.detached, true);

  const response = await h.webview.send(
    req('actions/commit', {
      message: 'local only, reworded',
      amend: true,
      statusToken: status.statusToken,
      idempotencyKey: 'detached-local',
    }),
  );
  assert.equal(response.ok, true, 'nothing on a remote ref means the rewrite is local');
  if (!response.ok) return;
  const data = response.data as { commit: string | null };
  assert.notEqual(data.commit, local);
});

test('repos/refs flags merged and gone, drops pseudo-refs, and rejects a payload', async (t) => {
  const dir = await makeFixture('branches');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('repos/refs', {}));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const result = response.data as {
    refs: Array<{ refName: string; shortName: string; kind: string; gone: boolean; merged: boolean }>;
    head: string | null;
    currentBranch: string | null;
    base: string | null;
  };

  assert.equal(result.base, 'main');
  assert.equal(result.currentBranch, 'main');
  assert.equal(typeof result.head, 'string');

  // Exactly one merged branch, and it is not the base nor HEAD.
  assert.deepEqual(result.refs.filter((r) => r.merged).map((r) => r.shortName), ['merged-local']);
  assert.deepEqual(result.refs.filter((r) => r.gone).map((r) => r.shortName), ['gone-upstream']);

  // No pseudo-ref and no symbolic remote head can be offered as a target.
  assert.deepEqual(result.refs.filter((r) => r.kind === 'other'), []);
  assert.deepEqual(result.refs.filter((r) => r.refName.endsWith('/HEAD')), []);
  assert.ok(result.refs.some((r) => r.kind === 'remote'));
  assert.ok(result.refs.some((r) => r.kind === 'tag'));

  const invalid = await h.webview.send(req('repos/refs', { unexpected: true }));
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  assert.equal(invalid.error.code, 'VALIDATION_ERROR');
});

test('repos/worktrees lists the repository and rejects a payload', async (t) => {
  const dir = await makeFixture('single');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('repos/worktrees', {}));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const result = response.data as {
    worktrees: Array<{ path: string; branch: string | null; isCurrent: boolean; bare: boolean }>;
  };
  assert.equal(result.worktrees.length, 1);
  assert.equal(result.worktrees[0]?.branch, 'main');
  assert.equal(result.worktrees[0]?.isCurrent, true);
  assert.equal(result.worktrees[0]?.bare, false);

  const invalid = await h.webview.send(req('repos/worktrees', { unexpected: true }));
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;
  assert.equal(invalid.error.code, 'VALIDATION_ERROR');
});

test('repos/refs and repos/worktrees never take the mutation idempotency path', () => {
  for (const kind of ['repos/refs', 'repos/worktrees']) {
    const request = { id: 'x', kind, payload: { idempotencyKey: 'k' } } as unknown as Request;
    assert.equal(idempotencyKeyOf(request), null, kind);
  }
});

// ------------------------------------------------------ actions handlers (P13)

test('github/actionsRuns and github/actionsJobs reach the host unchanged', async (t) => {
  const runsSeen: ActionsRunsPayload[] = [];
  const jobsSeen: ActionsJobsPayload[] = [];
  const h = harness(null, {
    githubActionsRuns: (payload) => {
      runsSeen.push(payload);
      return Promise.resolve({
        runs: [],
        workflows: [],
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      });
    },
    githubActionsJobs: (payload) => {
      jobsSeen.push(payload);
      return Promise.resolve({
        jobs: [],
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      });
    },
  });
  t.after(() => h.bridge.dispose());

  const runs = await h.webview.send(
    req('github/actionsRuns', { owner: 'o', repo: 'r', branch: 'main', perPage: 10 }),
  );
  assert.equal(runs.ok, true);
  assert.deepEqual(runsSeen, [{ owner: 'o', repo: 'r', branch: 'main', perPage: 10 }]);

  const jobs = await h.webview.send(req('github/actionsJobs', { owner: 'o', repo: 'r', runId: 482 }));
  assert.equal(jobs.ok, true);
  assert.deepEqual(jobsSeen, [{ owner: 'o', repo: 'r', runId: 482 }]);
});

test('a bad actions payload never reaches the host function', async (t) => {
  let calls = 0;
  const h = harness(null, {
    githubActionsRuns: () => {
      calls += 1;
      return Promise.resolve({
        runs: [],
        workflows: [],
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      });
    },
    githubActionsJobs: () => {
      calls += 1;
      return Promise.resolve({
        jobs: [],
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      });
    },
  });
  t.after(() => h.bridge.dispose());

  const badRuns: Array<Record<string, unknown>> = [
    { owner: 'o wner', repo: 'r' },
    { owner: 'o', repo: 'r', branch: '-flag' },
    { owner: 'o', repo: 'r', branch: 'a..b' },
    { owner: 'o', repo: 'r', workflowId: 0 },
    { owner: 'o', repo: 'r', workflowId: 1.5 },
    { owner: 'o', repo: 'r', perPage: 0 },
    { owner: 'o', repo: 'r', perPage: 51 },
  ];
  for (const payload of badRuns) {
    const reply = await h.webview.send(req('github/actionsRuns', payload));
    assert.equal(reply.ok, false, JSON.stringify(payload));
    if (!reply.ok) assert.equal(reply.error.code, 'VALIDATION_ERROR');
  }

  for (const runId of [0, -1, 1.5, '482']) {
    const reply = await h.webview.send(req('github/actionsJobs', { owner: 'o', repo: 'r', runId }));
    assert.equal(reply.ok, false, String(runId));
    if (!reply.ok) assert.equal(reply.error.code, 'VALIDATION_ERROR');
  }

  assert.equal(calls, 0, 'validation happens before the host call');
});

test('the actions handlers answer UNAVAILABLE when the host lacks them', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());
  const runs = await h.webview.send(req('github/actionsRuns', { owner: 'o', repo: 'r' }));
  assert.equal(runs.ok, false);
  if (!runs.ok) assert.equal(runs.error.code, 'UNAVAILABLE');
  const jobs = await h.webview.send(req('github/actionsJobs', { owner: 'o', repo: 'r', runId: 1 }));
  assert.equal(jobs.ok, false);
  if (!jobs.ok) assert.equal(jobs.error.code, 'UNAVAILABLE');
});

// ------------------------------------------------- actions log handler (P14)

test('github/actionsLog reaches the host unchanged', async (t) => {
  const seen: Array<{ owner: string; repo: string; jobId: number }> = [];
  const h = harness(null, {
    githubActionsLog: (payload) => {
      seen.push(payload);
      return Promise.resolve({
        state: 'ok',
        lines: [{ text: 'hello', tone: 'normal' }],
        headCut: false,
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      });
    },
  });
  t.after(() => h.bridge.dispose());

  const reply = await h.webview.send(req('github/actionsLog', { owner: 'o', repo: 'r', jobId: 77 }));
  assert.equal(reply.ok, true);
  assert.deepEqual(seen, [{ owner: 'o', repo: 'r', jobId: 77 }]);
});

test('a bad actions log payload never reaches the host function', async (t) => {
  let calls = 0;
  const h = harness(null, {
    githubActionsLog: () => {
      calls += 1;
      return Promise.resolve({
        state: 'empty',
        lines: [],
        headCut: false,
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      });
    },
  });
  t.after(() => h.bridge.dispose());

  const bad: Array<Record<string, unknown>> = [
    { owner: 'o wner', repo: 'r', jobId: 1 },
    { owner: 'o', repo: 'r repo', jobId: 1 },
    { owner: 'o', repo: 'r', jobId: 0 },
    { owner: 'o', repo: 'r', jobId: -3 },
    { owner: 'o', repo: 'r', jobId: 1.5 },
    { owner: 'o', repo: 'r', jobId: '77' },
    { owner: 'o', repo: 'r' },
  ];
  for (const payload of bad) {
    const reply = await h.webview.send(req('github/actionsLog', payload));
    assert.equal(reply.ok, false, JSON.stringify(payload));
    if (!reply.ok) assert.equal(reply.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(calls, 0, 'validation happens before the host call');
});

test('github/actionsLog answers UNAVAILABLE when the host lacks it', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());
  const reply = await h.webview.send(req('github/actionsLog', { owner: 'o', repo: 'r', jobId: 1 }));
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.equal(reply.error.code, 'UNAVAILABLE');
});

test('the actions log response carries no url-like string', async (t) => {
  const h = harness(null, {
    githubActionsLog: () =>
      Promise.resolve({
        state: 'ok',
        lines: [{ text: 'line', tone: 'normal' }],
        headCut: true,
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      }),
  });
  t.after(() => h.bridge.dispose());
  const reply = await h.webview.send(req('github/actionsLog', { owner: 'o', repo: 'r', jobId: 5 }));
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  const serialized = JSON.stringify(reply.data);
  assert.ok(!serialized.includes('https://'), serialized);
  assert.ok(!serialized.includes('sig='), serialized);
});

test('ui/takePendingRoute carries the focus target and omits it when there is none', async (t) => {
  // A quick action row only navigates, so the view needs to know which control
  // to focus. The key is absent, not null, when the host has no target.
  const queued = { route: { id: 'changes', sub: 'changes' }, focus: 'publish' } as const;
  const withFocus = harness(null, { takePendingRoute: () => queued });
  t.after(() => withFocus.bridge.dispose());
  const found = await withFocus.webview.send(req('ui/takePendingRoute', {}));
  assert.equal(found.ok, true);
  if (found.ok) assert.deepEqual(found.data, { route: queued.route, focus: 'publish' });

  const plain = harness(null, { takePendingRoute: () => ({ route: { id: 'prs' } as const }) });
  t.after(() => plain.bridge.dispose());
  const noFocus = await plain.webview.send(req('ui/takePendingRoute', {}));
  assert.equal(noFocus.ok, true);
  if (noFocus.ok) {
    assert.deepEqual(noFocus.data, { route: { id: 'prs' } });
    assert.equal('focus' in (noFocus.data as object), false, 'the key is omitted, never null');
  }
});

test('actions/openSidebarView rejects any route outside the allowlist', async (t) => {
  const opened: unknown[] = [];
  const h = harness(null, {
    openSidebarView: (route) => {
      opened.push(route);
      return true;
    },
  });
  t.after(() => h.bridge.dispose());

  // The route arrives from an untrusted webview, so it is parsed, never cast:
  // prototype keys, a bare string, an unknown id, and a `sub` on a view without
  // sub-tabs are all refused before the host is touched.
  for (const route of [
    '__proto__',
    'changes',
    { id: 'constructor' },
    { id: 'changes', sub: 'nope' },
    { id: 'help', tab: 'nope' },
    { id: 'prs', sub: 'changes' },
    null,
    7,
  ]) {
    const reply = await h.webview.send(req('actions/openSidebarView', { route }));
    assert.equal(reply.ok, false, JSON.stringify(route));
    if (!reply.ok) assert.equal(reply.error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(opened, [], 'the host is never called with an invalid route');
});

test('actions/openSidebarView calls the host once with the parsed route', async (t) => {
  const opened: unknown[] = [];
  const h = harness(null, {
    openSidebarView: (route) => {
      opened.push(route);
      return true;
    },
  });
  t.after(() => h.bridge.dispose());

  const reply = await h.webview.send(
    req('actions/openSidebarView', { route: { id: 'changes', sub: 'changes', extra: 'ignored' } }),
  );
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.deepEqual(reply.data, { opened: true });
  // Only known fields survive the parse, so a future key cannot ride along.
  assert.deepEqual(opened, [{ id: 'changes', sub: 'changes' }]);

  const help = await h.webview.send(req('actions/openSidebarView', { route: { id: 'help' } }));
  assert.equal(help.ok, true);
  assert.deepEqual(opened[1], { id: 'help', tab: 'features' }, 'a missing tab takes its default');
});

test('actions/openSidebarView degrades to opened false without the host member', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());
  const reply = await h.webview.send(req('actions/openSidebarView', { route: { id: 'prs' } }));
  assert.equal(reply.ok, true);
  if (reply.ok) assert.deepEqual(reply.data, { opened: false });
});

test('actions/pickRepository takes no parameters and degrades without the host member', async (t) => {
  let picked = 0;
  const h = harness(null, {
    pickRepository: () => {
      picked += 1;
    },
  });
  t.after(() => h.bridge.dispose());

  const reply = await h.webview.send(req('actions/pickRepository', {}));
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  assert.deepEqual(reply.data, { opened: true });
  assert.equal(picked, 1);

  const rejected = await h.webview.send(req('actions/pickRepository', { path: '/etc/passwd' }));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'VALIDATION_ERROR');
  assert.equal(picked, 1, 'the host is never called with a payload');

  const absent = harness(null);
  t.after(() => absent.bridge.dispose());
  const missing = await absent.webview.send(req('actions/pickRepository', {}));
  assert.equal(missing.ok, true);
  if (missing.ok) assert.deepEqual(missing.data, { opened: false });
});

// ---------------------------------------------------- branch delete (P20)

/** A repo whose two merged branches exist locally and on `origin`. */
async function cleanupRepo(): Promise<RepositoryService> {
  const dir = await makeFixture('branches-remote');
  return new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
}

test('branch-delete needs confirmation, then removes the branch', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo);
  t.after(() => h.bridge.dispose());
  const token = (await repo.status()).statusToken;

  const unconfirmed = await h.webview.send(
    req('actions/git', { action: 'branch-delete', branch: 'feat/a', statusToken: token, idempotencyKey: 'bd-1' }),
  );
  assert.equal(unconfirmed.ok, false);
  if (unconfirmed.ok) return;
  assert.equal(unconfirmed.error.status, 428);
  assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(unconfirmed.error.confirmationLevel, 1);
  assert.ok((await repo.git.refs()).some((r) => r.refName === 'refs/heads/feat/a'), 'nothing ran');

  const confirmed = await h.webview.send(
    req('actions/git', {
      action: 'branch-delete',
      branch: 'feat/a',
      statusToken: token,
      idempotencyKey: 'bd-2',
      confirm: true,
    }),
  );
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assert.ok(!(await repo.git.refs()).some((r) => r.refName === 'refs/heads/feat/a'));
});

test('branch-delete refuses the current branch even when the webview asks directly', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo);
  t.after(() => h.bridge.dispose());
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'branch-delete',
      branch: 'main',
      statusToken: token,
      idempotencyKey: 'bd-current',
      confirm: true,
      forceAcknowledgement: true,
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(response.error.remedies, ['cancel']);
  assert.ok((await repo.git.refs()).some((r) => r.refName === 'refs/heads/main'));
});

test('branch-delete of an unmerged branch returns 409 and leaves the branch', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo);
  t.after(() => h.bridge.dispose());
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'branch-delete',
      branch: 'spike/c',
      statusToken: token,
      idempotencyKey: 'bd-unmerged',
      confirm: true,
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 409);
  assert.equal(response.error.code, 'CONFLICT');
  assert.ok((await repo.git.refs()).some((r) => r.refName === 'refs/heads/spike/c'));
});

test('branch-delete-remote needs level 2 and removes the ref only with both flags', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo);
  t.after(() => h.bridge.dispose());
  const token = (await repo.status()).statusToken;

  const level1 = await h.webview.send(
    req('actions/git', {
      action: 'branch-delete-remote',
      remote: 'origin',
      branch: 'feat/a',
      statusToken: token,
      idempotencyKey: 'bdr-1',
      confirm: true,
    }),
  );
  assert.equal(level1.ok, false);
  if (level1.ok) return;
  assert.equal(level1.error.status, 428, 'confirm alone is not enough at level 2');
  assert.equal(level1.error.confirmationLevel, 2);
  assert.equal(level1.error.risk, 'high');

  const done = await h.webview.send(
    req('actions/git', {
      action: 'branch-delete-remote',
      remote: 'origin',
      branch: 'feat/a',
      statusToken: token,
      idempotencyKey: 'bdr-2',
      confirm: true,
      forceAcknowledgement: true,
    }),
  );
  assert.equal(done.ok, true, JSON.stringify(done));

  const remote = await repo.git.run(['ls-remote', '--heads', 'origin']);
  assert.doesNotMatch(remote.stdout, /refs\/heads\/feat\/a$/m);
  // The local branch survives: a remote delete removes one ref, not two.
  assert.ok((await repo.git.refs()).some((r) => r.refName === 'refs/heads/feat/a'));

  // Criterion 6: after a fetch with prune the tracking ref is gone too, which is
  // what the Remote sub-tab reads.
  await repo.git.fetch({ remote: 'origin', prune: true });
  // `GitRunner.refs()` returns `ParsedRef`, which carries no `kind`; filter on the
  // ref name, or the filter silently matches nothing and the assertion passes
  // for the wrong reason.
  const remoteRefs = (await repo.git.refs())
    .map((r) => r.refName)
    .filter((name) => name.startsWith('refs/remotes/'));
  assert.ok(!remoteRefs.includes('refs/remotes/origin/feat/a'));
  assert.ok(remoteRefs.includes('refs/remotes/origin/fix/b'), 'the sibling stays');
});

test('branch-delete-remote refuses a remote the repository does not have', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo);
  t.after(() => h.bridge.dispose());
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'branch-delete-remote',
      remote: 'upstream',
      branch: 'feat/a',
      statusToken: token,
      idempotencyKey: 'bdr-missing-remote',
      confirm: true,
      forceAcknowledgement: true,
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 409);
  assert.equal(response.error.code, 'CONFLICT');
});

test('replaying a branch-delete with the same idempotency key does not run git twice', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo);
  t.after(() => h.bridge.dispose());
  const token = (await repo.status()).statusToken;
  const payload = {
    action: 'branch-delete' as const,
    branch: 'feat/a',
    statusToken: token,
    idempotencyKey: 'bd-replay',
    confirm: true,
  };

  const first = await h.webview.send(req('actions/git', payload));
  assert.equal(first.ok, true);
  const second = await h.webview.send(req('actions/git', payload));
  assert.equal(second.ok, true, 'the stored outcome is replayed, not an error');

  // A second real run would fail with "branch not found"; the replay proves the
  // second request never reached git.
  assert.ok(!(await repo.git.refs()).some((r) => r.refName === 'refs/heads/feat/a'));
});

// ------------------------------------------------------ P21: checks over bridge

test('P21: commit pull requests and check runs reach the host with validated payloads', async (t) => {
  const prCalls: Array<{ owner: string; repo: string; hash: string }> = [];
  const checkCalls: Array<{ owner: string; repo: string; sha: string }> = [];
  const rateLimit = { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false };
  const withHost = harness(null, {
    githubCommitPullRequests: (payload) => {
      prCalls.push(payload);
      return Promise.resolve({ pullRequests: [], rateLimit });
    },
    githubCheckRuns: (payload) => {
      checkCalls.push(payload);
      return Promise.resolve({
        checks: [],
        summary: { state: 'none', total: 0, passed: 0, failing: 0, pending: 0, failingNames: [] },
        rateLimit,
      });
    },
  });
  t.after(() => withHost.bridge.dispose());
  const HASH = 'a'.repeat(40);

  const prs = await withHost.webview.send(
    req('github/commitPullRequests', { owner: 'o', repo: 'r', hash: HASH }),
  );
  assert.equal(prs.ok, true);
  assert.deepEqual(prCalls, [{ owner: 'o', repo: 'r', hash: HASH }]);

  const checks = await withHost.webview.send(req('github/checkRuns', { owner: 'o', repo: 'r', sha: HASH }));
  assert.equal(checks.ok, true);
  if (checks.ok) {
    assert.deepEqual((checks.data as { summary: { state: string } }).summary.state, 'none');
  }
  assert.deepEqual(checkCalls, [{ owner: 'o', repo: 'r', sha: HASH }]);
});

test('P21: bad owners, repos, and hashes are refused before the host sees them', async (t) => {
  let reached = 0;
  const withHost = harness(null, {
    githubCommitPullRequests: () => {
      reached += 1;
      return Promise.resolve({
        pullRequests: [],
        rateLimit: { limit: null, remaining: null, resetAt: null, cached: false, offline: false },
      });
    },
    githubCheckRuns: () => {
      reached += 1;
      return Promise.resolve({
        checks: [],
        summary: { state: 'none', total: 0, passed: 0, failing: 0, pending: 0, failingNames: [] },
        rateLimit: { limit: null, remaining: null, resetAt: null, cached: false, offline: false },
      });
    },
  });
  t.after(() => withHost.bridge.dispose());
  const HASH = 'a'.repeat(40);

  for (const payload of [
    { owner: '../../etc/passwd', repo: 'r', hash: HASH },
    { owner: 'o', repo: 'x'.repeat(1_000_000), hash: HASH },
    { owner: 'o', repo: 'r', hash: '--force' },
    { owner: 'o', repo: 'r', hash: 'abc' },
    { owner: 'o', repo: 'r', hash: 'g'.repeat(40) },
  ]) {
    const prs = await withHost.webview.send(req('github/commitPullRequests', payload));
    assert.equal(prs.ok, false, JSON.stringify(payload));
    if (!prs.ok) assert.equal(prs.error.code, 'VALIDATION_ERROR');
    const checks = await withHost.webview.send(req('github/checkRuns', payload));
    assert.equal(checks.ok, false, JSON.stringify(payload));
    if (!checks.ok) assert.equal(checks.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(reached, 0, 'nothing invalid reached the host');
});

test('P21: both kinds answer UNAVAILABLE when the host has no callback', async (t) => {
  const withHost = harness(null);
  t.after(() => withHost.bridge.dispose());
  const HASH = 'a'.repeat(40);
  for (const [kind, payload] of [
    ['github/commitPullRequests', { owner: 'o', repo: 'r', hash: HASH }],
    ['github/checkRuns', { owner: 'o', repo: 'r', sha: HASH }],
  ] as const) {
    const response = await withHost.webview.send(req(kind, payload));
    assert.equal(response.ok, false, kind);
    if (response.ok) return;
    assert.equal(response.error.code, 'UNAVAILABLE', kind);
    assert.equal(response.error.status, 503, kind);
  }
});

// ------------------------------------------------ pull request checkout (P23)

/**
 * The host sequence is fetch, then switch, under one operation id. A failed
 * fetch must not leave the user on a half-updated branch, so the switch only
 * runs after the fetch returned.
 */
test('P23: checkout-pr fetches the pull request and switches to pr/<n>', async (t) => {
  const dir = await makeFixture('remote-pulls');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/git', { action: 'checkout-pr', number: 1, remote: 'origin', idempotencyKey: 'cp-ok' }),
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) return;
  const data = response.data as { ok: boolean };
  assert.equal(data.ok, true);

  const { branch } = await repo.git.currentBranch();
  assert.equal(branch, 'pr/1', 'HEAD is on the pull request branch');
  assert.equal(await repo.git.localBranchExists('pr/1'), true);
});

test('P23: a failed fetch does not switch branches', async (t) => {
  const dir = await makeFixture('remote-pulls');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/git', { action: 'checkout-pr', number: 99, remote: 'origin', idempotencyKey: 'cp-404' }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'NOT_FOUND');
  const { branch } = await repo.git.currentBranch();
  assert.equal(branch, 'main', 'the current branch is unchanged');
});

test('P23: a dirty tree refuses checkout-pr with the stash and commit remedies', async (t) => {
  const dir = await makeFixture('remote-pulls');
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, 'dirty.txt'), 'x\n', 'utf8');
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/git', { action: 'checkout-pr', number: 1, idempotencyKey: 'cp-dirty' }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 412);
  assert.equal(response.error.code, 'DIRTY_TREE');
  assert.deepEqual(response.error.remedies, ['commit', 'stash', 'cancel']);
  const { branch } = await repo.git.currentBranch();
  assert.equal(branch, 'main');
});

test('P23: the same key replayed runs git once', async (t) => {
  const dir = await makeFixture('remote-pulls');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const payload = { action: 'checkout-pr', number: 1, remote: 'origin', idempotencyKey: 'cp-replay' };
  const first = await h.webview.send(req('actions/git', payload));
  assert.equal(first.ok, true);
  // Move the pull request on: a second real run would fast-forward the branch.
  const before = (await repo.git.run(['rev-parse', 'refs/heads/pr/1'])).stdout.trim();
  await advancePullRequest(dir, 'replay.txt', 'replay advance');
  await setPullRequestHead(dir, 1);
  const second = await h.webview.send(req('actions/git', payload));
  assert.equal(second.ok, true);
  const after = (await repo.git.run(['rev-parse', 'refs/heads/pr/1'])).stdout.trim();
  assert.equal(after, before, 'the replay answered from the stored outcome, it did not fetch again');
});

/**
 * A branch whose commits came from a fork is read only. The bridge is where the
 * set is built, because only it can read the pull request list and the refs
 * together; the guard then refuses the push on that set.
 */
test('P23: a push from a fork pull request branch is refused by the host', async (t) => {
  const dir = await makeFixture('remote-pulls');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await repo.git.fetchPullRequest('origin', 1);
  await repo.git.switchBranch('pr/1');
  await repo.git.run(['branch', 'pr/9', 'pr/1']);
  await repo.markReadOnlyBranch('pr/9');
  repo.invalidate();

  const response = await h.webview.send(
    req('actions/git', { action: 'push', remote: 'origin', branch: 'pr/9', idempotencyKey: 'cp-ro' }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'FORBIDDEN');
  assert.equal(response.error.status, 403);
  assert.deepEqual(response.error.remedies, ['cancel']);
  assert.match(response.error.message, /fork pull request/i);
});

/**
 * The mark is what the checkout writes, so the flag has to survive the round
 * trip through the request. A payload without it marks nothing, which keeps a
 * same-repository pull request pushable like any other branch.
 */
/**
 * A mark that only ever grows would leave a user's own `pr/<n>` branch refused
 * forever once a same-numbered fork pull request was checked out. The record is
 * therefore the result of the LAST checkout of that number, not an accumulation:
 * a same-repository pull request clears the mark its fork sibling left behind.
 */
test('P23: a same-repository checkout clears an earlier fork mark', async (t) => {
  const dir = await makeFixture('remote-pulls');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const fork = await h.webview.send(
    req('actions/git', {
      action: 'checkout-pr',
      number: 2,
      remote: 'origin',
      readOnly: true,
      idempotencyKey: 'cp-mark',
    }),
  );
  assert.equal(fork.ok, true, JSON.stringify(fork));
  assert.equal(repo.readOnlyBranches().has('pr/2'), true);

  const own = await h.webview.send(
    req('actions/git', { action: 'checkout-pr', number: 2, remote: 'origin', idempotencyKey: 'cp-unmark' }),
  );
  assert.equal(own.ok, true, JSON.stringify(own));
  assert.equal(repo.readOnlyBranches().has('pr/2'), false, 'the fork mark is gone');

  const push = await h.webview.send(
    req('actions/git', { action: 'push', remote: 'origin', branch: 'pr/2', idempotencyKey: 'cp-own-push' }),
  );
  // The push may still fail for an ordinary reason (no upstream, non-fast-forward);
  // what must not happen is the read-only refusal.
  if (!push.ok) assert.notEqual(push.error.code, 'FORBIDDEN', 'the push is no longer refused as read only');
});

test('P23: checking out a fork pull request marks its branch read only', async (t) => {
  const dir = await makeFixture('remote-pulls');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('actions/git', {
      action: 'checkout-pr',
      number: 2,
      remote: 'origin',
      readOnly: true,
      idempotencyKey: 'cp-fork',
    }),
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(repo.readOnlyBranches().has('pr/2'), true);

  const push = await h.webview.send(
    req('actions/git', { action: 'push', remote: 'origin', branch: 'pr/2', idempotencyKey: 'cp-fork-push' }),
  );
  assert.equal(push.ok, false);
  if (push.ok) return;
  assert.equal(push.error.code, 'FORBIDDEN');
});

// ------------------------------------------------- P24 pull request detail reads

/**
 * The four detail reads share one payload and one shape: validate, refuse a
 * host that has no method with 503, otherwise pass the payload through. The
 * validation arms are what keep an untrusted number out of a URL path segment.
 */
test('P24: each pull detail read validates its payload before reaching the host', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());

  for (const kind of ['github/pullDetail', 'github/pullCommits', 'github/pullFiles', 'github/pullTimeline']) {
    for (const payload of [
      { owner: '', repo: 'r', number: 1 },
      { owner: 'o', repo: '..', number: 1 },
      { owner: 'o', repo: 'r', number: 0 },
      { owner: 'o', repo: 'r', number: '1' },
      { owner: 'o', repo: 'r' },
    ]) {
      const response = await h.webview.send(req(kind, payload));
      assert.equal(response.ok, false, `${kind} ${JSON.stringify(payload)}`);
      if (response.ok) return;
      assert.equal(response.error.status, 400);
      assert.equal(response.error.code, 'VALIDATION_ERROR');
    }
  }
});

test('P24: a pull detail read fails 503 when the host has no method', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('github/pullDetail', { owner: 'o', repo: 'r', number: 1 }));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 503);
  assert.equal(response.error.code, 'UNAVAILABLE');
});

test('P24: a valid pull detail read reaches the host unchanged', async (t) => {
  const seen: unknown[] = [];
  const h = harness(null, {
    githubPullDetail: (payload) => {
      seen.push(payload);
      return Promise.resolve({
        detail: {} as never,
        rateLimit: { limit: null, remaining: null, resetAt: null, cached: false, offline: false },
      });
    },
  });
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('github/pullDetail', { owner: 'o', repo: 'r', number: 150 }));
  assert.equal(response.ok, true);
  assert.deepEqual(seen, [{ owner: 'o', repo: 'r', number: 150 }]);
});

test('P24: actions/openPullRequest refuses an extra field and passes a bare number', async (t) => {
  const opened: unknown[] = [];
  const h = harness(null, {
    openPullRequest: (payload) => {
      opened.push(payload);
      return Promise.resolve(true);
    },
  });
  t.after(() => h.bridge.dispose());

  const extra = await h.webview.send(req('actions/openPullRequest', { number: 150, path: '/etc/passwd' }));
  assert.equal(extra.ok, false);
  if (extra.ok) return;
  assert.equal(extra.error.status, 400);

  const bad = await h.webview.send(req('actions/openPullRequest', { number: 0 }));
  assert.equal(bad.ok, false);

  const good = await h.webview.send(req('actions/openPullRequest', { number: 150 }));
  assert.equal(good.ok, true);
  assert.deepEqual(opened, [{ number: 150 }]);
});

test('P24: actions/openPullRequest answers opened false without a host method', async (t) => {
  const h = harness(null);
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('actions/openPullRequest', { number: 150 }));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(response.data, { opened: false });
});

// ------------------------------------- P25 merge, close, review, reply writes

/**
 * The P25 writes are the first GitHub mutations where the order of host work
 * matters as much as the request. A merge re-reads the pull request before it
 * trusts anything the webview said, pins the merge to the head the user saw, and
 * treats a refused branch deletion as a warning after the merge already landed.
 *
 * The API calls themselves are host callbacks here, stubbed. What is under test
 * is the bridge: validation, guard, idempotency, order, and result shape.
 */

const RATE_LIMIT = { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false };

function pullDetail(overrides: Partial<PullDetail> = {}): PullDetail {
  return {
    number: 150,
    title: 'Rebalance change row content inset to 8px',
    state: 'open',
    draft: false,
    author: 'TrygerZ',
    authorAvatarUrl: null,
    headRef: 'fix/ui-review-polish',
    baseRef: 'main',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    commits: 2,
    additions: 84,
    deletions: 15,
    changedFiles: 3,
    mergeableState: 'clean',
    htmlUrl: 'https://github.com/o/r/pull/150',
    body: '',
    createdAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T00:00:00Z',
    mergedAt: null,
    reviewers: [],
    approvedBy: [],
    changesRequestedBy: [],
    labels: [],
    ...overrides,
  };
}

function writeHost(overrides: Partial<BridgeHost> = {}): Partial<BridgeHost> {
  return {
    githubWriteContext: () =>
      Promise.resolve({ connected: true, scopes: ['repo'], tokenAllowed: true, circuitOpen: false }),
    githubPullDetail: () => Promise.resolve({ detail: pullDetail(), rateLimit: RATE_LIMIT }),
    ...overrides,
  };
}

function mergePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owner: 'o',
    repo: 'r',
    number: 150,
    method: 'merge',
    expectedHeadSha: 'a'.repeat(40),
    idempotencyKey: 'merge-1',
    confirm: true,
    ...overrides,
  };
}

const MERGED = { merged: true, mergeSha: 'c'.repeat(40), rateLimit: RATE_LIMIT };
const MERGED_NO_SHA = { merged: true, mergeSha: null, rateLimit: RATE_LIMIT };

test('P25: merge is refused without confirm, with 428 and its level', async (t) => {
  let merged = 0;
  const h = harness(null, writeHost({
    githubMergePullRequest: () => {
      merged += 1;
      return Promise.resolve(MERGED);
    },
  }));
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('github/mergePullRequest', mergePayload({ confirm: undefined })));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 428);
  assert.equal(response.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(response.error.confirmationLevel, 1);
  assert.equal(merged, 0, 'nothing was merged before the user confirmed');
});

test('P25: a stale expected head is refused before GitHub is asked', async (t) => {
  let merged = 0;
  const h = harness(null, writeHost({
    githubPullDetail: () => Promise.resolve({ detail: pullDetail({ headSha: 'c'.repeat(40) }), rateLimit: RATE_LIMIT }),
    githubMergePullRequest: () => {
      merged += 1;
      return Promise.resolve(MERGED);
    },
  }));
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(req('github/mergePullRequest', mergePayload()));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 409);
  assert.equal(response.error.code, 'CONFLICT');
  assert.equal(response.error.detail, 'head');
  assert.equal(merged, 0, 'the moved head was caught here, not by GitHub');
});

test('P25: a pull request GitHub still calls unmergeable is refused host-side', async (t) => {
  for (const state of ['dirty', 'blocked', 'behind', 'unknown'] as const) {
    let merged = 0;
    const h = harness(null, writeHost({
      githubPullDetail: () => Promise.resolve({ detail: pullDetail({ mergeableState: state }), rateLimit: RATE_LIMIT }),
      githubMergePullRequest: () => {
        merged += 1;
        return Promise.resolve(MERGED);
      },
    }));
    t.after(() => h.bridge.dispose());
    const response = await h.webview.send(req('github/mergePullRequest', mergePayload({ idempotencyKey: `m-${state}` })));
    assert.equal(response.ok, false, state);
    if (response.ok) return;
    assert.equal(response.error.code, 'CONFLICT', state);
    assert.equal(response.error.detail, state, `${state} names the reason`);
    assert.equal(merged, 0, `${state} never reached GitHub`);
  }
});

test('P25: a draft pull request is refused host-side', async (t) => {
  let merged = 0;
  const h = harness(null, writeHost({
    githubPullDetail: () => Promise.resolve({ detail: pullDetail({ draft: true }), rateLimit: RATE_LIMIT }),
    githubMergePullRequest: () => {
      merged += 1;
      return Promise.resolve(MERGED);
    },
  }));
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('github/mergePullRequest', mergePayload()));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'CONFLICT');
  assert.equal(response.error.detail, 'draft');
  assert.equal(merged, 0);
});

test('P25: a pull request that is no longer open is refused host-side', async (t) => {
  for (const state of ['closed', 'merged'] as const) {
    let merged = 0;
    const h = harness(null, writeHost({
      githubPullDetail: () => Promise.resolve({ detail: pullDetail({ state }), rateLimit: RATE_LIMIT }),
      githubMergePullRequest: () => {
        merged += 1;
        return Promise.resolve(MERGED);
      },
    }));
    t.after(() => h.bridge.dispose());
    const response = await h.webview.send(req('github/mergePullRequest', mergePayload({ idempotencyKey: `m-${state}` })));
    assert.equal(response.ok, false, state);
    if (response.ok) return;
    assert.equal(response.error.code, 'CONFLICT');
    assert.equal(merged, 0, `${state} pull requests are not merged twice`);
  }
});

test('P25: a clean merge with a matching head reaches the host with the expected sha', async (t) => {
  const seen: unknown[] = [];
  const h = harness(null, writeHost({
    githubMergePullRequest: (payload) => {
      seen.push(payload);
      return Promise.resolve(MERGED);
    },
  }));
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('github/mergePullRequest', mergePayload({ method: 'squash' })));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(seen.length, 1);
  const sent = seen[0] as { method: string; sha: string };
  assert.equal(sent.method, 'squash');
  assert.equal(sent.sha, 'a'.repeat(40), 'the sha the panel showed is the sha GitHub merges');
  if (!response.ok) return;
  const data = response.data as { merged: boolean; mergeSha: string | null; branchDeleted: unknown; warnings: string[] };
  assert.equal(data.merged, true);
  assert.equal(data.mergeSha, 'c'.repeat(40));
  assert.deepEqual(data.warnings, []);
  assert.deepEqual(data.branchDeleted, { remote: null, local: null }, 'no delete was asked for');
});

test('P25: two merges with one key run once and replay the same result', async (t) => {
  let merged = 0;
  const h = harness(null, writeHost({
    githubMergePullRequest: () => {
      merged += 1;
      return Promise.resolve(MERGED);
    },
  }));
  t.after(() => h.bridge.dispose());
  const payload = mergePayload({ idempotencyKey: 'once' });
  const first = await h.webview.send(req('github/mergePullRequest', payload));
  const second = await h.webview.send(req('github/mergePullRequest', payload));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(merged, 1, 'the second send replayed the first');
  if (!first.ok || !second.ok) return;
  assert.deepEqual(second.data, first.data);
});

test('P25: a failed merge is attempted again, because nothing landed to duplicate', async (t) => {
  let merged = 0;
  const h = harness(null, writeHost({
    githubMergePullRequest: () => {
      merged += 1;
      throw new GitHubError({ status: 409, code: 'CONFLICT', message: 'The branch changed', detail: 'head' });
    },
  }));
  t.after(() => h.bridge.dispose());
  const payload = mergePayload({ idempotencyKey: 'retry-me' });
  const first = await h.webview.send(req('github/mergePullRequest', payload));
  assert.equal(first.ok, false);
  const second = await h.webview.send(req('github/mergePullRequest', payload));
  assert.equal(second.ok, false);
  assert.equal(merged, 2, 'a refused merge is attempted again, because no merge exists to duplicate');
});

test('P25: a merge payload carrying rebase never reaches the host', async (t) => {
  let merged = 0;
  const h = harness(null, writeHost({
    githubMergePullRequest: () => {
      merged += 1;
      return Promise.resolve(MERGED);
    },
  }));
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('github/mergePullRequest', mergePayload({ method: 'rebase' })));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'VALIDATION_ERROR');
  assert.equal(merged, 0);
});

test('P25: a merge payload with an extra field is refused, not ignored', async (t) => {
  const h = harness(null, writeHost());
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('github/mergePullRequest', mergePayload({ path: '/etc/passwd' })));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'VALIDATION_ERROR');
});

test('P25: a merge write with no host method is 503', async (t) => {
  const h = harness(null, writeHost());
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('github/mergePullRequest', mergePayload()));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 503);
});

test('P25: a merge driven by a token without write scope never calls GitHub', async (t) => {
  let merged = 0;
  const h = harness(null, writeHost({
    githubWriteContext: () =>
      Promise.resolve({ connected: true, scopes: ['read:user'], tokenAllowed: true, circuitOpen: false }),
    githubMergePullRequest: () => {
      merged += 1;
      return Promise.resolve(MERGED);
    },
  }));
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('github/mergePullRequest', mergePayload()));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 403);
  assert.equal(merged, 0);
});

test('P25: close needs confirm and passes only the number through', async (t) => {
  const seen: unknown[] = [];
  const h = harness(null, writeHost({
    githubClosePullRequest: (payload) => {
      seen.push(payload);
      return Promise.resolve({ closed: true });
    },
  }));
  t.after(() => h.bridge.dispose());

  const blocked = await h.webview.send(
    req('github/closePullRequest', { owner: 'o', repo: 'r', number: 150, idempotencyKey: 'c1', confirm: undefined }),
  );
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.error.code, 'CONFIRMATION_REQUIRED');

  const ok = await h.webview.send(
    req('github/closePullRequest', { owner: 'o', repo: 'r', number: 150, idempotencyKey: 'c2', confirm: true }),
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(seen, [{ owner: 'o', repo: 'r', number: 150, idempotencyKey: 'c2', confirm: true }]);
});

test('P25: a review posts without a confirm, because the form is the act', async (t) => {
  const seen: unknown[] = [];
  const h = harness(null, writeHost({
    githubSubmitReview: (payload) => {
      seen.push(payload);
      return Promise.resolve({ reviewId: 7 });
    },
  }));
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(
    req('github/submitReview', {
      owner: 'o',
      repo: 'r',
      number: 150,
      event: 'APPROVE',
      body: '',
      expectedHeadSha: 'a'.repeat(40),
      idempotencyKey: 'rev-1',
    }),
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) return;
  assert.deepEqual(response.data, { reviewId: 7 });
  assert.equal((seen[0] as { event: string }).event, 'APPROVE');
});

test('P25: request changes and comment with no text are refused before the host sees them', async (t) => {
  let posted = 0;
  const h = harness(null, writeHost({
    githubSubmitReview: () => {
      posted += 1;
      return Promise.resolve({ reviewId: 7 });
    },
  }));
  t.after(() => h.bridge.dispose());
  for (const event of ['REQUEST_CHANGES', 'COMMENT']) {
    for (const body of ['', '   ', '\n\t']) {
      const response = await h.webview.send(
        req('github/submitReview', {
          owner: 'o',
          repo: 'r',
          number: 150,
          event,
          body,
          expectedHeadSha: 'a'.repeat(40),
          idempotencyKey: `rev-${event}-${body.length}`,
        }),
      );
      assert.equal(response.ok, false, `${event} ${JSON.stringify(body)}`);
      if (response.ok) return;
      assert.equal(response.error.code, 'VALIDATION_ERROR');
    }
  }
  assert.equal(posted, 0);
});

test('P25: an approve with no text is allowed, because it has nothing to say', async (t) => {
  const h = harness(null, writeHost({
    githubSubmitReview: () => Promise.resolve({ reviewId: 9 }),
  }));
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(
    req('github/submitReview', {
      owner: 'o',
      repo: 'r',
      number: 1,
      event: 'APPROVE',
      body: '',
      expectedHeadSha: 'a'.repeat(40),
      idempotencyKey: 'approve-empty',
    }),
  );
  assert.equal(response.ok, true);
});

test('P25: a review on a moved head is refused with the refresh message', async (t) => {
  let posted = 0;
  const h = harness(null, writeHost({
    githubPullDetail: () => Promise.resolve({ detail: pullDetail({ headSha: 'c'.repeat(40) }), rateLimit: RATE_LIMIT }),
    githubSubmitReview: () => {
      posted += 1;
      return Promise.resolve({ reviewId: 7 });
    },
  }));
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(
    req('github/submitReview', {
      owner: 'o',
      repo: 'r',
      number: 150,
      event: 'APPROVE',
      body: '',
      expectedHeadSha: 'a'.repeat(40),
      idempotencyKey: 'rev-stale',
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'CONFLICT');
  assert.equal(posted, 0);
});

test('P25: a review event outside the allowlist is refused', async (t) => {
  const h = harness(null, writeHost());
  t.after(() => h.bridge.dispose());
  for (const event of ['DISMISS', 'approve', '', 'PENDING']) {
    const response = await h.webview.send(
      req('github/submitReview', {
        owner: 'o',
        repo: 'r',
        number: 1,
        event,
        body: 'x',
        expectedHeadSha: 'a'.repeat(40),
        idempotencyKey: `rev-${event}`,
      }),
    );
    assert.equal(response.ok, false, event);
    if (response.ok) return;
    assert.equal(response.error.code, 'VALIDATION_ERROR');
  }
});

test('P25: a reply posts to the host with a positive comment id', async (t) => {
  const seen: unknown[] = [];
  const h = harness(null, writeHost({
    githubReplyReviewComment: (payload) => {
      seen.push(payload);
      return Promise.resolve({ commentId: 55 });
    },
  }));
  t.after(() => h.bridge.dispose());

  for (const commentId of [0, -1, 1.5, '44', null]) {
    const response = await h.webview.send(
      req('github/replyReviewComment', {
        owner: 'o',
        repo: 'r',
        number: 150,
        commentId,
        body: 'Agreed.',
        idempotencyKey: `rep-${String(commentId)}`,
      }),
    );
    assert.equal(response.ok, false, String(commentId));
    if (response.ok) return;
    assert.equal(response.error.code, 'VALIDATION_ERROR');
  }

  const ok = await h.webview.send(
    req('github/replyReviewComment', {
      owner: 'o',
      repo: 'r',
      number: 150,
      commentId: 44,
      body: 'Agreed.',
      idempotencyKey: 'rep-ok',
    }),
  );
  assert.equal(ok.ok, true);
  assert.equal(seen.length, 1);
});

test('P25: an empty reply body is refused', async (t) => {
  const h = harness(null, writeHost());
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(
    req('github/replyReviewComment', {
      owner: 'o',
      repo: 'r',
      number: 150,
      commentId: 44,
      body: '  ',
      idempotencyKey: 'rep-empty',
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'VALIDATION_ERROR');
});

/**
 * SEC-014 extended to GitHub writes.
 *
 * A write that dies mid-flight may have landed on GitHub's side. Replaying the
 * stored failure is the only retry that cannot duplicate a review, a merge, or a
 * comment. A REFUSAL is different: the write provably did not land, so the retry
 * behind the confirmation dialog must actually run.
 */
test('P25: an unavailable GitHub write is replayed, so a retry cannot post twice', async (t) => {
  let posted = 0;
  const h = harness(null, writeHost({
    githubSubmitReview: () => {
      posted += 1;
      throw new GitHubError({ status: 503, code: 'UNAVAILABLE', message: 'GitHub is unreachable.' });
    },
  }));
  t.after(() => h.bridge.dispose());
  const payload = {
    owner: 'o',
    repo: 'r',
    number: 150,
    event: 'APPROVE',
    body: '',
    expectedHeadSha: 'a'.repeat(40),
    idempotencyKey: 'unavailable-once',
  };
  const first = await h.webview.send(req('github/submitReview', payload));
  const second = await h.webview.send(req('github/submitReview', payload));
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(posted, 1, 'the write that may have landed was not attempted again');
  if (first.ok || second.ok) return;
  assert.deepEqual(second.error, first.error, 'the stored failure is replayed verbatim');
});

test('P25: a stale-head refusal is attempted again after the reload', async (t) => {
  let reads = 0;
  let posted = 0;
  const h = harness(null, writeHost({
    // The first read reports a moved head: the refusal path.
    githubPullDetail: () => {
      reads += 1;
      return Promise.resolve({
        detail: pullDetail({ headSha: reads === 1 ? 'c'.repeat(40) : 'a'.repeat(40) }),
        rateLimit: RATE_LIMIT,
      });
    },
    githubSubmitReview: () => {
      posted += 1;
      return Promise.resolve({ reviewId: 7 });
    },
  }));
  t.after(() => h.bridge.dispose());
  const payload = {
    owner: 'o',
    repo: 'r',
    number: 150,
    event: 'APPROVE',
    body: '',
    expectedHeadSha: 'a'.repeat(40),
    idempotencyKey: 'stale-then-ok',
  };
  const first = await h.webview.send(req('github/submitReview', payload));
  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.equal(first.error.code, 'CONFLICT');

  const second = await h.webview.send(req('github/submitReview', payload));
  assert.equal(second.ok, true, 'the refusal was not replayed: the retry ran');
  assert.equal(posted, 1);
});

test('P25: a missing-scope refusal is attempted again after reconnecting', async (t) => {
  let contexts = 0;
  const h = harness(null, writeHost({
    githubWriteContext: () => {
      contexts += 1;
      return Promise.resolve(
        contexts === 1
          ? { connected: true, scopes: ['read:user'], tokenAllowed: true, circuitOpen: false }
          : { connected: true, scopes: ['repo'], tokenAllowed: true, circuitOpen: false },
      );
    },
    githubClosePullRequest: () => Promise.resolve({ closed: true }),
  }));
  t.after(() => h.bridge.dispose());
  const payload = { owner: 'o', repo: 'r', number: 150, idempotencyKey: 'scope-then-ok', confirm: true };
  const first = await h.webview.send(req('github/closePullRequest', payload));
  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.equal(first.error.code, 'FORBIDDEN');

  const second = await h.webview.send(req('github/closePullRequest', payload));
  assert.equal(second.ok, true, 'the refusal was not replayed: the gate ran again');
});

/**
 * The merge and review pre-check must not read the same cached detail the
 * webview read. Within the 60 s TTL a cached re-read returns the webview's own
 * snapshot, so the pin would compare a value against itself and a head that moved
 * would be invisible until GitHub refused it. The host asks for a refresh.
 */
test('P25 fix: the merge pre-check asks the host for a fresh detail read', async (t) => {
  const refresh: unknown[] = [];
  const h = harness(null, writeHost({
    githubPullDetail: (payload) => {
      refresh.push(payload);
      return Promise.resolve({ detail: pullDetail(), rateLimit: RATE_LIMIT });
    },
    githubMergePullRequest: () => Promise.resolve(MERGED),
  }));
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(req('github/mergePullRequest', mergePayload()));
  assert.equal(response.ok, true);
  assert.equal(refresh.length, 1);
  assert.equal((refresh[0] as { refresh?: boolean }).refresh, true, 'the merge read must bypass the cache');
});

test('P25 fix: the review pre-check asks the host for a fresh detail read', async (t) => {
  const refresh: unknown[] = [];
  const h = harness(null, writeHost({
    githubPullDetail: (payload) => {
      refresh.push(payload);
      return Promise.resolve({ detail: pullDetail(), rateLimit: RATE_LIMIT });
    },
    githubSubmitReview: () => Promise.resolve({ reviewId: 7 }),
  }));
  t.after(() => h.bridge.dispose());
  await h.webview.send(
    req('github/submitReview', {
      owner: 'o',
      repo: 'r',
      number: 150,
      event: 'APPROVE',
      body: '',
      expectedHeadSha: 'a'.repeat(40),
      idempotencyKey: 'rev-fresh',
    }),
  );
  assert.equal(refresh.length, 1);
  assert.equal((refresh[0] as { refresh?: boolean }).refresh, true);
});

/**
 * QA-02: the webview must not be able to force an uncached read.
 *
 * `refresh` is a host-internal hint the merge and review handlers add to their own
 * re-read. A webview that sends the same key on the ordinary `github/pullDetail`
 * request must not have it forwarded, or every panel read could bypass the cache
 * and spend the anonymous quota.
 */
test('QA-02: a webview-supplied refresh never reaches the host on the ordinary read', async (t) => {
  const seen: unknown[] = [];
  const h = harness(null, {
    githubPullDetail: (payload) => {
      seen.push(payload);
      return Promise.resolve({
        detail: {} as never,
        rateLimit: { limit: null, remaining: null, resetAt: null, cached: false, offline: false },
      });
    },
  });
  t.after(() => h.bridge.dispose());
  const response = await h.webview.send(
    req('github/pullDetail', { owner: 'o', repo: 'r', number: 150, refresh: true }),
  );
  assert.equal(response.ok, true);
  assert.deepEqual(seen, [{ owner: 'o', repo: 'r', number: 150 }], 'only the declared fields are forwarded');
});

/**
 * QA-04: the delete path must refuse the base branch, not only HEAD.
 *
 * The phase file states "Never delete HEAD, the default branch, or a branch with
 * unmerged commits", and `selectCleanupCandidates` already excludes the default
 * branch. The bridge's two delete callers (the cleanup action and the merge's
 * delete-branch step) shared a helper that compared only against `current`, so a
 * merge whose head IS the base branch could delete it. The host can answer it;
 * tree data cannot.
 */
function repoHost(defaultBranch: string): Partial<BridgeHost> {
  return {
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
    githubRepo: () =>
      Promise.resolve({
        defaultBranch,
        private: false,
        htmlUrl: 'https://github.com/o/r',
        rateLimit: RATE_LIMIT,
      }),
  };
}

test('QA-04: branch-delete refuses the default branch even when it is not HEAD', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo, repoHost('feat/a'));
  t.after(() => h.bridge.dispose());
  const token = (await repo.status()).statusToken;
  assert.equal((await repo.status()).branch, 'main', 'the fixture is on main, not on feat/a');

  const response = await h.webview.send(
    req('actions/git', {
      action: 'branch-delete',
      branch: 'feat/a',
      statusToken: token,
      idempotencyKey: 'bd-default',
      confirm: true,
      forceAcknowledgement: true,
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(response.error.remedies, ['cancel']);
  assert.ok(
    (await repo.git.refs()).some((r) => r.refName === 'refs/heads/feat/a'),
    'the default branch was not deleted',
  );
});

test('QA-04: the merge delete step refuses a head that is the default branch', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo, {
    ...writeHost({
      githubPullDetail: () =>
        Promise.resolve({ detail: pullDetail({ headRef: 'feat/a' }), rateLimit: RATE_LIMIT }),
      githubMergePullRequest: () => Promise.resolve(MERGED),
    }),
    ...repoHost('feat/a'),
  });
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('github/mergePullRequest', mergePayload({ deleteBranch: true })),
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) return;
  const data = response.data as { merged: boolean; branchDeleted: { local: boolean | null; remote: boolean | null }; warnings: string[] };
  assert.equal(data.merged, true, 'the merge still lands');
  assert.equal(data.branchDeleted.local, false, 'the default branch was not deleted');
  assert.ok(data.warnings.includes('branch-local'));
  assert.ok(
    (await repo.git.refs()).some((r) => r.refName === 'refs/heads/feat/a'),
    'feat/a survived',
  );
});

test('QA-05: branch-delete-remote refuses the default branch and keeps the remote ref', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo, repoHost('feat/a'));
  t.after(() => h.bridge.dispose());
  const token = (await repo.status()).statusToken;

  const response = await h.webview.send(
    req('actions/git', {
      action: 'branch-delete-remote',
      remote: 'origin',
      branch: 'feat/a',
      statusToken: token,
      idempotencyKey: 'bdr-default',
      confirm: true,
      forceAcknowledgement: true,
    }),
  );
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(response.error.remedies, ['cancel']);
  const remote = await repo.git.run(['ls-remote', '--heads', 'origin']);
  assert.match(remote.stdout, /refs\/heads\/feat\/a$/m, 'the default branch survived on origin');
});

test('QA-05: the merge delete step refuses both local and remote deletion for the default branch', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo, {
    ...writeHost({
      githubPullDetail: () =>
        Promise.resolve({ detail: pullDetail({ headRef: 'feat/a', isFork: false }), rateLimit: RATE_LIMIT }),
      githubMergePullRequest: () => Promise.resolve(MERGED),
    }),
    ...repoHost('feat/a'),
  });
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('github/mergePullRequest', mergePayload({ deleteBranch: true, idempotencyKey: 'm-default-both' })),
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) return;
  const data = response.data as {
    merged: boolean;
    branchDeleted: { local: boolean | null; remote: boolean | null };
    warnings: string[];
  };
  assert.equal(data.merged, true);
  assert.deepEqual(data.branchDeleted, { local: false, remote: false });
  assert.ok(data.warnings.includes('branch-local'));
  assert.ok(data.warnings.includes('branch-remote'));
  assert.ok(
    (await repo.git.refs()).some((r) => r.refName === 'refs/heads/feat/a'),
    'feat/a survived locally',
  );
  const remote = await repo.git.run(['ls-remote', '--heads', 'origin']);
  assert.match(remote.stdout, /refs\/heads\/feat\/a$/m, 'feat/a survived on origin');
});

test('P25: merge with deleteBranch removes local and origin branches and invalidates repo cache', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  let invalidatedBeforeNotify = false;
  let invalidated = 0;
  const origInvalidate = repo.invalidate.bind(repo);
  repo.invalidate = () => {
    invalidated += 1;
    origInvalidate();
  };
  const h = harness(repo, {
    ...writeHost({
      githubPullDetail: () =>
        Promise.resolve({ detail: pullDetail({ headRef: 'feat/a', isFork: false }), rateLimit: RATE_LIMIT }),
      githubMergePullRequest: () => Promise.resolve(MERGED),
    }),
    ...repoHost('main'),
  });
  t.after(() => h.bridge.dispose());
  const origPost = h.webview.postMessage.bind(h.webview);
  h.webview.postMessage = (msg) => {
    if ('kind' in msg && msg.kind === 'event/repoChanged') invalidatedBeforeNotify = invalidated > 0;
    return origPost(msg);
  };

  const response = await h.webview.send(
    req('github/mergePullRequest', mergePayload({ deleteBranch: true, idempotencyKey: 'm-del-ok' })),
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) return;
  const data = response.data as {
    merged: boolean;
    branchDeleted: { local: boolean | null; remote: boolean | null };
    warnings: string[];
  };
  assert.equal(data.merged, true);
  assert.deepEqual(data.branchDeleted, { local: true, remote: true });
  assert.deepEqual(data.warnings, []);
  assert.equal(invalidatedBeforeNotify, true, 'repo cache invalidated before event/repoChanged');
  assert.ok(
    !(await repo.git.refs()).some((r) => r.refName === 'refs/heads/feat/a'),
    'feat/a deleted locally',
  );
  const remote = await repo.git.run(['ls-remote', '--heads', 'origin']);
  assert.doesNotMatch(remote.stdout, /refs\/heads\/feat\/a$/m, 'feat/a deleted on origin');
});

test('P25: merge with deleteBranch on a fork pull request keeps base repo branches untouched', async (t) => {
  const repo = await cleanupRepo();
  t.after(() => cleanup(repo.folderPath));
  const h = harness(repo, {
    ...writeHost({
      githubPullDetail: () =>
        Promise.resolve({ detail: pullDetail({ headRef: 'feat/a', isFork: true }), rateLimit: RATE_LIMIT }),
      githubMergePullRequest: () => Promise.resolve(MERGED),
    }),
    ...repoHost('main'),
  });
  t.after(() => h.bridge.dispose());

  const response = await h.webview.send(
    req('github/mergePullRequest', mergePayload({ deleteBranch: true, idempotencyKey: 'm-del-fork' })),
  );
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) return;
  const data = response.data as {
    merged: boolean;
    branchDeleted: { local: boolean | null; remote: boolean | null };
    warnings: string[];
  };
  assert.equal(data.merged, true);
  assert.deepEqual(data.branchDeleted, { local: false, remote: false });
  assert.ok(data.warnings.includes('branch-local'));
  assert.ok(data.warnings.includes('branch-remote'));
  assert.ok(
    (await repo.git.refs()).some((r) => r.refName === 'refs/heads/feat/a'),
    'local branch with colliding name survived',
  );
  const remote = await repo.git.run(['ls-remote', '--heads', 'origin']);
  assert.match(remote.stdout, /refs\/heads\/feat\/a$/m, 'origin branch with colliding name survived');
});

test('QA-06: merge and close broadcast pullRequestsChanged and merge broadcasts repoChanged across webviews', async (t) => {
  const repoBroadcasts: string[] = [];
  const prBroadcasts: unknown[] = [];
  const h = harness(null, {
    ...writeHost({
      githubMergePullRequest: () => Promise.resolve(MERGED),
      githubClosePullRequest: () => Promise.resolve({ closed: true }),
    }),
    broadcastRepoChanged: async (reason) => {
      repoBroadcasts.push(reason);
    },
    broadcastPullRequestsChanged: (event) => {
      prBroadcasts.push(event);
    },
  });
  t.after(() => h.bridge.dispose());

  const merged = await h.webview.send(req('github/mergePullRequest', mergePayload({ idempotencyKey: 'bcast-m' })));
  assert.equal(merged.ok, true);
  assert.deepEqual(repoBroadcasts, ['action'], 'merge broadcasts repoChanged across all webviews');
  assert.deepEqual(prBroadcasts, [{ owner: 'o', repo: 'r', number: 150 }]);

  const closed = await h.webview.send(
    req('github/closePullRequest', { owner: 'o', repo: 'r', number: 151, idempotencyKey: 'bcast-c', confirm: true }),
  );
  assert.equal(closed.ok, true);
  assert.deepEqual(prBroadcasts, [
    { owner: 'o', repo: 'r', number: 150 },
    { owner: 'o', repo: 'r', number: 151 },
  ]);
});

test('QA-06: failed close never broadcasts pullRequestsChanged, and local bridge emits fallback without host hook', async (t) => {
  const h = harness(null, {
    ...writeHost({
      githubClosePullRequest: () => Promise.resolve({ closed: true }),
    }),
  });
  t.after(() => h.bridge.dispose());

  const refused = await h.webview.send(
    req('github/closePullRequest', { owner: 'o', repo: 'r', number: 150, idempotencyKey: 'bcast-refuse' }),
  );
  assert.equal(refused.ok, false);
  assert.equal(
    h.webview.sent.some((m) => 'kind' in m && m.kind === 'event/pullRequestsChanged'),
    false,
    'refused close does not broadcast',
  );

  const ok = await h.webview.send(
    req('github/closePullRequest', { owner: 'o', repo: 'r', number: 150, idempotencyKey: 'bcast-ok', confirm: true }),
  );
  assert.equal(ok.ok, true);
  assert.ok(
    h.webview.sent.some((m) => 'kind' in m && m.kind === 'event/pullRequestsChanged'),
    'standalone bridge falls back to emitting on its own webview',
  );
});

// --------------------------------------------------- P26 issue write actions

test('P26: issue write and label endpoints validate payloads, enforce guard, replay by idempotency key, and report 503 when host method is absent', async (t) => {
  let commentCalls = 0;
  let stateCalls = 0;
  let createCalls = 0;
  let labelCalls = 0;

  const h = harness(null, {
    ...writeHost({}),
    githubCommentIssue: async (p) => {
      commentCalls += 1;
      return { commentId: 100 + p.number, htmlUrl: `https://github.com/${p.owner}/${p.repo}/issues/${p.number}#issuecomment-1` };
    },
    githubSetIssueState: async (p) => {
      stateCalls += 1;
      return { number: p.number, state: p.state };
    },
    githubCreateIssue: async (p) => {
      createCalls += 1;
      return { number: 201, htmlUrl: `https://github.com/${p.owner}/${p.repo}/issues/201` };
    },
    githubRepoLabels: async () => {
      labelCalls += 1;
      return { labels: [{ name: 'bug', colorKey: 'red' }], rateLimit: RATE_LIMIT };
    },
  });
  t.after(() => h.bridge.dispose());

  // Validation rejections (bad owner, bad number, extra fields)
  for (const bad of [
    req('github/commentIssue', { owner: '../x', repo: 'r', number: 97, body: 'hi', idempotencyKey: 'val-1' }),
    req('github/commentIssue', { owner: 'o', repo: 'r', number: 0, body: 'hi', idempotencyKey: 'val-2' }),
    req('github/commentIssue', { owner: 'o', repo: 'r', number: 97, body: 'hi', extra: true, idempotencyKey: 'val-3' }),
    req('github/setIssueState', { owner: 'o', repo: 'r', number: 97, state: 'invalid', idempotencyKey: 'val-4' }),
    req('github/setIssueState', { owner: 'o', repo: 'r', number: 97, state: 'closed', extra: 1, idempotencyKey: 'val-5' }),
    req('github/createIssue', { owner: 'o', repo: 'r', title: '  ', body: '', labels: [], idempotencyKey: 'val-6' }),
    req('github/createIssue', { owner: 'o', repo: 'r', title: 'T', body: '', labels: ['dup', 'dup'], idempotencyKey: 'val-7' }),
    req('github/createIssue', { owner: 'o', repo: 'r', title: 'T', body: '', labels: [], extra: 1, idempotencyKey: 'val-8' }),
    req('github/repoLabels', { owner: 'o', repo: 'r', extra: 1 }),
  ]) {
    const res = await h.webview.send(bad);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(commentCalls + stateCalls + createCalls + labelCalls, 0, 'invalid payloads never reach host');

  // Happy paths + idempotency replay
  const c1 = await h.webview.send(
    req('github/commentIssue', { owner: 'o', repo: 'r', number: 97, body: 'First comment', idempotencyKey: 'ci-1' }),
  );
  const c2 = await h.webview.send(
    req('github/commentIssue', { owner: 'o', repo: 'r', number: 97, body: 'First comment', idempotencyKey: 'ci-1' }),
  );
  assert.equal(c1.ok, true);
  assert.deepEqual(c1.ok ? c1.data : null, c2.ok ? c2.data : null);
  assert.equal(commentCalls, 1, 'comment replayed on same idempotencyKey');

  const s1 = await h.webview.send(
    req('github/setIssueState', { owner: 'o', repo: 'r', number: 97, state: 'closed', idempotencyKey: 'si-1' }),
  );
  const s2 = await h.webview.send(
    req('github/setIssueState', { owner: 'o', repo: 'r', number: 97, state: 'closed', idempotencyKey: 'si-1' }),
  );
  assert.equal(s1.ok, true);
  assert.deepEqual(s1.ok ? s1.data : null, { number: 97, state: 'closed' });
  assert.deepEqual(s2.ok ? s2.data : null, { number: 97, state: 'closed' });
  assert.equal(stateCalls, 1, 'setIssueState replayed on same idempotencyKey');

  const sOpen = await h.webview.send(
    req('github/setIssueState', { owner: 'o', repo: 'r', number: 97, state: 'open', idempotencyKey: 'si-2' }),
  );
  assert.equal(sOpen.ok, true);
  assert.deepEqual(sOpen.ok ? sOpen.data : null, { number: 97, state: 'open' });
  assert.equal(stateCalls, 2);

  const cr1 = await h.webview.send(
    req('github/createIssue', { owner: 'o', repo: 'r', title: 'New bug', body: 'Desc', labels: ['bug'], idempotencyKey: 'cr-1' }),
  );
  const cr2 = await h.webview.send(
    req('github/createIssue', { owner: 'o', repo: 'r', title: 'New bug', body: 'Desc', labels: ['bug'], idempotencyKey: 'cr-1' }),
  );
  assert.equal(cr1.ok, true);
  assert.deepEqual(cr1.ok ? cr1.data : null, cr2.ok ? cr2.data : null);
  assert.equal(createCalls, 1, 'createIssue replayed on same idempotencyKey');

  const lb = await h.webview.send(req('github/repoLabels', { owner: 'o', repo: 'r' }));
  assert.equal(lb.ok, true);
  assert.equal(labelCalls, 1);

  // 503 UNAVAILABLE when host method is missing
  const noHost = harness(null, writeHost({}));
  t.after(() => noHost.bridge.dispose());
  for (const missing of [
    req('github/commentIssue', { owner: 'o', repo: 'r', number: 97, body: 'hi', idempotencyKey: 'nh-1' }),
    req('github/setIssueState', { owner: 'o', repo: 'r', number: 97, state: 'closed', idempotencyKey: 'nh-2' }),
    req('github/createIssue', { owner: 'o', repo: 'r', title: 'T', body: '', labels: [], idempotencyKey: 'nh-3' }),
    req('github/repoLabels', { owner: 'o', repo: 'r' }),
  ]) {
    const res = await noHost.webview.send(missing);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.status, 503);
      assert.equal(res.error.code, 'UNAVAILABLE');
    }
  }
});

// ------------------------------------------------ P27 actions write actions

function sampleRun(overrides: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo {
  return {
    id: 482,
    workflowId: 10,
    name: 'CI',
    title: 'CI #482',
    runNumber: 482,
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    branch: 'main',
    sha: 'a'.repeat(40),
    url: 'https://github.com/o/r/actions/runs/482',
    createdAt: '2026-11-20T10:00:00Z',
    startedAt: '2026-11-20T10:00:05Z',
    updatedAt: '2026-11-20T10:01:00Z',
    attempt: 1,
    ...overrides,
  };
}

function sampleWorkflow(overrides: Partial<WorkflowInfo> = {}): WorkflowInfo {
  return {
    id: 10,
    name: 'Release',
    path: '.github/workflows/release.yml',
    state: 'active',
    ...overrides,
  };
}

test('P27: rerunFailedJobs checks fresh run status and conclusion, enforces validation/idempotency/503', async (t) => {
  let currentRun = sampleRun({ status: 'in_progress', conclusion: null });
  let runCalls = 0;
  let rerunCalls = 0;

  const h = harness(null, {
    ...writeHost({
      githubActionsRun: async () => {
        runCalls += 1;
        return { data: currentRun, rateLimit: RATE_LIMIT, cached: false };
      },
      githubRerunFailed: async () => {
        rerunCalls += 1;
        return { requested: true };
      },
    }),
  });
  t.after(() => h.bridge.dispose());

  // Invalid payloads rejected before any host lookup
  for (const bad of [
    req('github/rerunFailedJobs', { owner: '../x', repo: 'r', runId: 482, idempotencyKey: 'rr-bad-1' }),
    req('github/rerunFailedJobs', { owner: 'o', repo: 'r', runId: 0, idempotencyKey: 'rr-bad-2' }),
    req('github/rerunFailedJobs', { owner: 'o', repo: 'r', runId: 482, extra: true, idempotencyKey: 'rr-bad-3' }),
  ]) {
    const res = await h.webview.send(bad);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(runCalls + rerunCalls, 0);

  // In-progress run refused
  const inProg = await h.webview.send(
    req('github/rerunFailedJobs', { owner: 'o', repo: 'r', runId: 482, idempotencyKey: 'rr-inprog' }),
  );
  assert.equal(inProg.ok, false);
  if (!inProg.ok) assert.equal(inProg.error.code, 'VALIDATION_ERROR');
  assert.equal(rerunCalls, 0);

  // Completed successful run refused
  currentRun = sampleRun({ status: 'completed', conclusion: 'success' });
  const successRun = await h.webview.send(
    req('github/rerunFailedJobs', { owner: 'o', repo: 'r', runId: 482, idempotencyKey: 'rr-ok' }),
  );
  assert.equal(successRun.ok, false);
  if (!successRun.ok) assert.equal(successRun.error.code, 'VALIDATION_ERROR');
  assert.equal(rerunCalls, 0);

  // Completed failure, timed_out, and cancelled accepted; same key replays
  for (const [idx, conclusion] of (['failure', 'timed_out', 'cancelled'] as const).entries()) {
    currentRun = sampleRun({ status: 'completed', conclusion });
    const res1 = await h.webview.send(
      req('github/rerunFailedJobs', { owner: 'o', repo: 'r', runId: 482, idempotencyKey: `rr-${conclusion}` }),
    );
    const res2 = await h.webview.send(
      req('github/rerunFailedJobs', { owner: 'o', repo: 'r', runId: 482, idempotencyKey: `rr-${conclusion}` }),
    );
    assert.equal(res1.ok, true, conclusion);
    assert.deepEqual(res1.ok ? res1.data : null, { requested: true });
    assert.deepEqual(res2.ok ? res2.data : null, { requested: true });
    assert.equal(rerunCalls, idx + 1);
  }

  // 503 UNAVAILABLE when host methods absent
  const noHost = harness(null, writeHost({}));
  t.after(() => noHost.bridge.dispose());
  const missRun = await noHost.webview.send(
    req('github/rerunFailedJobs', { owner: 'o', repo: 'r', runId: 482, idempotencyKey: 'rr-miss-1' }),
  );
  assert.equal(missRun.ok, false);
  if (!missRun.ok) {
    assert.equal(missRun.error.status, 503);
    assert.equal(missRun.error.code, 'UNAVAILABLE');
  }

  const missExec = await noHost.webview.send(
    req('github/rerunFailedJobs', { owner: 'o', repo: 'r', runId: 482, idempotencyKey: 'rr-miss-2' }),
  );
  assert.equal(missExec.ok, false);
  if (!missExec.ok) assert.equal(missExec.error.code, 'UNAVAILABLE');

  const onlyLookup = harness(null, writeHost({
    githubActionsRun: async () => ({ data: sampleRun({ conclusion: 'failure' }), rateLimit: RATE_LIMIT, cached: false }),
  }));
  t.after(() => onlyLookup.bridge.dispose());
  const missPost = await onlyLookup.webview.send(
    req('github/rerunFailedJobs', { owner: 'o', repo: 'r', runId: 482, idempotencyKey: 'rr-miss-3' }),
  );
  assert.equal(missPost.ok, false);
  if (!missPost.ok) {
    assert.equal(missPost.error.status, 503);
    assert.equal(missPost.error.code, 'UNAVAILABLE');
  }
});

test('P27: workflowInputs validates, returns parsed:false fallback with https or null webUrl, and requires host method', async (t) => {
  const h = harness(null, {
    ...writeHost({
      githubWorkflowInputs: async (p) => ({
        inputs: [],
        parsed: false,
        webUrl: p.owner === 'nohost' ? null : `https://github.com/${p.owner}/${p.repo}/actions/workflows/release.yml`,
        rateLimit: RATE_LIMIT,
      }),
    }),
  });
  t.after(() => h.bridge.dispose());

  for (const bad of [
    req('github/workflowInputs', { owner: 'o', repo: 'r', workflowId: 0, ref: 'main' }),
    req('github/workflowInputs', { owner: 'o', repo: 'r', workflowId: 10, ref: '-flag' }),
    req('github/workflowInputs', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main', extra: 1 }),
  ]) {
    const res = await h.webview.send(bad);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'VALIDATION_ERROR');
  }

  const withUrl = await h.webview.send(
    req('github/workflowInputs', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main' }),
  );
  assert.equal(withUrl.ok, true);
  if (withUrl.ok) {
    const data = withUrl.data as WorkflowInputsResult;
    assert.equal(data.parsed, false);
    assert.deepEqual(data.inputs, []);
    assert.equal(data.webUrl, 'https://github.com/o/r/actions/workflows/release.yml');
  }

  const withoutUrl = await h.webview.send(
    req('github/workflowInputs', { owner: 'nohost', repo: 'r', workflowId: 10, ref: 'main' }),
  );
  assert.equal(withoutUrl.ok, true);
  if (withoutUrl.ok) {
    const data = withoutUrl.data as WorkflowInputsResult;
    assert.equal(data.parsed, false);
    assert.equal(data.webUrl, null);
  }

  const noHost = harness(null, writeHost({}));
  t.after(() => noHost.bridge.dispose());
  const res = await noHost.webview.send(
    req('github/workflowInputs', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main' }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.status, 503);
    assert.equal(res.error.code, 'UNAVAILABLE');
  }
});

test('P27: dispatchWorkflow enforces confirm, active workflow, branch/inputs validation, 422 message, idempotency, and 503', async (t) => {
  let workflowsList: WorkflowInfo[] = [
    sampleWorkflow({ id: 10, state: 'active' }),
    sampleWorkflow({ id: 20, name: 'Disabled', path: '.github/workflows/off.yml', state: 'disabled_manually' }),
  ];
  let workflowCalls = 0;
  let dispatchCalls = 0;
  let shouldThrow422 = false;
  let seenInputs: Record<string, string> | undefined = { sentinel: 'x' };

  const h = harness(null, {
    ...writeHost({
      githubActionsWorkflows: async () => {
        workflowCalls += 1;
        return { data: workflowsList, rateLimit: RATE_LIMIT, cached: false };
      },
      githubDispatchWorkflow: async (p) => {
        dispatchCalls += 1;
        seenInputs = p.inputs;
        if (shouldThrow422) {
          throw new GitHubError({
            status: 422,
            code: 'VALIDATION_ERROR',
            message: hostText('en').github.inputsNeededOnGitHub,
          });
        }
        return { dispatched: true, at: '2026-11-20T12:00:00.000Z' };
      },
    }),
  });
  t.after(() => h.bridge.dispose());

  // Bad payloads rejected before guard or host lookup
  for (const bad of [
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 10, ref: 'bad ref', confirm: true, idempotencyKey: 'dw-b1' }),
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main', inputs: { '1bad': 'v' }, confirm: true, idempotencyKey: 'dw-b2' }),
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main', extra: 1, confirm: true, idempotencyKey: 'dw-b3' }),
  ]) {
    const res = await h.webview.send(bad);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(workflowCalls + dispatchCalls, 0);

  // Confirm required before checking workflows or dispatching
  const unconfirmed = await h.webview.send(
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main', idempotencyKey: 'dw-conf' }),
  );
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) {
    assert.equal(unconfirmed.error.status, 428);
    assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED');
  }
  assert.equal(workflowCalls + dispatchCalls, 0);

  // Disabled workflow refused
  const disabledRes = await h.webview.send(
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 20, ref: 'main', confirm: true, idempotencyKey: 'dw-off' }),
  );
  assert.equal(disabledRes.ok, false);
  if (!disabledRes.ok) assert.equal(disabledRes.error.code, 'VALIDATION_ERROR');
  assert.equal(dispatchCalls, 0);

  // Unknown workflow refused
  const unknownRes = await h.webview.send(
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 999, ref: 'main', confirm: true, idempotencyKey: 'dw-unk' }),
  );
  assert.equal(unknownRes.ok, false);
  if (!unknownRes.ok) assert.equal(unknownRes.error.code, 'VALIDATION_ERROR');
  assert.equal(dispatchCalls, 0);

  // Dispatch without inputs accepted and replays on double click
  const d1 = await h.webview.send(
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main', confirm: true, idempotencyKey: 'dw-ok-1' }),
  );
  const d2 = await h.webview.send(
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main', confirm: true, idempotencyKey: 'dw-ok-1' }),
  );
  assert.equal(d1.ok, true);
  assert.deepEqual(d1.ok ? d1.data : null, { dispatched: true, at: '2026-11-20T12:00:00.000Z' });
  assert.deepEqual(d2.ok ? d2.data : null, { dispatched: true, at: '2026-11-20T12:00:00.000Z' });
  assert.equal(seenInputs, undefined);
  assert.equal(dispatchCalls, 1, 'double click replays cached outcome');

  // 422 on missing required inputs maps to inputsNeededOnGitHub and VALIDATION_ERROR
  shouldThrow422 = true;
  const err422 = await h.webview.send(
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main', confirm: true, idempotencyKey: 'dw-422' }),
  );
  assert.equal(err422.ok, false);
  if (!err422.ok) {
    assert.equal(err422.error.status, 422);
    assert.equal(err422.error.code, 'VALIDATION_ERROR');
    assert.equal(err422.error.message, hostText('en').github.inputsNeededOnGitHub);
  }
  shouldThrow422 = false;

  // 503 UNAVAILABLE when host methods absent
  const noHost = harness(null, writeHost({}));
  t.after(() => noHost.bridge.dispose());
  const missWf = await noHost.webview.send(
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main', confirm: true, idempotencyKey: 'dw-miss-1' }),
  );
  assert.equal(missWf.ok, false);
  if (!missWf.ok) {
    assert.equal(missWf.error.status, 503);
    assert.equal(missWf.error.code, 'UNAVAILABLE');
  }

  const onlyWf = harness(null, writeHost({
    githubActionsWorkflows: async () => ({ data: workflowsList, rateLimit: RATE_LIMIT, cached: false }),
  }));
  t.after(() => onlyWf.bridge.dispose());
  const missPost = await onlyWf.webview.send(
    req('github/dispatchWorkflow', { owner: 'o', repo: 'r', workflowId: 10, ref: 'main', confirm: true, idempotencyKey: 'dw-miss-2' }),
  );
  assert.equal(missPost.ok, false);
  if (!missPost.ok) {
    assert.equal(missPost.error.status, 503);
    assert.equal(missPost.error.code, 'UNAVAILABLE');
  }
});

// ------------------------------------------------- P28 tag-create and tag-push

test('actions/git tag-create creates tag, invalidates refs, and rejects duplicate with VALIDATION_ERROR', async (t) => {
  const dir = await makeFixture('tags');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  // Duplicate tag fails with VALIDATION_ERROR and detail 'name'
  const dup = await h.webview.send(
    req('actions/git', {
      action: 'tag-create',
      name: 'v1.0.0',
      target: 'main',
      idempotencyKey: 'tc-dup-1',
    }),
  );
  assert.equal(dup.ok, false);
  if (!dup.ok) {
    assert.equal(dup.error.code, 'VALIDATION_ERROR');
    assert.equal(dup.error.detail, 'name');
  }

  // Creating a new annotated tag succeeds and updates refs
  const created = await h.webview.send(
    req('actions/git', {
      action: 'tag-create',
      name: 'v1.2.0',
      target: 'main',
      message: 'Release v1.2.0',
      annotated: true,
      idempotencyKey: 'tc-ok-1',
    }),
  );
  assert.equal(created.ok, true);
  assert.equal(await repo.git.tagExists('v1.2.0'), true);
  const refs = await repo.refs();
  assert.ok(refs.refs.some((r) => r.kind === 'tag' && r.shortName === 'v1.2.0'));
});

test('actions/git tag-push requires confirmation and replays idempotently', async (t) => {
  const dir = await makeFixture('tags');
  t.after(() => cleanup(dir));
  const store = new MemoryStore();
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store });
  await repo.markFetched(Date.now());
  const h = harness(repo);
  t.after(() => h.bridge.dispose());

  await repo.git.createTag('v2.0.0', 'main', { message: 'v2.0.0' });

  // Unconfirmed push returns level 1 CONFIRMATION_REQUIRED
  const unconfirmed = await h.webview.send(
    req('actions/git', {
      action: 'tag-push',
      remote: 'origin',
      name: 'v2.0.0',
      idempotencyKey: 'tp-1',
    }),
  );
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) {
    assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(unconfirmed.error.confirmationLevel, 1);
  }

  // Confirmed push succeeds and replays on same idempotencyKey
  let pushCalls = 0;
  const origPushTag = repo.git.pushTag.bind(repo.git);
  repo.git.pushTag = async (remote, name, onProgress) => {
    pushCalls += 1;
    return origPushTag(remote, name, onProgress);
  };

  const p1 = await h.webview.send(
    req('actions/git', {
      action: 'tag-push',
      remote: 'origin',
      name: 'v2.0.0',
      confirm: true,
      idempotencyKey: 'tp-2',
    }),
  );
  const p2 = await h.webview.send(
    req('actions/git', {
      action: 'tag-push',
      remote: 'origin',
      name: 'v2.0.0',
      confirm: true,
      idempotencyKey: 'tp-2',
    }),
  );
  assert.equal(p1.ok, true);
  assert.equal(p2.ok, true);
  assert.equal(pushCalls, 1, 'second call replays idempotently');

  const lsRemote = (await repo.git.run(['ls-remote', '--tags', 'origin', 'refs/tags/v2.0.0'])).stdout.trim();
  assert.match(lsRemote, /refs\/tags\/v2\.0\.0$/);
});

test('P28: github/releaseNotes validates, gates on GitHub auth/scope without confirm, and delegates to host', async (t) => {
  let called = 0;
  const h = harness(
    null,
    writeHost({
      githubReleaseNotes: async (p) => {
        called += 1;
        return { name: p.tag, body: '## Notes', rateLimit: RATE_LIMIT };
      },
    }),
  );
  t.after(() => h.bridge.dispose());

  // Invalid tag rejected before host call
  const bad = await h.webview.send(req('github/releaseNotes', { owner: 'o', repo: 'r', tag: '-bad' }));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'VALIDATION_ERROR');
  assert.equal(called, 0);

  // Valid request runs without confirmation
  const ok = await h.webview.send(
    req('github/releaseNotes', { owner: 'o', repo: 'r', tag: 'v2.8.0', previousTag: 'v2.7.0', target: 'main' }),
  );
  assert.equal(ok.ok, true);
  assert.equal(called, 1);
  assert.deepEqual(ok.ok ? ok.data : null, { name: 'v2.8.0', body: '## Notes', rateLimit: RATE_LIMIT });

  // Missing host method returns 503 UNAVAILABLE
  const missing = harness(null, writeHost({}));
  t.after(() => missing.bridge.dispose());
  const unavailable = await missing.webview.send(req('github/releaseNotes', { owner: 'o', repo: 'r', tag: 'v2.8.0' }));
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) {
    assert.equal(unavailable.error.status, 503);
    assert.equal(unavailable.error.code, 'UNAVAILABLE');
  }
});

test('P28: github/createRelease enforces level 1 confirm, validates payload, and replays idempotently', async (t) => {
  let calls = 0;
  const h = harness(
    null,
    writeHost({
      githubCreateRelease: async (p) => {
        calls += 1;
        return { id: 77, htmlUrl: `https://github.com/${p.owner}/${p.repo}/releases/tag/${p.tag}` };
      },
    }),
  );
  t.after(() => h.bridge.dispose());

  const base = {
    owner: 'o',
    repo: 'r',
    tag: 'v2.8.0',
    name: 'v2.8.0',
    body: '## Notes',
    prerelease: false,
    target: 'main',
  };

  // Unconfirmed blocked with level 1 CONFIRMATION_REQUIRED
  const unconfirmed = await h.webview.send(req('github/createRelease', { ...base, idempotencyKey: 'cr-1' }));
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) {
    assert.equal(unconfirmed.error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(unconfirmed.error.confirmationLevel, 1);
  }
  assert.equal(calls, 0);

  // Confirmed succeeds and double-click with same idempotencyKey replays once
  const r1 = await h.webview.send(req('github/createRelease', { ...base, confirm: true, idempotencyKey: 'cr-2' }));
  const r2 = await h.webview.send(req('github/createRelease', { ...base, confirm: true, idempotencyKey: 'cr-2' }));
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(calls, 1, 'double click replays cached outcome');
  assert.deepEqual(r1.ok ? r1.data : null, { id: 77, htmlUrl: 'https://github.com/o/r/releases/tag/v2.8.0' });
});
