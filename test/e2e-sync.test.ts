/**
 * PRD sync/push safety cases 1-4, driven end to end through the real
 * `MessageBridge` against real git repositories and a real bare remote.
 *
 *   Kasus 1 (Tinggi)  concurrent commit: an external commit lands while the UI
 *                     holds an older status.
 *   Kasus 2 (Tinggi)  double-click push: two identical requests, one idempotency
 *                     key, exactly one `git push` process.
 *   Kasus 3 (Tinggi)  remote ahead at push: blocked, incoming reported, fetch
 *                     offered, force never offered anywhere.
 *   Kasus 4 (Kritis)  partial push that is not fast-forward: NON_FAST_FORWARD and
 *                     a bit-identical remote ref before and after.
 *
 * Nothing here mocks git. The assertions that matter are made against the
 * repository and the bare remote themselves, not against response shapes: a
 * response can be wrong in a way that is still safe, and a response can be right
 * while the remote moved anyway. Both are checked separately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { makeRepo, type Harness, type TestRepo } from './fixture';
import type { ErrorBody, HostMessage } from '../src/messages';

/** Argv fragments that would mean this extension can rewrite published history. */
const FORCE_MARKERS = ['--force', '--force-with-lease', '-f'];

/** Every response body in a flow, so a whole flow can be swept for force offers. */
function bodies(posted: readonly HostMessage[]): ErrorBody[] {
  const out: ErrorBody[] = [];
  for (const message of posted) {
    if ('ok' in message && message.ok === false) out.push(message.error);
  }
  return out;
}

/**
 * Assert that nothing in this flow offered, constructed, or hinted at a force
 * push. Covers both directions: what the UI was told it may do, and what argv the
 * product actually built.
 */
function assertNoForceAnywhere(h: Harness): void {
  for (const body of bodies(h.posted)) {
    const remedies = body.remedies ?? [];
    assert.ok(
      !remedies.some((r) => String(r).includes('force')),
      `remedies must never offer force: ${JSON.stringify(remedies)}`,
    );
    const text = `${body.message} ${body.detail ?? ''}`;
    assert.ok(!/--force/.test(text), `no response text may suggest --force: ${text}`);
  }
  for (const line of h.log.lines) {
    const args = line.split(' ');
    for (const marker of FORCE_MARKERS) {
      assert.ok(!args.includes(marker), `argv must never contain ${marker}: git ${line}`);
    }
    // A refspec beginning with `+` is a force update spelled differently.
    for (const arg of args) {
      assert.ok(!arg.startsWith('+'), `argv must never carry a '+' refspec: git ${line}`);
    }
  }
}

/** Register cleanup for a fixture and its harness. */
function own(t: { after(fn: () => unknown): void }, repo: TestRepo, h?: Harness): void {
  t.after(() => {
    h?.dispose();
    return repo.cleanup();
  });
}

// ------------------------------------------------------------------- Kasus 1

