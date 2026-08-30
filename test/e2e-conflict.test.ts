/** PRD Kasus 5-6: conflict resolution and interrupted destructive writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitRunner } from '../src/git';
import { makeRepo, type Harness, type TestRepo } from './fixture';

function own(t: { after(fn: () => unknown): void }, repo: TestRepo, h?: Harness): void {
  t.after(() => {
    h?.dispose();
    return repo.cleanup();
  });
}

async function status(h: Harness): Promise<Record<string, unknown>> {
  const response = await h.send('repos/status', {});
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) throw new Error('status failed');
  return response.data as Record<string, unknown>;
}

function mutation(statusToken: string, key: string, extra: object = {}): object {
  return { statusToken, idempotencyKey: key, ...extra };
}

test('Kasus 5: merge conflict is reported with porcelain code and merge operation state', async (t) => {
  const repo = await makeRepo({ label: 'k5-conflict' });
  const h = repo.harness();
  own(t, repo, h);
  const file = await repo.conflict();

  const current = await status(h);
  assert.equal(current.operation, 'merge');
  assert.deepEqual(current.conflicts, [{ path: file, code: 'UU' }]);

  const merged = await h.send('actions/git', mutation(current.statusToken as string, 'k5-merge', {
    action: 'merge', branch: 'side',
  }));
  assert.equal(merged.ok, false);
  if (!merged.ok) assert.equal(merged.error.code, 'CONFLICT');
});

test('Kasus 5: conflict guard blocks destructive actions and allows resolution actions', async (t) => {
  const repo = await makeRepo({ label: 'k5-guard' });
  const h = repo.harness();
  own(t, repo, h);
  await repo.conflict();
  const current = await status(h);

  for (const [key, action] of [['checkout', { action: 'checkout-branch', branch: 'side' }], ['merge', { action: 'merge', branch: 'side' }], ['reset', { action: 'reset-hard', hash: current.head }]] as const) {
    const response = await h.send('actions/git', mutation(current.statusToken as string, `k5-${key}`, action));
    assert.equal(response.ok, false, `${key} must be blocked`);
    if (!response.ok) assert.equal(response.error.code, 'CONFLICT');
  }

  for (const [key, action] of [['continue', { action: 'merge-continue' }], ['abort', { action: 'merge-abort' }]] as const) {
    // These requests are only checked for guard permission; continue is not run
    // here because the unresolved index must remain intact for the abort check.
    const response = await h.send('actions/git', mutation(current.statusToken as string, `k5-${key}`, action));
    if (response.ok) assert.equal((await status(h)).operation, 'idle');
    else assert.equal(response.error.code, 'SERVER_ERROR');
    if (key === 'abort') assert.equal(response.ok, true);
  }
});

test('Kasus 5: resolved merge continues to idle with two correct parents', async (t) => {
  const repo = await makeRepo({ label: 'k5-resolve' });
  const h = repo.harness();
  own(t, repo, h);
  const file = await repo.conflict();
  const before = await repo.git.headHash() as string;
  const side = await repo.git.run(['rev-parse', 'side']);
  const sideHash = side.stdout.trim();
  await fs.writeFile(path.join(repo.dir, file), 'resolved\n', 'utf8');

  let current = await status(h);
  const staged = await h.send('actions/stage', mutation(current.statusToken as string, 'k5-stage', {
    paths: [file], stage: true,
  }));
  assert.equal(staged.ok, true, JSON.stringify(staged));
  current = await status(h);
  const continued = await h.send('actions/git', mutation(current.statusToken as string, 'k5-continue', {
    action: 'merge-continue',
  }));
  assert.equal(continued.ok, true, JSON.stringify(continued));
  if (!continued.ok) return;
  assert.equal((await status(h)).operation, 'idle');
  const mergeHash = await repo.git.headHash() as string;
  assert.notEqual(mergeHash, before);
  assert.deepEqual((await repo.git.commitMeta(mergeHash))?.parents, [before, sideHash]);
  assert.equal(await repo.git.showFile('HEAD', file), 'resolved\n');
});

test('Kasus 5: merge-abort returns idle and restores the pre-merge HEAD', async (t) => {
  const repo = await makeRepo({ label: 'k5-abort' });
  const h = repo.harness();
  own(t, repo, h);
  await repo.conflict();
  const before = await repo.git.headHash();
  const current = await status(h);
  const aborted = await h.send('actions/git', mutation(current.statusToken as string, 'k5-abort', {
    action: 'merge-abort',
  }));
  assert.equal(aborted.ok, true, JSON.stringify(aborted));
  assert.equal(await repo.git.headHash(), before);
  assert.equal((await status(h)).operation, 'idle');
});

test('Kasus 6: reset-hard requires both confirmations', async (t) => {
  const repo = await makeRepo({ commits: 2, label: 'k6-confirm' });
  const h = repo.harness();
  own(t, repo, h);
  const target = (await repo.git.run(['rev-parse', 'HEAD~1'])).stdout.trim();
  for (const [key, extra] of [['none', {}], ['confirm-only', { confirm: true }] ] as const) {
    const current = await status(h);
    const response = await h.send('actions/git', mutation(current.statusToken as string, `k6-${key}`, {
      action: 'reset-hard', hash: target, ...extra,
    }));
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'CONFIRMATION_REQUIRED');
  }
  const current = await status(h);
  const reset = await h.send('actions/git', mutation(current.statusToken as string, 'k6-confirmed', {
    action: 'reset-hard', hash: target, confirm: true, forceAcknowledgement: true,
  }));
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(await repo.git.headHash(), target);
});

test('Kasus 6: index.lock maps to REPOSITORY_LOCKED, then removal restores writes', async (t) => {
  const repo = await makeRepo({ label: 'k6-lock' });
  const h = repo.harness();
  own(t, repo, h);
  const current = await status(h);
  const gitDir = await repo.git.gitDir();
  const lock = path.join(gitDir, 'index.lock');
  await fs.writeFile(lock, '', 'utf8');
  const blocked = await h.send('actions/git', mutation(current.statusToken as string, 'k6-locked', {
    action: 'merge-abort',
  }));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, 'REPOSITORY_LOCKED');
  await fs.rm(lock);
  await fs.writeFile(path.join(repo.dir, 'recovered.txt'), 'recovered\n', 'utf8');
  const recovered = await h.send('actions/stage', mutation((await status(h)).statusToken as string, 'k6-recovered', {
    paths: ['recovered.txt'], stage: true,
  }));
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
});

test('Kasus 6: timed-out exclusive mutation releases mutex for the next mutation', async (t) => {
  const repo = await makeRepo({ label: 'k6-timeout' });
  own(t, repo);
  const git = new GitRunner({ gitPath: 'git', cwd: repo.dir });
  await assert.rejects(
    git.runExclusive(() => git.run(['status'], { timeoutMs: 0 })),
    (error: { code?: string }) => error.code === 'GIT_TIMEOUT',
  );
  await fs.writeFile(path.join(repo.dir, 'after-timeout.txt'), 'recovered\n', 'utf8');
  await git.stage(['after-timeout.txt']);
  assert.equal((await git.status()).some((entry) => entry.path === 'after-timeout.txt' && entry.staged), true);
});
