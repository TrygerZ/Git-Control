import test from 'node:test';
import assert from 'node:assert/strict';
import {
  idempotencyKeyOf,
  isIssueFilter,
  isIssueState,
  isNonNegativeInt,
  isPositiveInt,
  isSlug,
  messageOf,
  parseRequest,
  shouldRemember,
  validateAction,
  validateCheckRunsPayload,
  validateCommitPullRequestsPayload,
  validateCreatePullRequestPayload,
  validateEmptyPayload,
  validatePrPreparePayload,
  validatePrReviewersPayload,
  type Outcome,
} from '../src/bridgePure';
import type { ErrorCode, Request } from '../src/messages';

test('parseRequest accepts valid request envelopes', () => {
  const valid = parseRequest({
    id: 'req-1',
    kind: 'repos/status',
    payload: {},
  });
  assert.deepEqual(valid, {
    id: 'req-1',
    kind: 'repos/status',
    payload: {},
  });

  const validAction = parseRequest({
    id: 'req-2',
    kind: 'actions/git',
    payload: { action: 'stash' },
  });
  assert.deepEqual(validAction, {
    id: 'req-2',
    kind: 'actions/git',
    payload: { action: 'stash' },
  });
});

test('parseRequest rejects malformed envelopes and invalid payload types', () => {
  // Non-object envelopes
  assert.equal(parseRequest(null), null);
  assert.equal(parseRequest(undefined), null);
  assert.equal(parseRequest(''), null);
  assert.equal(parseRequest(123), null);
  assert.equal(parseRequest(true), null);

  // Array envelope (missing id/kind properties)
  assert.equal(parseRequest([]), null);
  assert.equal(parseRequest([{ id: '1', kind: 'repos/status', payload: {} }]), null);

  // Missing or invalid id
  assert.equal(parseRequest({ kind: 'repos/status', payload: {} }), null);
  assert.equal(parseRequest({ id: '', kind: 'repos/status', payload: {} }), null);
  assert.equal(parseRequest({ id: 123, kind: 'repos/status', payload: {} }), null);

  // Missing or invalid kind
  assert.equal(parseRequest({ id: '1', payload: {} }), null);
  assert.equal(parseRequest({ id: '1', kind: 123, payload: {} }), null);

  // Missing or non-object payload
  assert.equal(parseRequest({ id: '1', kind: 'repos/status' }), null);
  assert.equal(parseRequest({ id: '1', kind: 'repos/status', payload: null }), null);
  assert.equal(parseRequest({ id: '1', kind: 'repos/status', payload: 'string' }), null);
  assert.equal(parseRequest({ id: '1', kind: 'repos/status', payload: 123 }), null);
  assert.equal(parseRequest({ id: '1', kind: 'repos/status', payload: false }), null);
});

test('idempotencyKeyOf extracts key only for mutation kinds and handles edge cases', () => {
  // Mutation kinds
  const stageReq: Request<'actions/stage'> = {
    id: '1',
    kind: 'actions/stage',
    payload: { paths: ['a.txt'], stage: true, statusToken: 'tok', idempotencyKey: 'stg-key' },
  };
  assert.equal(idempotencyKeyOf(stageReq), 'actions/stage:stg-key');

  const commitReq: Request<'actions/commit'> = {
    id: '2',
    kind: 'actions/commit',
    payload: { message: 'msg', statusToken: 'tok', idempotencyKey: 'cmt-key' },
  };
  assert.equal(idempotencyKeyOf(commitReq), 'actions/commit:cmt-key');

  const gitReq: Request<'actions/git'> = {
    id: '3',
    kind: 'actions/git',
    payload: { action: 'stash', message: 'wip', idempotencyKey: 'git-key' },
  };
  assert.equal(idempotencyKeyOf(gitReq), 'actions/git:git-key');

  // Whitespace idempotencyKey is non-empty string so it forms valid key string
  const whitespaceReq: Request<'actions/stage'> = {
    id: '4',
    kind: 'actions/stage',
    payload: { paths: [], stage: true, statusToken: '', idempotencyKey: '   ' },
  };
  assert.equal(idempotencyKeyOf(whitespaceReq), 'actions/stage:   ');

  // Empty string idempotencyKey yields null
  const emptyKeyReq: Request<'actions/stage'> = {
    id: '5',
    kind: 'actions/stage',
    payload: { paths: [], stage: true, statusToken: '', idempotencyKey: '' },
  };
  assert.equal(idempotencyKeyOf(emptyKeyReq), null);

  // Missing or non-string idempotencyKey yields null
  const missingKeyReq: Request = {
    id: '6',
    kind: 'actions/stage',
    payload: { paths: [], stage: true, statusToken: '' } as any,
  };
  assert.equal(idempotencyKeyOf(missingKeyReq), null);

  const numberKeyReq: Request = {
    id: '7',
    kind: 'actions/stage',
    payload: { paths: [], stage: true, statusToken: '', idempotencyKey: 123 } as any,
  };
  assert.equal(idempotencyKeyOf(numberKeyReq), null);

  // Non-mutation kinds always yield null even with idempotencyKey
  const queryReq: Request = {
    id: '8',
    kind: 'repos/status',
    payload: { idempotencyKey: 'query-key' } as any,
  };
  assert.equal(idempotencyKeyOf(queryReq), null);
});