test('Kasus 1: a commit carrying a stale statusToken is rejected and the external commit survives', async (t) => {
  const repo = await makeRepo({ commits: 1, label: 'k1-stale' });
  const h = repo.harness();
  own(t, repo, h);

  // The UI reads a status and holds on to its token.
  const first = await h.send('repos/status', {});
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const staleToken = (first.data as { statusToken: string }).statusToken;
  const baseHead = (first.data as { head: string }).head;

  // An external writer — a separate git invocation, not this bridge — commits.
  await fs.writeFile(path.join(repo.dir, 'external.txt'), 'external work\n', 'utf8');
  await repo.git.stage(['external.txt']);
  const external = (await repo.git.commit('external commit')) as string;
  assert.notEqual(external, baseHead);

  // What `RepoWatcher.onChange` does when it sees `.git` move.
  h.repo.invalidate();

  // Our own staged work, so the commit would otherwise be perfectly valid.
  await fs.writeFile(path.join(repo.dir, 'ours.txt'), 'ours\n', 'utf8');
  await repo.git.stage(['ours.txt']);
  h.repo.invalidate();

  const rejected = await h.send('actions/commit', {
    message: 'commit computed against a status that has moved on',
    statusToken: staleToken,
    idempotencyKey: 'k1-commit',
  });
  assert.equal(rejected.ok, false, 'a token from before the external commit must not be honoured');
  if (rejected.ok) return;
  assert.equal(rejected.error.status, 409);
  assert.equal(rejected.error.code, 'CONFLICT');
  assert.deepEqual(rejected.error.remedies, ['cancel']);

  // The external commit is untouched: still HEAD, still its own content.
  assert.equal(await repo.git.headHash(), external, 'the external commit is still HEAD');
  assert.equal(await repo.git.showFile(external, 'external.txt'), 'external work\n');
  assert.equal((await repo.git.log({ limit: 1, all: false }))[0]?.subject, 'external commit');

  // And a refreshed status is obtainable, carrying the live token.
  const refreshed = await h.send('repos/status', {});
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  const live = refreshed.data as { statusToken: string; head: string };
  assert.equal(live.head, external);
  assert.notEqual(live.statusToken, staleToken);
  assertNoForceAnywhere(h);
});

test('Kasus 1: a commit rebuilt from live state builds ON the external commit, never over it', async (t) => {
  const repo = await makeRepo({ commits: 1, label: 'k1-rebuild' });
  const h = repo.harness();
  own(t, repo, h);

  // Stage our work through the bridge, the way the panel does.
  await fs.writeFile(path.join(repo.dir, 'ours.txt'), 'ours\n', 'utf8');
  const staged = await h.send('actions/stage', {
    paths: ['ours.txt'],
    stage: true,
    statusToken: '',
    idempotencyKey: 'k1b-stage',
  });
  assert.equal(staged.ok, true);

  // The external writer commits only its own path, leaving our index entry alone.
  // A pathspec-limited commit is exactly what a terminal user doing `git commit
  // external.txt` produces, and it keeps `ours.txt` staged.
  await fs.writeFile(path.join(repo.dir, 'external.txt'), 'external work\n', 'utf8');
  await repo.git.stage(['external.txt']);
  await repo.git.run(['commit', '-F', '-', '--', 'external.txt'], { input: 'external commit' });
  const external = (await repo.git.headHash()) as string;

  // The UI refreshes (the watcher fired) and retries with the live token.
  h.repo.invalidate();
  const live = await h.send('repos/status', {});
  assert.equal(live.ok, true);
  if (!live.ok) return;
  const token = (live.data as { statusToken: string }).statusToken;

  const committed = await h.send('actions/commit', {
    message: 'our commit on top of theirs',
    statusToken: token,
    idempotencyKey: 'k1b-commit',
  });
  assert.equal(committed.ok, true);
  if (!committed.ok) return;
  const result = committed.data as { commit: string | null };
  assert.ok(result.commit !== null);

  // The external commit is the parent, so its work is preserved, not replaced.
  const meta = await repo.git.commitMeta(result.commit as string);
  assert.deepEqual(meta?.parents, [external], 'the external commit must remain in the history');
  assert.equal(await repo.git.showFile('HEAD', 'external.txt'), 'external work\n');
  assert.equal(await repo.git.showFile('HEAD', 'ours.txt'), 'ours\n');
  assertNoForceAnywhere(h);
});

// ------------------------------------------------------------------- Kasus 2

