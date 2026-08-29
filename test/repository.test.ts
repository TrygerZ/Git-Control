import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitRunner } from '../src/git';
import { RepositoryService, type PersistentStore } from '../src/repository';

/** `workspaceState` stand-in so the service can be exercised without vscode. */
class MemoryStore implements PersistentStore {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

/** Windows keeps `.git` handles briefly after git exits; retry the rmdir. */
function cleanup(dir: string): Promise<void> {
  return fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Temp repo with three commits on `main` plus one on a side branch. */
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-control-repo-'));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  await git.run(['init', '--quiet', '--initial-branch=main']);
  await git.run(['config', 'user.email', 'test@example.com']);
  await git.run(['config', 'user.name', 'Test User']);
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

function service(dir: string, overrides: { commitLimit?: number; pageSize?: number } = {}): RepositoryService {
  return new RepositoryService({
    folderPath: dir,
    gitPath: 'git',
    store: new MemoryStore(),
    ...overrides,
  });
}

test('status reports branch, cleanliness, and a stable token', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = service(dir);

  const clean = await repo.status();
  assert.equal(clean.branch, 'main');
  assert.equal(clean.detached, false);
  assert.equal(clean.dirty, false);
  assert.equal(clean.staged, false);
  assert.equal(clean.operation, 'idle');
  assert.equal(clean.upstream, null);
  assert.deepEqual([clean.incoming, clean.outgoing], [clean.behind, clean.ahead]);
  assert.equal(clean.lastFetchAt, null);
  assert.equal(clean.lastFetchedAt, null);
  assert.equal(clean.conflicts.length, 0);

  // Cached until invalidated, so the token cannot drift mid-request.
  assert.equal((await repo.status()).statusToken, clean.statusToken);

  await fs.writeFile(path.join(dir, 'dirty.txt'), 'x\n', 'utf8');
  repo.invalidate();
  const dirty = await repo.status();
  assert.equal(dirty.dirty, true);
  assert.notEqual(dirty.statusToken, clean.statusToken);
  assert.deepEqual(dirty.changes.map((c) => [c.path, c.untracked]), [['dirty.txt', true]]);
});

test('markFetched persists the fetch clock and invalidates status', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const store = new MemoryStore();
  const repo = new RepositoryService({ folderPath: dir, gitPath: 'git', store });

  assert.equal(repo.lastFetchAt(), null);
  await repo.markFetched(1_700_000_000_000);
  assert.equal(repo.lastFetchAt(), 1_700_000_000_000);

  const status = await repo.status();
  assert.equal(status.lastFetchAt, 1_700_000_000_000);
  assert.equal(status.lastFetchedAt, new Date(1_700_000_000_000).toISOString());

  // A second service over the same store sees the timestamp: survives reload.
  const reloaded = new RepositoryService({ folderPath: dir, gitPath: 'git', store });
  assert.equal(reloaded.lastFetchAt(), 1_700_000_000_000);
});

test('graph lays out every commit and reports no next page', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = service(dir);

  const graph = await repo.graph({ limit: 50 });
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.truncated, false);
  assert.equal(graph.nextCursor, null);
  assert.equal(graph.stale, false);
  assert.ok(graph.nodes.some((n) => n.isHead));
  assert.ok(graph.nodes.every((n) => n.subject.length > 0 && n.shortHash.length > 0));
  // No remotes, so every commit is local-only.
  assert.ok(graph.nodes.every((n) => n.local));
  assert.ok(graph.refs.some((r) => r.shortName === 'main' && r.kind === 'local'));
});

test('graph paginates via nextCursor and stops at the commit limit', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = service(dir, { pageSize: 2, commitLimit: 3 });

  const first = await repo.graph({});
  assert.equal(first.nodes.length, 2);
  assert.equal(first.nextCursor, 2);
  assert.equal(first.truncated, false);

  // Page two hits the 3-commit cap: one row, truncated, no further cursor.
  const second = await repo.graph({ cursor: first.nextCursor ?? 0 });
  assert.equal(second.nodes.length, 1);
  assert.equal(second.truncated, true);
  assert.equal(second.nextCursor, null);
});