test('shouldRemember evaluates truth table for success and error codes', () => {
  // Successful outcomes are always remembered
  const successOutcome: Outcome = { ok: true, data: { status: 'clean' } };
  assert.equal(shouldRemember(successOutcome), true);

  // Transient/retryable guard codes are NOT remembered
  const retryableCodes: ErrorCode[] = [
    'CONFIRMATION_REQUIRED',
    'DIRTY_TREE',
    'STALE_STATUS',
    'REMOTE_AHEAD',
    'NON_FAST_FORWARD',
  ];
  for (const code of retryableCodes) {
    const outcome: Outcome = { ok: false, error: { code } };
    assert.equal(shouldRemember(outcome), false, `${code} must not be remembered`);
  }

  // Non-retryable error codes ARE remembered
  const rememberedErrorCodes: ErrorCode[] = [
    'REPOSITORY_LOCKED',
    'HOOK_REJECTED',
    'VALIDATION_ERROR',
    'NOT_FOUND',
    'SERVER_ERROR',
    'CONFLICT',
    'UNAVAILABLE',
    'AUTH_ERROR',
    'FORBIDDEN',
    'RATE_LIMITED',
  ];
  for (const code of rememberedErrorCodes) {
    const outcome: Outcome = { ok: false, error: { code } };
    assert.equal(shouldRemember(outcome), true, `${code} must be remembered`);
  }
});

test('primitive guards and helpers', () => {
  // validateEmptyPayload
  let failed = false;
  validateEmptyPayload({}, () => { failed = true; throw new Error(); });
  assert.equal(failed, false);
  assert.throws(() => validateEmptyPayload({ extra: 1 }, (detail) => {
    throw new Error(`failed:${detail}`);
  }), /failed:payload/);

  // messageOf
  assert.equal(messageOf(new Error('boom')), 'boom');
  assert.equal(messageOf('plain message'), 'plain message');
  assert.equal(messageOf(null), 'null');

  // isPositiveInt
  assert.equal(isPositiveInt(1), true);
  assert.equal(isPositiveInt(100), true);
  assert.equal(isPositiveInt(0), false);
  assert.equal(isPositiveInt(-1), false);
  assert.equal(isPositiveInt(1.5), false);
  assert.equal(isPositiveInt('1'), false);

  // isNonNegativeInt
  assert.equal(isNonNegativeInt(0), true);
  assert.equal(isNonNegativeInt(1), true);
  assert.equal(isNonNegativeInt(-1), false);
  assert.equal(isNonNegativeInt(0.5), false);
  assert.equal(isNonNegativeInt(null), false);

  // isSlug
  assert.equal(isSlug('valid-slug_1.0'), true);
  assert.equal(isSlug(''), false);
  assert.equal(isSlug('bad slug with spaces'), false);
  assert.equal(isSlug('a'.repeat(101)), false);
  assert.equal(isSlug(123), false);
  // A leading dash is an option in every argv and a path traversal seed in a URL.
  // GitHub owners and repositories cannot begin with one, so the rule is shared.
  assert.equal(isSlug('-force'), false);
  assert.equal(isSlug('--upload-pack=calc'), false);

  // isIssueFilter
  assert.equal(isIssueFilter('assigned'), true);
  assert.equal(isIssueFilter('created'), true);
  assert.equal(isIssueFilter('mentioned'), true);
  assert.equal(isIssueFilter('all'), false);
  assert.equal(isIssueFilter(''), false);
  assert.equal(isIssueFilter(null), false);

  // isIssueState
  assert.equal(isIssueState('open'), true);
  assert.equal(isIssueState('closed'), true);
  assert.equal(isIssueState('all'), false);
  assert.equal(isIssueState('merged'), false);
  assert.equal(isIssueState(undefined), false);
});

test('validateAction accepts the suggested branch names and rejects option-like names', () => {
  const fail = (detail: string): never => {
    throw new Error(`failed:${detail}`);
  };

  assert.doesNotThrow(() => {
    validateAction(
      {
        action: 'create-branch',
        name: 'feat/97-lane-gutter-push-state',
        startPoint: '4c9e1a2',
        idempotencyKey: 'k-1',
      },
      fail,
    );
  });

  assert.doesNotThrow(() => {
    validateAction(
      { action: 'create-branch', name: 'fix/97', startPoint: '4c9e1a2', idempotencyKey: 'k-2' },
      fail,
    );
  });

  assert.throws(
    () => {
      validateAction(
        { action: 'create-branch', name: '--upload-pack=x', startPoint: '4c9e1a2', idempotencyKey: 'k-3' },
        fail,
      );
    },
    /failed:name/,
  );
});

