/**
 * Bridge wiring for creating a pull request (P22).
 *
 * The interesting cases are all about order and restraint: a publish that fails
 * must stop before any API call, an existing pull request must short-circuit the
 * POST, and two submits with the same key must produce one pull request. The
 * harness is the shared real-git fixture, so the push half is a real push.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitHubError } from '../src/github';
import { makeRepo } from './fixture';
import type { PrPrepareResult } from '../src/messages';

const RATE = { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false };

/** A repository with a bare origin and an unpublished branch carrying three commits. */
async function repoWithUnpublishedBranch(t: { after(fn: () => unknown): void }) {
  const repo = await makeRepo({ remote: true });
  t.after(() => repo.cleanup());
  await repo.git.createBranch('feat/three', 'main');
  for (const n of ['one', 'two', 'three']) {
    await fs.writeFile(path.join(repo.dir, `feat-${n}.txt`), `${n}\n`, 'utf8');
    await repo.git.stage([`feat-${n}.txt`]);
    await repo.git.commit(`add feat ${n}`);
  }
  return repo;
}

function prepareResult(overrides: Partial<PrPrepareResult> = {}): PrPrepareResult {
  return {
    head: 'feat/three',
    base: 'main',
    bases: ['main'],
    heads: ['feat/three'],
    onRemote: false,
    ahead: 3,
    files: 3,
    commits: [
      { hash: 'a'.repeat(40), subject: 'add feat one' },
      { hash: 'b'.repeat(40), subject: 'add feat two' },
      { hash: 'c'.repeat(40), subject: 'add feat three' },
    ],
    template: null,
    draft: { title: 'Three', body: '- add feat one\n- add feat two\n- add feat three' },
    existing: null,
    connected: true,
    canWrite: 'yes',
    collaboratorsAvailable: true,
    ...overrides,
  };
}

const WRITE_CTX = {
  connected: true,
  scopes: ['repo'],
  tokenAllowed: true,
  circuitOpen: false,
};

test('prepare reports the branch, the range, and the remote state in one response', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  const h = repo.harness({
    host: {
      githubWriteContext: async () => WRITE_CTX,
      githubPrPrepare: async () => prepareResult(),
      githubCreatePullRequest: async () => {
        throw new Error('not used');
      },
      githubPrReviewers: async () => ({ logins: [], available: true }),
    },
  });
  t.after(() => h.dispose());

  const response = await h.send('github/prPrepare', { owner: 'o', repo: 'r' });
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const data = response.data as PrPrepareResult;
  assert.equal(data.head, 'feat/three');
  assert.equal(data.onRemote, false);
  assert.equal(data.ahead, 3);
});

test('prepare rejects a base that is not a branch name, before the host sees it', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  let reached = 0;
  const h = repo.harness({
    host: {
      githubPrPrepare: async () => {
        reached += 1;
        return prepareResult();
      },
    },
  });
  t.after(() => h.dispose());

  const response = await h.send('github/prPrepare', { owner: 'o', repo: 'r', base: '-x' });
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'VALIDATION_ERROR');
  assert.equal(response.error.detail, 'base');
  assert.equal(reached, 0);
});

test('a publish that the guard refuses makes no API call at all', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  let created = 0;
  const h = repo.harness({
    host: {
      // A read-only token: the GitHub guard refuses before anything else runs.
      githubWriteContext: async () => ({ ...WRITE_CTX, scopes: ['read:user'] }),
      githubCreatePullRequest: async () => {
        created += 1;
        return { number: 1, url: 'u', published: true, reviewersFailed: [], rateLimit: RATE };
      },
    },
  });
  t.after(() => h.dispose());

  const response = await h.send('github/createPullRequest', {
    owner: 'o',
    repo: 'r',
    base: 'main',
    head: 'feat/three',
    title: 'Three',
    body: '',
    draft: false,
    reviewers: [],
    publish: true,
    idempotencyKey: 'k-refused',
  });
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'FORBIDDEN');
  assert.equal(created, 0, 'no request left the host');
  assert.equal(h.log.count('push'), 0, 'nothing was pushed either');
});