test('graph replays the last good snapshot as stale after a failure', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = service(dir);

  const good = await repo.graph({ limit: 10 });
  assert.equal(good.stale, false);

  // Simulate git becoming unavailable (repo deleted, disk gone, no network).
  repo.git.log = (): Promise<never> => Promise.reject(new Error('git unavailable'));
  const fallback = await repo.graph({ limit: 10 });
  assert.equal(fallback.stale, true);
  assert.deepEqual(fallback.nodes.map((n) => n.hash), good.nodes.map((n) => n.hash));
});

test('graph rethrows when there is no cached snapshot to fall back to', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = service(dir);
  repo.git.log = (): Promise<never> => Promise.reject(new Error('git unavailable'));
  await assert.rejects(() => repo.graph({ limit: 10 }), /git unavailable/);
});

test('commitDetail returns metadata, files, and totals', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = service(dir);
  const head = (await repo.status()).head as string;

  const detail = await repo.commitDetail(head);
  assert.ok(detail !== null);
  if (detail === null) return;
  assert.equal(detail.subject, 'add three');
  assert.equal(detail.parents.length, 1);
  assert.deepEqual(detail.files.map((f) => f.path), ['three.txt']);
  assert.deepEqual(detail.totals, { files: 1, additions: 1, deletions: 0, binary: 0 });
  assert.equal(detail.truncated, false);

  assert.equal(await repo.commitDetail('0'.repeat(40)), null);
});

test('commitDetail lists every parent of a merge commit', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  await git.merge('side', { noFf: true });

  const repo = service(dir);
  const head = (await repo.status()).head as string;
  const detail = await repo.commitDetail(head);
  assert.ok(detail !== null);
  if (detail === null) return;
  assert.equal(detail.parents.length, 2);
});

test('commitDetail marks binary files and omits their line counts', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 7]));
  await git.stage(['blob.bin']);
  await git.commit('add binary blob');

  const repo = service(dir);
  const head = (await repo.status()).head as string;
  const detail = await repo.commitDetail(head);
  const entry = detail?.files.find((f) => f.path === 'blob.bin');
  assert.ok(entry !== undefined);
  assert.equal(entry?.binary, true);
  assert.equal(entry?.additions, null);
  assert.equal(entry?.deletions, null);
  assert.equal(detail?.totals.binary, 1);
});

test('commitDetail truncates an oversized file list', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  const names = ['f1.txt', 'f2.txt', 'f3.txt'];
  for (const name of names) await fs.writeFile(path.join(dir, name), 'x\n', 'utf8');
  await git.stage(names);
  await git.commit('add three files');

  const repo = new RepositoryService({
    folderPath: dir,
    gitPath: 'git',
    store: new MemoryStore(),
    fileLimit: 2,
  });
  const head = (await repo.status()).head as string;
  const detail = await repo.commitDetail(head);
  assert.equal(detail?.files.length, 2);
  assert.equal(detail?.truncated, true);
  // Totals still count every file, even the ones not listed.
  assert.equal(detail?.totals.files, 3);
});

test('changes derives conflict entries during a merge', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  // Same file, divergent content on both branches.
  await fs.writeFile(path.join(dir, 'clash.txt'), 'main\n', 'utf8');
  await git.stage(['clash.txt']);
  await git.commit('main side of clash');
  await git.switchBranch('side');
  await fs.writeFile(path.join(dir, 'clash.txt'), 'side\n', 'utf8');
  await git.stage(['clash.txt']);
  await git.commit('side side of clash');
  await git.switchBranch('main');
  await assert.rejects(() => git.merge('side'));

  const repo = service(dir);
  assert.equal(await repo.git.operationState(), 'merge');
  const { conflicts } = await repo.changes();
  assert.deepEqual(conflicts.map((c) => c.path), ['clash.txt']);
  const status = await repo.status();
  assert.equal(status.operation, 'merge');
  assert.equal(status.conflicts.length, 1);
});
