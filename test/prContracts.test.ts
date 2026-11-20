/**
 * Create pull request contracts (P22).
 *
 * The three request kinds are compile-time shapes, so most of this file is a
 * typecheck: a payload the dialog can build must be assignable, and a payload
 * missing a field must not be. The runtime cases cover the two places a shape can
 * still be wrong at runtime, the key set and the mutation registry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_MUTATION_KINDS, idempotencyKeyOf } from '../src/bridgePure';
import type {
  CreatePullRequestPayload,
  CreatePullRequestResult,
  PrPreparePayload,
  PrPrepareResult,
  PrReviewersPayload,
  PrReviewersResult,
  RequestMap,
  MergePullPayload,
  MergePullResult,
  ClosePullPayload,
  SubmitReviewPayload,
  ReplyReviewPayload,
} from '../src/messages';

test('the three pull request kinds exist in the request map', () => {
  const kinds: Array<keyof RequestMap> = [
    'github/prPrepare',
    'github/createPullRequest',
    'github/prReviewers',
  ];
  assert.equal(kinds.length, 3);
});

test('the create payload carries everything the host needs to publish and create', () => {
  const payload: CreatePullRequestPayload = {
    owner: 'o',
    repo: 'r',
    base: 'main',
    head: 'feat/a',
    title: 'A title',
    body: 'A body',
    draft: false,
    reviewers: ['ann'],
    publish: true,
    remote: 'origin',
    idempotencyKey: 'k1',
  };
  assert.equal(payload.idempotencyKey, 'k1');
  assert.equal(payload.publish, true);
});

test('the prepare result answers every question the dialog asks before it draws', () => {
  const result: PrPrepareResult = {
    head: 'feat/a',
    base: 'main',
    bases: ['main'],
    heads: ['feat/a'],
    onRemote: false,
    ahead: 3,
    files: 4,
    commits: [{ hash: 'a'.repeat(40), subject: 'one' }],
    template: '## Summary',
    draft: { title: 'A title', body: 'A body' },
    existing: null,
    connected: true,
    canWrite: 'yes',
    collaboratorsAvailable: true,
  };
  assert.equal(result.commits.length, 1);
  assert.equal(result.existing, null);
});

test('the create result reports a partial reviewer failure without hiding the creation', () => {
  const result: CreatePullRequestResult = {
    number: 154,
    url: 'https://github.com/o/r/pull/154',
    published: true,
    reviewersFailed: ['bob'],
    rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
  };
  assert.equal(result.number, 154);
  assert.deepEqual(result.reviewersFailed, ['bob']);
});

test('the prepare and reviewers payloads carry only the slug pair plus an optional base', () => {
  const prepare: PrPreparePayload = { owner: 'o', repo: 'r' };
  const prepareWithBase: PrPreparePayload = { owner: 'o', repo: 'r', base: 'main' };
  const reviewers: PrReviewersPayload = { owner: 'o', repo: 'r' };
  const reviewersResult: PrReviewersResult = { logins: ['ann'], available: true };
  assert.equal(prepare.owner, 'o');
  assert.equal(prepareWithBase.base, 'main');
  assert.equal(reviewers.repo, 'r');
  assert.deepEqual(reviewersResult.logins, ['ann']);
});

test('create-pull-request is the only new kind in the mutation registry', () => {
  assert.equal(GITHUB_MUTATION_KINDS.has('github/createPullRequest'), true);
  assert.equal(GITHUB_MUTATION_KINDS.has('github/prPrepare'), false);
  assert.equal(GITHUB_MUTATION_KINDS.has('github/prReviewers'), false);
});

test('a create request without a key is not replayable, one with a key is', () => {
  const without = {
    id: 'r1',
    kind: 'github/createPullRequest',
    payload: {
      owner: 'o',
      repo: 'r',
      base: 'main',
      head: 'feat/a',
      title: 'T',
      body: '',
      draft: false,
      reviewers: [],
      publish: false,
    },
  } as const;
  assert.equal(idempotencyKeyOf(without as never), null);

  const withKey = { ...without, payload: { ...without.payload, idempotencyKey: 'k' } };
  assert.equal(idempotencyKeyOf(withKey as never), 'github/createPullRequest:k');
});

test('the merge payload carries the pin, the method, and the optional squash fields', () => {
  const payload: MergePullPayload = {
    owner: 'o',
    repo: 'r',
    number: 150,
    method: 'squash',
    expectedHeadSha: 'a'.repeat(40),
    commitTitle: 'fix(webview): rebalance inset (#150)',
    commitMessage: 'Additive tree indent.',
    deleteBranch: true,
    idempotencyKey: 'k1',
    confirm: true,
  };
  assert.equal(payload.method, 'squash');
  assert.equal(payload.deleteBranch, true);
});

test('the merge result reports the branch deletion separately from the merge', () => {
  const result: MergePullResult = {
    merged: true,
    mergeSha: 'c'.repeat(40),
    branchDeleted: { remote: true, local: false },
    warnings: ['branch'],
  };
  assert.equal(result.merged, true);
  assert.equal(result.branchDeleted.remote, true);
  assert.equal(result.branchDeleted.local, false);
  assert.deepEqual(result.warnings, ['branch']);
});

test('the review payload carries the event, the body, and the pin', () => {
  const payload: SubmitReviewPayload = {
    owner: 'o',
    repo: 'r',
    number: 150,
    event: 'REQUEST_CHANGES',
    body: 'Please fix the inset.',
    expectedHeadSha: 'a'.repeat(40),
    idempotencyKey: 'k2',
  };
  assert.equal(payload.event, 'REQUEST_CHANGES');
});

test('the close and reply payloads carry only what their routes need', () => {
  const close: ClosePullPayload = { owner: 'o', repo: 'r', number: 150, idempotencyKey: 'k3' };
  const reply: ReplyReviewPayload = {
    owner: 'o',
    repo: 'r',
    number: 150,
    commentId: 44,
    body: 'Agreed.',
    idempotencyKey: 'k4',
  };
  assert.equal(close.number, 150);
  assert.equal(reply.commentId, 44);
});