test('a publish-then-create needs confirm, and the confirmed retry pushes then creates', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  const order: string[] = [];
  const h = repo.harness({
    host: {
      githubWriteContext: async () => WRITE_CTX,
      githubCreatePullRequest: async () => {
        order.push('create');
        return { number: 154, url: 'https://github.com/o/r/pull/154', published: true, reviewersFailed: [], rateLimit: RATE };
      },
    },
  });
  t.after(() => h.dispose());

  const payload = {
    owner: 'o',
    repo: 'r',
    base: 'main',
    head: 'feat/three',
    title: 'Three',
    body: '',
    draft: false,
    reviewers: [],
    publish: true,
    idempotencyKey: 'k-publish',
  };
  const blocked = await h.send('github/createPullRequest', payload);
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(blocked.error.confirmationLevel, 1);
  assert.equal(h.log.count('push'), 0, 'the refusal did not push');

  const confirmed = await h.send('github/createPullRequest', { ...payload, confirm: true });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;

  // The push happened before the create, and the branch is now on the remote.
  assert.deepEqual(order, ['create']);
  const pushLines = h.log.of('push');
  assert.equal(pushLines.length, 1);
  assert.match(pushLines[0] as string, /--set-upstream/);
  assert.doesNotMatch(pushLines[0] as string, /--force|\s\+/, 'never a force push');
  const refs = new Set((await repo.git.refs()).map((ref) => ref.refName));
  assert.ok(refs.has('refs/remotes/origin/feat/three'), 'the branch reached origin with tracking');

  const data = confirmed.data as { number: number; published: boolean };
  assert.equal(data.number, 154);
  assert.equal(data.published, true);
});

test('a request that is already on the remote does not push again', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  await repo.git.push({ remote: 'origin', refspec: 'feat/three:feat/three', setUpstream: true });
  const h = repo.harness({
    host: {
      githubWriteContext: async () => WRITE_CTX,
      githubCreatePullRequest: async () => ({
        number: 155,
        url: 'u',
        published: false,
        reviewersFailed: [],
        rateLimit: RATE,
      }),
    },
  });
  t.after(() => h.dispose());

  h.log.clear();
  const response = await h.send('github/createPullRequest', {
    owner: 'o',
    repo: 'r',
    base: 'main',
    head: 'feat/three',
    title: 'Three',
    body: '',
    draft: false,
    reviewers: [],
    publish: true,
    idempotencyKey: 'k-remote',
    confirm: true,
  });
  assert.equal(response.ok, true);
  assert.equal(h.log.count('push'), 0, 'an already published branch is not pushed twice');
});

test('an existing open pull request surfaces as CONFLICT and never pushes', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  const h = repo.harness({
    host: {
      githubWriteContext: async () => WRITE_CTX,
      // The host callback owns the pre-check, so it is the one that raises.
      githubCreatePullRequest: async () => {
        throw new GitHubError({
          status: 409,
          code: 'CONFLICT',
          message: 'A pull request already exists for this branch.',
          detail: '154',
        });
      },
    },
  });
  t.after(() => h.dispose());

  const response = await h.send('github/createPullRequest', {
    owner: 'o',
    repo: 'r',
    base: 'main',
    head: 'feat/three',
    title: 'Three',
    body: '',
    draft: false,
    reviewers: [],
    publish: false,
    idempotencyKey: 'k-exists',
  });
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'CONFLICT');
  assert.equal(response.error.detail, '154', 'the number travels in detail so the dialog can link it');
  assert.equal(h.log.count('push'), 0);
});

test('two submits with one key create exactly one pull request', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  let created = 0;
  const h = repo.harness({
    host: {
      githubWriteContext: async () => WRITE_CTX,
      githubCreatePullRequest: async () => {
        created += 1;
        return { number: 200, url: 'u', published: false, reviewersFailed: [], rateLimit: RATE };
      },
    },
  });
  t.after(() => h.dispose());

  const payload = {
    owner: 'o',
    repo: 'r',
    base: 'main',
    head: 'feat/three',
    title: 'Three',
    body: '',
    draft: false,
    reviewers: [],
    publish: false,
    idempotencyKey: 'k-once',
  };
  const first = await h.send('github/createPullRequest', payload);
  const second = await h.send('github/createPullRequest', payload);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(created, 1, 'the second send replayed the first outcome');
  if (!first.ok || !second.ok) return;
  assert.deepEqual(second.data, first.data);
});

