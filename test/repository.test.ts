import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitRunner } from '../src/git';
import { MAX_STAT_ENTRIES, RepositoryService, type PersistentStore } from '../src/repository';
import { cleanup, makeFixture } from './repoFixture';

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

/** Temp repo with three commits on `main` plus one on a side branch. */
function makeRepo(): Promise<string> {
  return makeFixture('triple');
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

/**
 * The panel shows churn per file, so `status` has to carry it. `null` and `0` are
 * different answers: an untracked file is in no diff at all, and rendering it as
 * `+0` would claim the new file is empty.
 */
test('status carries per-file line counts, summing staged and unstaged hunks', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  await fs.writeFile(path.join(dir, 'tracked.txt'), 'a\nb\nc\n', 'utf8');
  await git.stage(['tracked.txt']);
  await git.commit('add tracked file');

  // Stage one added line, then leave a second one unstaged in the same file.
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'a\nb\nc\nstaged\n', 'utf8');
  await git.stage(['tracked.txt']);
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'a\nb\nc\nstaged\nunstaged\n', 'utf8');
  await fs.writeFile(path.join(dir, 'brand-new.txt'), 'x\n', 'utf8');

  const repo = service(dir);
  const status = await repo.status();
  const tracked = status.changes.find((c) => c.path === 'tracked.txt');
  assert.equal(tracked?.additions, 2, 'staged + unstaged additions');
  assert.equal(tracked?.deletions, 0);
  assert.equal(tracked?.binary, false);

  const untracked = status.changes.find((c) => c.path === 'brand-new.txt');
  assert.equal(untracked?.untracked, true);
  assert.equal(untracked?.additions, null, 'never diffed, so never counted');
  assert.equal(untracked?.deletions, null);
});

test('status reports a binary change without inventing line counts', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 7]));
  await git.stage(['blob.bin']);
  await git.commit('add binary blob');
  await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 9, 9, 0, 1, 2, 3]));

  const repo = service(dir);
  const entry = (await repo.status()).changes.find((c) => c.path === 'blob.bin');
  assert.equal(entry?.binary, true);
  assert.equal(entry?.additions, null);
  assert.equal(entry?.deletions, null);
});

/**
 * A count the host never computed must be announced, not implied. The panel draws
 * a dash for a missing count, and a dash reads as "unchanged" unless the status
 * says the numbers are incomplete — which is exactly the case once the change list
 * grows past MAX_STAT_ENTRIES and the two `git diff --numstat` runs are skipped.
 */
test('status flags churn as truncated when the change list is too large to count', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));

  const writes: Promise<void>[] = [];
  for (let i = 0; i <= MAX_STAT_ENTRIES; i += 1) {
    writes.push(fs.writeFile(path.join(dir, `bulk-${String(i).padStart(5, '0')}.txt`), `${i}\n`, 'utf8'));
  }
  await Promise.all(writes);

  const status = await service(dir).status();
  assert.ok(status.changes.length > MAX_STAT_ENTRIES, 'the guard is actually engaged');
  assert.equal(status.churnTruncated, true);
});

/** Nothing changed is not the same as something uncounted: a clean tree is complete. */
test('status does not flag churn as truncated when there is nothing to count', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));

  const clean = await service(dir).status();
  assert.equal(clean.changes.length, 0);
  assert.equal(clean.churnTruncated, false);

  await fs.writeFile(path.join(dir, 'small.txt'), 'x\n', 'utf8');
  const small = await service(dir).status();
  assert.equal(small.changes.length, 1);
  assert.equal(small.churnTruncated, false, 'a countable list is complete');
});

test('markFetched persists the fetch clock and invalidates status', async (t) => {  const dir = await makeRepo();
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
  assert.equal(detail?.fileCursor, 0);
  assert.equal(detail?.nextFileCursor, 2);
});

test('commitDetail pages a truncated file list through fileCursor', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });
  const names = ['p1.txt', 'p2.txt', 'p3.txt', 'p4.txt', 'p5.txt'];
  for (const name of names) await fs.writeFile(path.join(dir, name), 'x\n', 'utf8');
  await git.stage(names);
  await git.commit('add five files');

  const repo = new RepositoryService({
    folderPath: dir,
    gitPath: 'git',
    store: new MemoryStore(),
    fileLimit: 2,
  });
  const head = (await repo.status()).head as string;

  const first = await repo.commitDetail(head);
  assert.equal(first?.files.length, 2);
  assert.equal(first?.truncated, true);
  assert.equal(first?.nextFileCursor, 2);

  const second = await repo.commitDetail(head, { fileCursor: first?.nextFileCursor ?? 0 });
  assert.equal(second?.files.length, 2);
  assert.equal(second?.fileCursor, 2);
  assert.equal(second?.truncated, true);
  assert.equal(second?.nextFileCursor, 4);

  const third = await repo.commitDetail(head, { fileCursor: second?.nextFileCursor ?? 0 });
  assert.equal(third?.files.length, 1);
  assert.equal(third?.truncated, false);
  assert.equal(third?.nextFileCursor, null);

  // Pages are disjoint and cover the whole commit in order.
  const paths = [
    ...(first?.files ?? []),
    ...(second?.files ?? []),
    ...(third?.files ?? []),
  ].map((f) => f.path);
  assert.equal(new Set(paths).size, 5);
  assert.deepEqual(paths, ['p1.txt', 'p2.txt', 'p3.txt', 'p4.txt', 'p5.txt']);
  // Totals describe the commit, not the page.
  assert.equal(third?.totals.files, 5);
});

test('commitDetail caches per cursor and normalizes a bad cursor to zero', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const repo = new RepositoryService({
    folderPath: dir,
    gitPath: 'git',
    store: new MemoryStore(),
    fileLimit: 1,
  });
  const head = (await repo.status()).head as string;

  const zero = await repo.commitDetail(head, { fileCursor: 0 });
  const negative = await repo.commitDetail(head, { fileCursor: -5 });
  assert.deepEqual(negative, zero);

  // A cursor past the end yields an empty, non-truncated page.
  const past = await repo.commitDetail(head, { fileCursor: 99 });
  assert.equal(past?.files.length, 0);
  assert.equal(past?.truncated, false);
  assert.equal(past?.nextFileCursor, null);
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

test('refs/stash is classified as other, never as a branch (Bug 2)', async (t) => {
  const dir = await makeRepo();
  t.after(() => cleanup(dir));
  const git = new GitRunner({ gitPath: 'git', cwd: dir });

  // A real stash creates `refs/stash`, which `git for-each-ref` lists alongside
  // branches. It is a real commit, so it may be drawn - but it is not a branch.
  await fs.writeFile(path.join(dir, 'one.txt'), 'stashed\n', 'utf8');
  await git.stashPush('wip');

  const repo = service(dir);
  const graph = await repo.graph({ limit: 50 });
  const stash = graph.refs.find((r) => r.refName === 'refs/stash');
  assert.ok(stash !== undefined, 'refs/stash is present in the ref list');
  assert.equal(stash.kind, 'other');
  assert.equal(stash.shortName, 'stash');

  // Nothing under refs/heads is affected.
  assert.ok(graph.refs.some((r) => r.shortName === 'main' && r.kind === 'local'));
  // No pseudo-ref leaks into the local set.
  for (const ref of graph.refs) {
    if (ref.kind === 'local') assert.ok(ref.refName.startsWith('refs/heads/'), ref.refName);
  }
});