test('Kasus 2: two identical push requests in the same tick run exactly one git push', async (t) => {
  const repo = await makeRepo({ commits: 1, remote: true, label: 'k2-double' });
  const h = repo.harness();
  own(t, repo, h);

  await repo.chain(1, 'ahead');
  h.repo.invalidate();
  // Fresh fetch clock so the guard lets the push through to git.
  await h.repo.markFetched(Date.now());
  const beforeRemote = await repo.remoteHash();
  h.log.clear();

  const payload = { action: 'push', remote: 'origin', branch: repo.branch, idempotencyKey: 'k2-key' };
  // Delivered back to back with no await between them: microseconds apart, well
  // inside the PRD's 100 ms double-click window.
  const a = h.request('actions/git', payload);
  const b = h.request('actions/git', payload);
  const [first, second] = await Promise.all([h.deliver(a), h.deliver(b)]);

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));
  if (!first.ok || !second.ok) return;
  assert.deepEqual(second.data, first.data, 'the duplicate returns the first outcome');
  assert.equal(h.log.count('push'), 1, `PRD Kasus 2: one git push process, saw: ${h.log.of('push').join(' | ')}`);

  // The push really happened, once.
  const afterRemote = await repo.remoteHash();
  assert.notEqual(afterRemote, beforeRemote);
  assert.equal(afterRemote, await repo.git.headHash());
  assertNoForceAnywhere(h);
});

test('Kasus 2: shouldRemember still replays a completed successful push under the same key', async (t) => {
  const repo = await makeRepo({ commits: 1, remote: true, label: 'k2-replay' });
  const h = repo.harness();
  own(t, repo, h);

  await repo.chain(1, 'ahead');
  h.repo.invalidate();
  await h.repo.markFetched(Date.now());
  h.log.clear();

  const payload = { action: 'push', remote: 'origin', branch: repo.branch, idempotencyKey: 'k2-seq' };
  // Sequential this time: the first has completed and been remembered before the
  // second arrives. This is the path `shouldRemember` decides, and a success must
  // still be cached — excluding guard rejections must not have weakened it.
  const first = await h.send('actions/git', payload);
  const second = await h.send('actions/git', payload);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(second.data, first.data);
  assert.equal(h.log.count('push'), 1, 'a remembered success is replayed, not re-pushed');
  assertNoForceAnywhere(h);
});

// ------------------------------------------------------------------- Kasus 3

test('Kasus 3: a remote that gained a commit blocks push, reports incoming, and offers only fetch', async (t) => {
  const repo = await makeRepo({ commits: 1, remote: true, label: 'k3-ahead' });
  const h = repo.harness();
  own(t, repo, h);

  // Another writer pushes to the shared remote after our last fetch.
  const other = await repo.cloneFromRemote('k3-other');
  await other.chain(1, 'theirs');
  await other.git.push({ remote: 'origin', refspec: `${other.branch}:${other.branch}` });
  const remoteTip = await repo.remoteHash();

  // Our own commit, so we are genuinely diverged rather than merely behind.
  await repo.chain(1, 'ours');
  h.repo.invalidate();

  // Learn about the remote through the product's own fetch, which also stamps the
  // fetch clock — otherwise the guard would stop at STALE_STATUS instead.
  const fetched = await h.send('actions/git', { action: 'fetch', idempotencyKey: 'k3-fetch' });
  assert.equal(fetched.ok, true);
  h.repo.invalidate();

  const status = await h.repo.status();
  assert.equal(status.behind, 1, 'the remote is one commit ahead');
  assert.equal(status.incoming, 1, 'incoming mirrors behind, which is what the UI renders');
  assert.equal(status.ahead, 1);

  h.log.clear();
  const blocked = await h.send('actions/git', {
    action: 'push',
    remote: 'origin',
    branch: repo.branch,
    idempotencyKey: 'k3-push',
  });
  assert.equal(blocked.ok, false, 'pushing over a remote that moved must be refused');
  if (blocked.ok) return;
  assert.equal(blocked.error.code, 'REMOTE_AHEAD');
  assert.equal(blocked.error.status, 409);
  assert.deepEqual(blocked.error.remedies, ['fetch'], 'fetch and integrate; never force');
  assert.equal(h.log.count('push'), 0, 'git push never ran');

  // The remote is exactly where the other writer left it.
  assert.equal(await repo.remoteHash(), remoteTip);
  assertNoForceAnywhere(h);
});

// ------------------------------------------------------------------- Kasus 4