test('reviewers are validated and capped before the host sees them', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  let reached = 0;
  const h = repo.harness({
    host: {
      githubWriteContext: async () => WRITE_CTX,
      githubCreatePullRequest: async () => {
        reached += 1;
        return { number: 1, url: 'u', published: false, reviewersFailed: [], rateLimit: RATE };
      },
    },
  });
  t.after(() => h.dispose());

  const response = await h.send('github/createPullRequest', {
    owner: 'o',
    repo: 'r',
    base: 'main',
    head: 'feat/three',
    title: 'Three',
    body: '',
    draft: false,
    reviewers: ['bad login'],
    publish: false,
    idempotencyKey: 'k-bad-reviewer',
  });
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.detail, 'reviewers');
  assert.equal(reached, 0);
});

test('prReviewers reaches the host and reports UNAVAILABLE without one', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  const withHost = repo.harness({
    host: { githubPrReviewers: async () => ({ logins: ['ann'], available: true }) },
  });
  t.after(() => withHost.dispose());
  const ok = await withHost.send('github/prReviewers', { owner: 'o', repo: 'r' });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.data, { logins: ['ann'], available: true });

  const without = repo.harness({ host: {} });
  t.after(() => without.dispose());
  const missing = await without.send('github/prReviewers', { owner: 'o', repo: 'r' });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.error.code, 'UNAVAILABLE');
});

// ------------------------------------- P23: the read-only branch must hold here

/**
 * The publish push is a push from the current branch, and a branch checked out
 * from a fork pull request is read only. The guard for that lives in the git
 * guard, which this path never ran, so the promise the README makes was only
 * kept on the ordinary push button.
 *
 * The refusal is host-side and derived from the repository's own record, not
 * from a flag the webview sends: a caller that omits `readOnly` must not be able
 * to publish a branch the host already knows is read only.
 */
test('a publish from a read-only branch is refused before any push', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  let created = 0;
  const h = repo.harness({
    host: {
      githubWriteContext: async () => WRITE_CTX,
      githubCreatePullRequest: async () => {
        created += 1;
        return { number: 1, url: 'u', published: true, reviewersFailed: [], rateLimit: RATE };
      },
    },
  });
  t.after(() => h.dispose());
  // Marked through the harness's own service, which is the one the bridge reads.
  await h.repo.markReadOnlyBranch('feat/three');

  const response = await h.send('github/createPullRequest', {
    owner: 'o',
    repo: 'r',
    base: 'main',
    head: 'feat/three',
    title: 'Three',
    body: '',
    draft: false,
    reviewers: [],
    publish: true,
    confirm: true,
    idempotencyKey: 'k-read-only',
  });
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'FORBIDDEN');
  assert.deepEqual(response.error.remedies, ['cancel']);
  assert.equal(created, 0, 'no request left the host');
  assert.equal(h.log.count('push'), 0, 'nothing was pushed');
});

test('a publish from an ordinary branch is still allowed', async (t) => {
  const repo = await repoWithUnpublishedBranch(t);
  let created = 0;
  const h = repo.harness({
    host: {
      githubWriteContext: async () => WRITE_CTX,
      githubCreatePullRequest: async () => {
        created += 1;
        return { number: 1, url: 'u', published: true, reviewersFailed: [], rateLimit: RATE };
      },
    },
  });
  t.after(() => h.dispose());

  const response = await h.send('github/createPullRequest', {
    owner: 'o',
    repo: 'r',
    base: 'main',
    head: 'feat/three',
    title: 'Three',
    body: '',
    draft: false,
    reviewers: [],
    publish: true,
    confirm: true,
    idempotencyKey: 'k-normal',
  });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(created, 1);
  assert.equal(h.log.count('push'), 1, 'the branch was published');
});