/**
 * Both delete actions reach an argv array, so both are validated at the bridge
 * boundary exactly like every other action: a leading `-` is an option to git,
 * and a qualified ref is not a branch.
 */
test('validateAction covers both branch delete actions', () => {
  const fail = (detail: string): never => {
    throw new Error(`failed:${detail}`);
  };

  assert.doesNotThrow(() =>
    validateAction({ action: 'branch-delete', branch: 'feat/a', idempotencyKey: 'bd-1' }, fail),
  );
  assert.doesNotThrow(() =>
    validateAction(
      { action: 'branch-delete-remote', remote: 'origin', branch: 'feat/a', idempotencyKey: 'bdr-1' },
      fail,
    ),
  );

  assert.throws(
    () => validateAction({ action: 'branch-delete', branch: '-D', idempotencyKey: 'bd-2' }, fail),
    /failed:branch/,
  );
  assert.throws(
    () => validateAction({ action: 'branch-delete', branch: 'refs/heads/x', idempotencyKey: 'bd-3' }, fail),
    /failed:branch/,
  );
  assert.throws(
    () =>
      validateAction(
        { action: 'branch-delete-remote', remote: '--upload-pack=calc', branch: 'feat/a', idempotencyKey: 'bdr-2' },
        fail,
      ),
    /failed:remote/,
  );
  assert.throws(
    () =>
      validateAction(
        { action: 'branch-delete-remote', remote: 'origin', branch: '-x', idempotencyKey: 'bdr-3' },
        fail,
      ),
    /failed:branch/,
  );
});

/**
 * The checkout action carries only a number and an optional remote. The branch
 * name is composed host-side from the number, so a payload cannot name a branch
 * at all: a request with a crafted name has nowhere to put it.
 */
test('validateAction covers checkout-pr number and remote', () => {
  const fail = (detail: string): never => {
    throw new Error(`failed:${detail}`);
  };

  assert.doesNotThrow(() => validateAction({ action: 'checkout-pr', number: 150, idempotencyKey: 'cp-1' }, fail));
  assert.doesNotThrow(() =>
    validateAction({ action: 'checkout-pr', number: 1, remote: 'origin', idempotencyKey: 'cp-2' }, fail),
  );

  for (const number of [0, -1, 1.5, '150', NaN, Infinity, 2_147_483_648, null, undefined]) {
    assert.throws(
      () => validateAction({ action: 'checkout-pr', number, idempotencyKey: 'cp-3' } as never, fail),
      /failed:number/,
      String(number),
    );
  }
  for (const remote of ['-x', 'a/b', 'a b', '', 'x'.repeat(101)]) {
    assert.throws(
      () => validateAction({ action: 'checkout-pr', number: 1, remote, idempotencyKey: 'cp-4' }, fail),
      /failed:remote/,
      remote,
    );
  }
});

// ------------------------------------------------- P21: check run payloads

test('P21: commit pull request and check run payloads are validated before the client', () => {
  const details: string[] = [];
  const fail = (detail: string): never => {
    details.push(detail);
    throw new Error(detail);
  };
  const HASH = 'a'.repeat(40);

  validateCommitPullRequestsPayload({ owner: 'o', repo: 'r', hash: HASH }, fail);
  validateCheckRunsPayload({ owner: 'o', repo: 'r', sha: HASH }, fail);
  assert.deepEqual(details, [], 'valid payloads pass');

  for (const owner of ['', '../../etc/passwd', 'a'.repeat(101), 'a b', 'a/b', 42, null, undefined]) {
    assert.throws(() => validateCommitPullRequestsPayload({ owner, repo: 'r', hash: HASH }, fail));
    assert.throws(() => validateCheckRunsPayload({ owner, repo: 'r', sha: HASH }, fail));
  }
  for (const repo of ['', 'x'.repeat(1_000_000), '--force', 'a/b', 0]) {
    assert.throws(() => validateCommitPullRequestsPayload({ owner: 'o', repo, hash: HASH }, fail));
    assert.throws(() => validateCheckRunsPayload({ owner: 'o', repo, sha: HASH }, fail));
  }
  for (const hash of ['', 'abc', '--force', 'g'.repeat(40), 'a'.repeat(41), 7, null]) {
    assert.throws(() => validateCommitPullRequestsPayload({ owner: 'o', repo: 'r', hash }, fail));
    assert.throws(() => validateCheckRunsPayload({ owner: 'o', repo: 'r', sha: hash }, fail));
  }
});

