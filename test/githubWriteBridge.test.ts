/**
 * P19 T09/T10/T11: the bridge half of the write path.
 *
 * No GitHub mutation kind ships in this phase (each endpoint lands in P22 to
 * P28), so `gateGitHub` is exercised directly through its shape: what matters
 * here is that the verdict is enforced host-side and that a request without
 * `confirm` can never reach GitHub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageBridge, type BridgeHost, type WebviewLike } from '../src/bridge';
import { GITHUB_MUTATION_KINDS, MUTATION_KINDS, idempotencyKeyOf } from '../src/bridgePure';
import { hostText } from '../src/hostText';
import { Logger, type LogSink } from '../src/logger';
import { RepositoryService, type PersistentStore } from '../src/repository';
import type { GitHubGuardContext } from '../src/githubGuard';
import { cleanup, makeFixture } from './repoFixture';
import type { ErrorBody, HostMessage, Request, Response, SettingsSnapshot } from '../src/messages';

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

class NullSink implements LogSink {
  appendLine(): void {
    /* discard */
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

class FakeWebview implements WebviewLike {
  readonly sent: HostMessage[] = [];
  private listener: ((message: unknown) => void) | undefined;

  postMessage(message: HostMessage): Thenable<boolean> {
    this.sent.push(message);
    return Promise.resolve(true);
  }

  onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void } {
    this.listener = listener;
    return { dispose: () => undefined };
  }

  async send(request: Request, attempts = 1500): Promise<Response> {
    const before = this.sent.length;
    this.listener?.(request);
    for (let i = 0; i < attempts; i += 1) {
      const found = this.sent.slice(before).find((m): m is Response => 'id' in m && m.id === request.id);
      if (found !== undefined) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no response for ${request.kind}`);
  }
}

/** Shape of the private gate, so the policy can be exercised without a wire kind. */
interface GateSurface {
  gateGitHub(
    action: { action: string; [key: string]: unknown },
    meta: { idempotencyKey: string; confirm?: boolean; forceAcknowledgement?: boolean },
  ): Promise<void>;
}

function gater(bridge: MessageBridge): GateSurface {
  return bridge as unknown as GateSurface;
}

const CONNECTED: GitHubGuardContext = {
  connected: true,
  scopes: ['repo'],
  tokenAllowed: true,
  circuitOpen: false,
};

function harness(overrides: Partial<BridgeHost> = {}): { bridge: MessageBridge; webview: FakeWebview } {
  const webview = new FakeWebview();
  const host: BridgeHost = {
    logger: new Logger(new NullSink()),
    resolveRepository: () => Promise.resolve(null),
    settings: () => SETTINGS,
    setUiPreference: () => Promise.resolve(SETTINGS),
    githubAuth: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
    connectGitHub: () => Promise.resolve({ connected: true, login: null, scopes: [] }),
    disconnectGitHub: () => Promise.resolve({ connected: false, login: null, scopes: [] }),
    githubWriteContext: () => Promise.resolve(CONNECTED),
    ...overrides,
  };
  return { bridge: new MessageBridge(webview, host), webview };
}

/** Run the gate and return the error body it threw, or null when it allowed. */
async function blocked(host: Partial<BridgeHost>, action: { action: string; [k: string]: unknown }, meta = {}): Promise<ErrorBody | null> {
  const h = harness(host);
  try {
    await gater(h.bridge).gateGitHub(action, { idempotencyKey: 'k1', ...meta });
    return null;
  } catch (err) {
    const body = (err as { body?: ErrorBody }).body;
    assert.ok(body !== undefined, 'the gate throws a structured bridge error');
    return body;
  } finally {
    h.bridge.dispose();
  }
}

const MERGE = { action: 'merge-pull-request', method: 'merge' } as const;

// -------------------------------------------------------------------- policy

test('a disconnected client is refused with 401 before anything is sent', async () => {
  const body = await blocked({ githubWriteContext: () => Promise.resolve({ ...CONNECTED, connected: false }) }, MERGE);
  assert.ok(body !== null);
  assert.equal(body.status, 401);
  assert.equal(body.code, 'AUTH_ERROR');
  assert.equal(body.message, hostText('en').github.notConnected);
  assert.deepEqual(body.remedies, ['cancel']);
});

test('an untrusted API base is refused with 403', async () => {
  const body = await blocked({ githubWriteContext: () => Promise.resolve({ ...CONNECTED, tokenAllowed: false }) }, MERGE);
  assert.ok(body !== null);
  assert.equal(body.status, 403);
  assert.equal(body.code, 'FORBIDDEN');
  assert.equal(body.message, hostText('en').github.tokenNotTrusted);
});

test('an open breaker is refused with 503 and says the change was not sent', async () => {
  const body = await blocked({ githubWriteContext: () => Promise.resolve({ ...CONNECTED, circuitOpen: true }) }, MERGE);
  assert.ok(body !== null);
  assert.equal(body.status, 503);
  assert.equal(body.code, 'UNAVAILABLE');
  assert.equal(body.message, hostText('en').github.writeUnavailable);
});

test('a token without the write scope is refused with 403 naming the scope', async () => {
  const body = await blocked({ githubWriteContext: () => Promise.resolve({ ...CONNECTED, scopes: ['read:user'] }) }, MERGE);
  assert.ok(body !== null);
  assert.equal(body.status, 403);
  assert.equal(body.code, 'FORBIDDEN');
  assert.equal(body.message, hostText('en').github.missingScope('repo'));
});

test('a host that cannot answer the write context fails closed with 503', async () => {
  const body = await blocked({ githubWriteContext: undefined }, MERGE);
  assert.ok(body !== null);
  assert.equal(body.status, 503);
  assert.equal(body.code, 'UNAVAILABLE');
});

test('the gate speaks the configured language', async () => {
  const body = await blocked(
    {
      settings: () => ({ ...SETTINGS, language: 'id' }),
      githubWriteContext: () => Promise.resolve({ ...CONNECTED, connected: false }),
    },
    MERGE,
  );
  assert.ok(body !== null);
  assert.equal(body.message, hostText('id').github.notConnected);
});

// -------------------------------------------------------------- confirmation

test('a level 1 action without confirm is refused with 428 and its level', async () => {
  const body = await blocked({}, MERGE);
  assert.ok(body !== null);
  assert.equal(body.status, 428);
  assert.equal(body.code, 'CONFIRMATION_REQUIRED');
  assert.equal(body.requiresConfirmation, true);
  assert.equal(body.confirmationLevel, 1);
  assert.equal(body.risk, 'medium');
  assert.deepEqual(body.remedies, ['confirm', 'cancel']);
});

test('the same request passes once it carries confirm: true', async () => {
  const body = await blocked({}, MERGE, { confirm: true });
  assert.equal(body, null);
});

test('confirm alone never unblocks a level 2 verdict', async () => {
  // No level 2 GitHub action exists yet; the shared confirmation rule is what
  // P22 to P28 inherit, so prove it here rather than assume it.
  const body = await blocked({}, MERGE, { confirm: true });
  assert.equal(body, null, 'level 1 is satisfied by confirm alone');

  const h = harness();
  try {
    const verdict = { allow: false as const, code: 'CONFIRMATION_REQUIRED' as const, message: 'x', remedies: ['confirm' as const], requiresConfirmation: true, confirmationLevel: 2 as const };
    const confirmed = (h.bridge as unknown as {
      confirmed(v: typeof verdict, meta: { idempotencyKey: string; confirm?: boolean; forceAcknowledgement?: boolean }): boolean;
    }).confirmed(verdict, { idempotencyKey: 'k', confirm: true });
    assert.equal(confirmed, false, 'level 2 needs forceAcknowledgement');
    const forced = (h.bridge as unknown as {
      confirmed(v: typeof verdict, meta: { idempotencyKey: string; confirm?: boolean; forceAcknowledgement?: boolean }): boolean;
    }).confirmed(verdict, { idempotencyKey: 'k', confirm: true, forceAcknowledgement: true });
    assert.equal(forced, true);
  } finally {
    h.bridge.dispose();
  }
});

test('an allowed action passes the gate with no flags at all', async () => {
  const body = await blocked({}, { action: 'comment' });
  assert.equal(body, null);
});

// ------------------------------------------------------------- kind registry

test('the mutation kind set is exported once and keeps the three git kinds', () => {
  for (const kind of ['actions/stage', 'actions/commit', 'actions/git']) {
    assert.ok(MUTATION_KINDS.has(kind), kind);
  }
});

test('the GitHub mutation set exists and is empty until the endpoint phases land', () => {
  assert.ok(GITHUB_MUTATION_KINDS instanceof Set);
  assert.equal(GITHUB_MUTATION_KINDS.size, 0);
  for (const kind of GITHUB_MUTATION_KINDS) assert.ok(!MUTATION_KINDS.has(kind), 'the two sets stay disjoint');
});

test('a read kind with an idempotency key still yields no key', () => {
  const request = {
    id: '1',
    kind: 'github/pullRequests',
    payload: { owner: 'o', repo: 'r', idempotencyKey: 'ignored' },
  } as unknown as Request;
  assert.equal(idempotencyKeyOf(request), null);
});

// ------------------------------------------------------- concurrent joining

test('two concurrent mutations with one key reach git once and share the outcome', async (t) => {
  const dir = await makeFixture('single');
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store: new MemoryStore() });

  let commits = 0;
  const realCommit = repo.git.commit.bind(repo.git);
  repo.git.commit = async (message: string): Promise<string | null> => {
    commits += 1;
    return realCommit(message);
  };

  const h = harness({ resolveRepository: () => Promise.resolve(repo) });
  t.after(() => h.bridge.dispose());

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.writeFile(path.join(dir, 'join.txt'), 'x\n', 'utf8');
  await repo.git.stage(['join.txt']);
  repo.invalidate();
  const token = (await repo.status()).statusToken;

  const payload = { message: 'joined commit', statusToken: token, idempotencyKey: 'join-1' };
  const [first, second] = await Promise.all([
    h.webview.send({ id: 'j1', kind: 'actions/commit', payload } as unknown as Request),
    h.webview.send({ id: 'j2', kind: 'actions/commit', payload } as unknown as Request),
  ]);

  assert.equal(commits, 1, 'the second caller joins the first instead of running git again');
  assert.equal(first.ok, second.ok);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(second.data, first.data, 'both callers receive the same outcome');
});