test('Kasus 4: push-up-to a diverged hash is NON_FAST_FORWARD and the remote ref is byte-identical', async (t) => {
  const repo = await makeRepo({ commits: 1, remote: true, label: 'k4-diverged' });
  const h = repo.harness();
  own(t, repo, h);

  const other = await repo.cloneFromRemote('k4-other');
  await other.chain(1, 'theirs');
  await other.git.push({ remote: 'origin', refspec: `${other.branch}:${other.branch}` });

  const [ours] = await repo.chain(1, 'ours');
  h.repo.invalidate();
  const fetched = await h.send('actions/git', { action: 'fetch', idempotencyKey: 'k4-fetch' });
  assert.equal(fetched.ok, true);
  h.repo.invalidate();

  const remoteRefBefore = await repo.remoteHash();
  const remoteFileBefore = await fs.readFile(
    path.join(repo.remoteDir as string, 'packed-refs'),
    'utf8',
  ).catch(() => '');
  h.log.clear();

  const response = await h.send('actions/git', {
    action: 'push-up-to',
    remote: 'origin',
    branch: repo.branch,
    hash: ours as string,
    confirm: true,
    idempotencyKey: 'k4-partial',
  });
  assert.equal(response.ok, false, 'a partial push that is not linear with the remote must be refused');
  if (response.ok) return;
  assert.equal(response.error.code, 'NON_FAST_FORWARD');
  assert.equal(response.error.status, 409);
  assert.deepEqual(response.error.remedies, ['fetch']);
  assert.equal(h.log.count('push'), 0, 'git push never ran');

  // The highest-severity assertion of the four: the remote is untouched.
  const remoteRefAfter = await repo.remoteHash();
  assert.equal(remoteRefAfter, remoteRefBefore, 'the remote ref must be byte-identical');
  assert.equal(
    await fs.readFile(path.join(repo.remoteDir as string, 'packed-refs'), 'utf8').catch(() => ''),
    remoteFileBefore,
  );
  // Their commit is still reachable from the remote branch.
  const bareLog = await other.git.run(['ls-remote', 'origin', `refs/heads/${repo.branch}`]);
  assert.ok(bareLog.stdout.includes(remoteRefBefore));
  assertNoForceAnywhere(h);
});

test('Kasus 4: with a stale tracking ref git itself refuses the partial push and the remote is untouched', async (t) => {
  const repo = await makeRepo({ commits: 1, remote: true, label: 'k4-stale-ref' });
  const h = repo.harness();
  own(t, repo, h);

  const other = await repo.cloneFromRemote('k4b-other');
  await other.chain(1, 'theirs');
  await other.git.push({ remote: 'origin', refspec: `${other.branch}:${other.branch}` });

  // Deliberately do NOT fetch. `refs/remotes/origin/<branch>` still points at the
  // shared base, so `behind` reads 0 and the bridge's own linearity pre-check sees
  // a perfectly fast-forwardable push. This is the documented fallthrough: the
  // pre-check works on the last data we have, and when that data is stale git's own
  // fast-forward rule is what has to hold. This test pins that it does.
  await repo.chain(1, 'ours');
  const diverged = await repo.fork('sideline');
  h.repo.invalidate();
  await h.repo.markFetched(Date.now());

  const remoteRefBefore = await repo.remoteHash();
  h.log.clear();

  const response = await h.send('actions/git', {
    action: 'push-up-to',
    remote: 'origin',
    branch: repo.branch,
    hash: diverged,
    confirm: true,
    idempotencyKey: 'k4b-partial',
  });
  assert.equal(response.ok, false, 'a push that is not linear with the real remote must fail');
  if (response.ok) return;
  assert.equal(response.error.code, 'NON_FAST_FORWARD', 'classified from git stderr, not guessed');
  assert.deepEqual(response.error.remedies, ['fetch']);
  assert.equal(h.log.count('push'), 1, 'git was asked, and git said no');

  // What actually matters: the attempt changed nothing.
  assert.equal(await repo.remoteHash(), remoteRefBefore, 'the remote ref is byte-identical');
  assertNoForceAnywhere(h);
});