// ------------------------------------------------- create pull request (P22)

test('github/createPullRequest is a mutation kind, so its key is replayed', () => {
  const request = {
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
      idempotencyKey: 'k1',
    },
  } as unknown as Request;
  assert.equal(idempotencyKeyOf(request), 'github/createPullRequest:k1');

  // The two reads in the same phase are NOT mutations: they carry no key and
  // must never be replayed from the idempotency store.
  assert.equal(
    idempotencyKeyOf({ id: 'r2', kind: 'github/prPrepare', payload: { owner: 'o', repo: 'r' } } as unknown as Request),
    null,
  );
  assert.equal(
    idempotencyKeyOf({ id: 'r3', kind: 'github/prReviewers', payload: { owner: 'o', repo: 'r' } } as unknown as Request),
    null,
  );
});

test('a create pull request payload with no key is not replayable', () => {
  const request = {
    id: 'r1',
    kind: 'github/createPullRequest',
    payload: { owner: 'o', repo: 'r', base: 'main', head: 'feat/a', title: 'T', body: '', draft: false, reviewers: [], publish: false },
  } as unknown as Request;
  assert.equal(idempotencyKeyOf(request), null);
});

test('validateCreatePullRequestPayload accepts a well formed request', () => {
  const invalid = (detail: string): never => {
    throw new Error(detail);
  };
  validateCreatePullRequestPayload(
    {
      owner: 'o',
      repo: 'r',
      base: 'main',
      head: 'feat/a',
      title: 'A title',
      body: 'A body',
      draft: true,
      reviewers: ['ann'],
      publish: true,
      remote: 'origin',
    },
    invalid,
  );
});

test('validateCreatePullRequestPayload rejects each bad field by name', () => {
  const base = {
    owner: 'o',
    repo: 'r',
    base: 'main',
    head: 'feat/a',
    title: 'A title',
    body: '',
    draft: false,
    reviewers: [] as unknown[],
    publish: false,
  };
  const detailOf = (patch: Record<string, unknown>): string => {
    try {
      validateCreatePullRequestPayload({ ...base, ...patch } as never, (detail) => {
        throw new Error(detail);
      });
      return 'accepted';
    } catch (err) {
      return (err as Error).message;
    }
  };

  assert.equal(detailOf({ owner: '-o' }), 'owner/repo');
  assert.equal(detailOf({ repo: '' }), 'owner/repo');
  assert.equal(detailOf({ base: '..' }), 'base');
  assert.equal(detailOf({ head: '-x' }), 'head');
  assert.equal(detailOf({ head: 'main' }), 'head', 'a pull request from a branch into itself');
  assert.equal(detailOf({ title: '' }), 'title');
  assert.equal(detailOf({ title: 'x'.repeat(257) }), 'title');
  assert.equal(detailOf({ title: 'a\nb' }), 'title');
  assert.equal(detailOf({ body: 'x'.repeat(65_537) }), 'body');
  assert.equal(detailOf({ draft: 'yes' }), 'draft');
  assert.equal(detailOf({ publish: 'yes' }), 'publish');
  assert.equal(detailOf({ remote: '--upload-pack=calc' }), 'remote');
  assert.equal(detailOf({ reviewers: ['bad login'] }), 'reviewers');
  assert.equal(detailOf({ reviewers: Array.from({ length: 16 }, (_, i) => `u${i}`) }), 'reviewers');
  assert.equal(detailOf({ reviewers: 'ann' }), 'reviewers');
});

test('validatePrPreparePayload and validatePrReviewersPayload check the slug pair', () => {
  const detailOf = (fn: () => void): string => {
    try {
      fn();
      return 'accepted';
    } catch (err) {
      return (err as Error).message;
    }
  };
  const invalid = (detail: string): never => {
    throw new Error(detail);
  };

  assert.equal(detailOf(() => validatePrPreparePayload({ owner: 'o', repo: 'r' }, invalid)), 'accepted');
  assert.equal(detailOf(() => validatePrPreparePayload({ owner: 'o', repo: 'r', base: 'main' }, invalid)), 'accepted');
  assert.equal(detailOf(() => validatePrPreparePayload({ owner: 'o', repo: 'r', base: '-x' }, invalid)), 'base');
  assert.equal(detailOf(() => validatePrPreparePayload({ owner: '', repo: 'r' }, invalid)), 'owner/repo');

  assert.equal(detailOf(() => validatePrReviewersPayload({ owner: 'o', repo: 'r' }, invalid)), 'accepted');
  assert.equal(detailOf(() => validatePrReviewersPayload({ owner: 'o', repo: '..' }, invalid)), 'owner/repo');
});