test('Kasus 4: push-up-to a hash that fast-forwards the remote succeeds and moves the ref', async (t) => {
  const repo = await makeRepo({ commits: 1, remote: true, label: 'k4-ff' });
  const h = repo.harness();
  own(t, repo, h);

  // Two local commits ahead of the remote. `mid` is a strict descendant of the
  // remote tip, so pushing up to it is a textbook fast-forward.
  const [mid] = await repo.chain(2, 'ff');
  h.repo.invalidate();
  await h.repo.markFetched(Date.now());

  const remoteBefore = await repo.remoteHash();
  assert.notEqual(remoteBefore, mid);
  h.log.clear();

  const response = await h.send('actions/git', {
    action: 'push-up-to',
    remote: 'origin',
    branch: repo.branch,
    hash: mid as string,
    confirm: true,
    idempotencyKey: 'k4c-ff',
  });
  assert.equal(response.ok, true, `a fast-forward partial push must succeed: ${JSON.stringify(response)}`);
  assert.equal(await repo.remoteHash(), mid, 'the remote ref advances to exactly the requested commit');
  assert.equal(h.log.count('push'), 1);
  assertNoForceAnywhere(h);
});

// -------------------------------------------------------- guard push path e2e

test('the push guard walks stale -> remote ahead -> clean fast-forward, and only the last moves the remote', async (t) => {
  const repo = await makeRepo({ commits: 1, remote: true, label: 'guard-push' });
  const h = repo.harness();
  own(t, repo, h);

  await repo.chain(1, 'local');
  h.repo.invalidate();

  // 1. Never fetched: STALE_STATUS, remedy fetch.
  const stale = await h.send('actions/git', {
    action: 'push',
    remote: 'origin',
    branch: repo.branch,
    idempotencyKey: 'gp-stale',
  });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.error.code, 'STALE_STATUS');
  assert.equal(stale.error.status, 412);
  assert.deepEqual(stale.error.remedies, ['fetch']);
  assert.equal(h.log.count('push'), 0);

  // 2. Remote moves, we fetch, so freshness passes and REMOTE_AHEAD takes over.
  const other = await repo.cloneFromRemote('gp-other');
  await other.chain(1, 'theirs');
  await other.git.push({ remote: 'origin', refspec: `${other.branch}:${other.branch}` });
  const theirTip = await repo.remoteHash();

  assert.equal((await h.send('actions/git', { action: 'fetch', idempotencyKey: 'gp-fetch' })).ok, true);
  h.repo.invalidate();

  const ahead = await h.send('actions/git', {
    action: 'push',
    remote: 'origin',
    branch: repo.branch,
    idempotencyKey: 'gp-ahead',
  });
  assert.equal(ahead.ok, false);
  if (ahead.ok) return;
  assert.equal(ahead.error.code, 'REMOTE_AHEAD');
  assert.deepEqual(ahead.error.remedies, ['fetch']);
  assert.equal(h.log.count('push'), 0, 'still no push attempt');
  assert.equal(await repo.remoteHash(), theirTip, 'nothing was pushed while blocked');

  // 3. Integrate their commit, which makes us a pure fast-forward, then push.
  await repo.git.merge(`origin/${repo.branch}`);
  h.repo.invalidate();
  await h.repo.markFetched(Date.now());
  const cleanStatus = await h.repo.status();
  assert.equal(cleanStatus.behind, 0, 'merged, so nothing is incoming any more');

  const ok = await h.send('actions/git', {
    action: 'push',
    remote: 'origin',
    branch: repo.branch,
    idempotencyKey: 'gp-ok',
  });
  assert.equal(ok.ok, true, `a clean fast-forward must be allowed: ${JSON.stringify(ok)}`);
  assert.equal(h.log.count('push'), 1, 'exactly one push, on the only attempt that was allowed');
  assert.equal(await repo.remoteHash(), await repo.git.headHash(), 'the bare remote ref really moved');
  assert.ok(await repo.git.isAncestor(theirTip, (await repo.git.headHash()) as string));
  assertNoForceAnywhere(h);
});
