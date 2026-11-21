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
  validateOpenPullRequestPayload,
  validatePrPreparePayload,
  validatePrReviewersPayload,
  validatePullDetailPayload,
  validateMergePullPayload,
  validateClosePullPayload,
  validateSubmitReviewPayload,
  validateReplyReviewCommentPayload,
  validateCommentIssuePayload,
  validateSetIssueStatePayload,
  validateCreateIssuePayload,
  validateRepoLabelsPayload,
  validateRerunFailedPayload,
  validateWorkflowInputsPayload,
  validateDispatchWorkflowPayload,
  validateReleaseNotesPayload,
  validateCreateReleasePayload,
  GITHUB_MUTATION_KINDS,
  MUTATION_KINDS,
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

/**
 * `github/pullDetail`, `github/pullCommits`, `github/pullFiles` and
 * `github/pullTimeline` share one payload: the slug pair plus the number. The
 * number names a path segment of every URL, so it is held to the same 32-bit
 * integer rule the checkout refspec uses.
 */
test('validatePullDetailPayload holds the slug pair and the pull number', () => {
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

  assert.equal(detailOf(() => validatePullDetailPayload({ owner: 'o', repo: 'r', number: 150 }, invalid)), 'accepted');
  assert.equal(
    detailOf(() => validatePullDetailPayload({ owner: 'o', repo: 'r', number: 2_147_483_647 }, invalid)),
    'accepted',
  );
  assert.equal(detailOf(() => validatePullDetailPayload({ owner: '', repo: 'r', number: 150 }, invalid)), 'owner/repo');
  assert.equal(detailOf(() => validatePullDetailPayload({ owner: 'o', repo: '..', number: 150 }, invalid)), 'owner/repo');
  for (const number of [0, -1, 1.5, '150', 2_147_483_648, NaN]) {
    assert.equal(
      detailOf(() => validatePullDetailPayload({ owner: 'o', repo: 'r', number }, invalid)),
      'number',
      String(number),
    );
  }
});

test('validateOpenPullRequestPayload checks the number alone', () => {
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

  assert.equal(detailOf(() => validateOpenPullRequestPayload({ number: 150 }, invalid)), 'accepted');
  for (const number of [0, -1, 1.5, '150', 2_147_483_648]) {
    assert.equal(detailOf(() => validateOpenPullRequestPayload({ number }, invalid)), 'number', String(number));
  }
  // Extra fields never reach the host: `actions/openPullRequest` takes a number and
  // nothing else, so a payload that carries more is a bug in the caller.
  assert.equal(
    detailOf(() => validateOpenPullRequestPayload({ number: 1, path: '/etc/passwd' }, invalid)),
    'payload',
  );
});

// --------------------------------------------------- P25 merge and review (P25)

/**
 * Four payloads share one shape: the slug pair, the number, and the fields the
 * endpoint needs. The slug pair and the number name path segments of every URL,
 * so they are held to the same rules as every other GitHub read. The merge and
 * review payloads pin the head sha the user saw, and a missing sha is refused
 * rather than defaulted: a merge with no pin is exactly the merge this phase
 * exists to prevent.
 */
test('validateMergePullPayload accepts the full shape and refuses a missing pin', () => {
  const invalid = (detail: string): never => {
    throw new Error(detail);
  };
  const detailOf = (fn: () => void): string => {
    try {
      fn();
      return 'accepted';
    } catch (err) {
      return (err as Error).message;
    }
  };
  const base = {
    owner: 'o',
    repo: 'r',
    number: 150,
    method: 'merge' as const,
    expectedHeadSha: 'a'.repeat(40),
    idempotencyKey: 'k',
    confirm: true,
  };

  assert.equal(detailOf(() => validateMergePullPayload(base, invalid)), 'accepted');
  assert.equal(
    detailOf(() =>
      validateMergePullPayload(
        {
          ...base,
          method: 'squash',
          commitTitle: 'fix: a title',
          commitMessage: 'A body.',
          deleteBranch: true,
        },
        invalid,
      ),
    ),
    'accepted',
  );

  for (const method of ['rebase', 'MERGE', '', null]) {
    assert.equal(detailOf(() => validateMergePullPayload({ ...base, method }, invalid)), 'method', String(method));
  }
  for (const sha of ['', 'abc', 'a'.repeat(39), 'g'.repeat(40), 7, null]) {
    assert.equal(
      detailOf(() => validateMergePullPayload({ ...base, expectedHeadSha: sha }, invalid)),
      'expectedHeadSha',
      String(sha),
    );
  }
  assert.equal(
    detailOf(() => validateMergePullPayload({ ...base, number: 0 }, invalid)),
    'number',
  );
  assert.equal(
    detailOf(() => validateMergePullPayload({ ...base, owner: '..' }, invalid)),
    'owner/repo',
  );
  // A squash title that is not a string, or is blank, is refused when present.
  assert.equal(
    detailOf(() => validateMergePullPayload({ ...base, commitTitle: '   ' }, invalid)),
    'commitTitle',
  );
  assert.equal(
    detailOf(() => validateMergePullPayload({ ...base, commitMessage: 7 }, invalid)),
    'commitMessage',
  );
  assert.equal(
    detailOf(() => validateMergePullPayload({ ...base, deleteBranch: 'yes' }, invalid)),
    'deleteBranch',
  );
  // An extra field is a caller bug, and is refused rather than ignored.
  assert.equal(
    detailOf(() => validateMergePullPayload({ ...base, path: '/etc/passwd' }, invalid)),
    'payload',
  );
});

test('validateClosePullPayload admits only the slug pair, the number, and the write meta', () => {
  const invalid = (detail: string): never => {
    throw new Error(detail);
  };
  const detailOf = (fn: () => void): string => {
    try {
      fn();
      return 'accepted';
    } catch (err) {
      return (err as Error).message;
    }
  };
  assert.equal(
    detailOf(() => validateClosePullPayload({ owner: 'o', repo: 'r', number: 150, idempotencyKey: 'k' }, invalid)),
    'accepted',
  );
  assert.equal(
    detailOf(() => validateClosePullPayload({ owner: 'o', repo: 'r', number: 0, idempotencyKey: 'k' }, invalid)),
    'number',
  );
  assert.equal(
    detailOf(() =>
      validateClosePullPayload({ owner: 'o', repo: 'r', number: 1, idempotencyKey: 'k', extra: true }, invalid),
    ),
    'payload',
  );
});

test('validateSubmitReviewPayload holds the event, the body rule, and the pin', () => {
  const invalid = (detail: string): never => {
    throw new Error(detail);
  };
  const detailOf = (fn: () => void): string => {
    try {
      fn();
      return 'accepted';
    } catch (err) {
      return (err as Error).message;
    }
  };
  const base = {
    owner: 'o',
    repo: 'r',
    number: 150,
    event: 'APPROVE' as const,
    body: '',
    expectedHeadSha: 'a'.repeat(40),
    idempotencyKey: 'k',
  };

  assert.equal(detailOf(() => validateSubmitReviewPayload(base, invalid)), 'accepted');
  assert.equal(
    detailOf(() => validateSubmitReviewPayload({ ...base, event: 'REQUEST_CHANGES', body: 'Please fix.' }, invalid)),
    'accepted',
  );
  assert.equal(
    detailOf(() => validateSubmitReviewPayload({ ...base, event: 'COMMENT', body: 'A note.' }, invalid)),
    'accepted',
  );
  // Request changes and comment need text; approve does not.
  assert.equal(
    detailOf(() => validateSubmitReviewPayload({ ...base, event: 'REQUEST_CHANGES', body: '   ' }, invalid)),
    'body',
  );
  assert.equal(
    detailOf(() => validateSubmitReviewPayload({ ...base, event: 'COMMENT', body: '' }, invalid)),
    'body',
  );
  assert.equal(detailOf(() => validateSubmitReviewPayload({ ...base, event: 'DISMISS' }, invalid)), 'event');
  assert.equal(detailOf(() => validateSubmitReviewPayload({ ...base, event: 'approve' }, invalid)), 'event');
  assert.equal(
    detailOf(() => validateSubmitReviewPayload({ ...base, expectedHeadSha: 'nope' }, invalid)),
    'expectedHeadSha',
  );
  assert.equal(
    detailOf(() => validateSubmitReviewPayload({ ...base, body: 'a'.repeat(65_537) }, invalid)),
    'body',
  );
});

test('validateReplyReviewCommentPayload holds the comment id and the body', () => {
  const invalid = (detail: string): never => {
    throw new Error(detail);
  };
  const detailOf = (fn: () => void): string => {
    try {
      fn();
      return 'accepted';
    } catch (err) {
      return (err as Error).message;
    }
  };
  const base = {
    owner: 'o',
    repo: 'r',
    number: 150,
    commentId: 44,
    body: 'Agreed.',
    idempotencyKey: 'k',
  };
  assert.equal(detailOf(() => validateReplyReviewCommentPayload(base, invalid)), 'accepted');
  for (const commentId of [0, -1, 1.5, '44', null]) {
    assert.equal(
      detailOf(() => validateReplyReviewCommentPayload({ ...base, commentId }, invalid)),
      'commentId',
      String(commentId),
    );
  }
  assert.equal(
    detailOf(() => validateReplyReviewCommentPayload({ ...base, body: '  ' }, invalid)),
    'body',
  );
});

test('the four P25 kinds join the GitHub mutation registry, and stay disjoint from git', () => {
  for (const kind of [
    'github/mergePullRequest',
    'github/closePullRequest',
    'github/submitReview',
    'github/replyReviewComment',
  ]) {
    assert.ok(GITHUB_MUTATION_KINDS.has(kind), kind);
    assert.ok(!MUTATION_KINDS.has(kind), `${kind} is not a git mutation`);
  }
  for (const kind of ['github/pullDetail', 'github/pullCommits', 'github/pullFiles', 'github/pullTimeline']) {
    assert.ok(!GITHUB_MUTATION_KINDS.has(kind), `${kind} is a read and is never replayed`);
  }
});

test('a merge, close, review, or reply with a key is replayable', () => {
  for (const kind of [
    'github/mergePullRequest',
    'github/closePullRequest',
    'github/submitReview',
    'github/replyReviewComment',
  ]) {
    assert.equal(
      idempotencyKeyOf({
        id: 'r1',
        kind,
        payload: { owner: 'o', repo: 'r', number: 1, idempotencyKey: 'k1' },
      } as unknown as Request),
      `${kind}:k1`,
      kind,
    );
  }
});

/**
 * A confirmation retry has to survive the replay store.
 *
 * `shouldRemember` decides what the bridge keeps. A `CONFIRMATION_REQUIRED`
 * outcome is deliberately not remembered: the retry carries `confirm: true` and
 * is a DIFFERENT request that must actually run, not a replay of the refusal.
 */
test('a confirmation refusal is not remembered, so the confirmed retry runs', () => {
  assert.equal(shouldRemember({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } }), false);
  assert.equal(shouldRemember({ ok: true, data: { merged: true } }), true);
  assert.equal(shouldRemember({ ok: false, error: { code: 'CONFLICT' } }), true);
});

// --------------------------------------------------- P26 issue write actions

test('P26: the three issue mutation kinds join GITHUB_MUTATION_KINDS and repoLabels stays a read', () => {
  for (const kind of ['github/commentIssue', 'github/setIssueState', 'github/createIssue']) {
    assert.ok(GITHUB_MUTATION_KINDS.has(kind), kind);
    assert.ok(!MUTATION_KINDS.has(kind), `${kind} is not a git mutation`);
    assert.equal(
      idempotencyKeyOf({
        id: 'r1',
        kind,
        payload: { owner: 'o', repo: 'r', idempotencyKey: 'ik-26' },
      } as unknown as Request),
      `${kind}:ik-26`,
      kind,
    );
  }
  assert.equal(GITHUB_MUTATION_KINDS.has('github/repoLabels'), false, 'repoLabels is a read');
  assert.equal(
    idempotencyKeyOf({
      id: 'r2',
      kind: 'github/repoLabels',
      payload: { owner: 'o', repo: 'r' },
    } as unknown as Request),
    null,
  );
});

test('P26: validateCommentIssuePayload, validateSetIssueStatePayload, validateCreateIssuePayload, and validateRepoLabelsPayload enforce strict payload bounds', () => {
  const invalid = (detail: string): never => {
    throw new Error(detail);
  };
  const detailOf = (fn: () => void): string => {
    try {
      fn();
      return 'accepted';
    } catch (err) {
      return (err as Error).message;
    }
  };

  const commentBase = { owner: 'o', repo: 'r', number: 97, body: 'Looks reproducible.', idempotencyKey: 'k1' };
  assert.equal(detailOf(() => validateCommentIssuePayload(commentBase, invalid)), 'accepted');
  assert.equal(detailOf(() => validateCommentIssuePayload({ ...commentBase, extra: 1 }, invalid)), 'payload');
  assert.equal(detailOf(() => validateCommentIssuePayload({ ...commentBase, owner: '..' }, invalid)), 'owner/repo');
  assert.equal(detailOf(() => validateCommentIssuePayload({ ...commentBase, number: 0 }, invalid)), 'number');
  assert.equal(detailOf(() => validateCommentIssuePayload({ ...commentBase, body: '   ' }, invalid)), 'body');

  const stateBase = { owner: 'o', repo: 'r', number: 97, state: 'closed' as const, idempotencyKey: 'k2' };
  assert.equal(detailOf(() => validateSetIssueStatePayload(stateBase, invalid)), 'accepted');
  assert.equal(detailOf(() => validateSetIssueStatePayload({ ...stateBase, state: 'open' }, invalid)), 'accepted');
  assert.equal(detailOf(() => validateSetIssueStatePayload({ ...stateBase, extra: true }, invalid)), 'payload');
  assert.equal(detailOf(() => validateSetIssueStatePayload({ ...stateBase, repo: '-r' }, invalid)), 'owner/repo');
  assert.equal(detailOf(() => validateSetIssueStatePayload({ ...stateBase, number: -1 }, invalid)), 'number');
  assert.equal(detailOf(() => validateSetIssueStatePayload({ ...stateBase, state: 'merged' }, invalid)), 'state');

  const createBase = {
    owner: 'o',
    repo: 'r',
    title: 'Crash on start',
    body: 'Steps to reproduce',
    labels: ['bug'],
    idempotencyKey: 'k3',
  };
  assert.equal(detailOf(() => validateCreateIssuePayload(createBase, invalid)), 'accepted');
  assert.equal(detailOf(() => validateCreateIssuePayload({ ...createBase, body: '', labels: [] }, invalid)), 'accepted');
  assert.equal(detailOf(() => validateCreateIssuePayload({ ...createBase, assignee: 'me' }, invalid)), 'payload');
  assert.equal(detailOf(() => validateCreateIssuePayload({ ...createBase, owner: '' }, invalid)), 'owner/repo');
  assert.equal(detailOf(() => validateCreateIssuePayload({ ...createBase, title: '  ' }, invalid)), 'title');
  assert.equal(detailOf(() => validateCreateIssuePayload({ ...createBase, body: 'a\u0000b' }, invalid)), 'body');
  assert.equal(detailOf(() => validateCreateIssuePayload({ ...createBase, labels: ['bug', 'bug'] }, invalid)), 'labels');

  assert.equal(detailOf(() => validateRepoLabelsPayload({ owner: 'o', repo: 'r' }, invalid)), 'accepted');
  assert.equal(detailOf(() => validateRepoLabelsPayload({ owner: 'o', repo: 'r', extra: 1 }, invalid)), 'payload');
  assert.equal(detailOf(() => validateRepoLabelsPayload({ owner: '..', repo: 'r' }, invalid)), 'owner/repo');
});

// -------------------------------------------------- P27 actions write actions

test('P27: rerunFailedJobs and dispatchWorkflow join GITHUB_MUTATION_KINDS while workflowInputs stays a read', () => {
  for (const kind of ['github/rerunFailedJobs', 'github/dispatchWorkflow']) {
    assert.ok(GITHUB_MUTATION_KINDS.has(kind), kind);
    assert.ok(!MUTATION_KINDS.has(kind), `${kind} is not a git mutation`);
    assert.equal(
      idempotencyKeyOf({
        id: 'r27',
        kind,
        payload: { owner: 'o', repo: 'r', idempotencyKey: 'ik-27' },
      } as unknown as Request),
      `${kind}:ik-27`,
      kind,
    );
  }
  assert.equal(GITHUB_MUTATION_KINDS.has('github/workflowInputs'), false, 'workflowInputs is a read');
  assert.equal(
    idempotencyKeyOf({
      id: 'r27-read',
      kind: 'github/workflowInputs',
      payload: { owner: 'o', repo: 'r', workflowId: 1, ref: 'main', idempotencyKey: 'ignored' },
    } as unknown as Request),
    null,
  );
});

test('P27: validateRerunFailedPayload, validateWorkflowInputsPayload, and validateDispatchWorkflowPayload enforce strict payload bounds', () => {
  const invalid = (detail: string): never => {
    throw new Error(detail);
  };
  const detailOf = (fn: () => void): string => {
    try {
      fn();
      return 'accepted';
    } catch (err) {
      return (err as Error).message;
    }
  };

  const rerunBase = { owner: 'o', repo: 'r', runId: 42, idempotencyKey: 'rr-1' };
  assert.equal(detailOf(() => validateRerunFailedPayload(rerunBase, invalid)), 'accepted');
  assert.equal(detailOf(() => validateRerunFailedPayload({ ...rerunBase, extra: 1 }, invalid)), 'payload');
  assert.equal(detailOf(() => validateRerunFailedPayload({ ...rerunBase, owner: '../o' }, invalid)), 'owner/repo');
  assert.equal(detailOf(() => validateRerunFailedPayload({ ...rerunBase, runId: 0 }, invalid)), 'runId');
  assert.equal(detailOf(() => validateRerunFailedPayload({ ...rerunBase, runId: 1.5 }, invalid)), 'runId');

  const inputsBase = { owner: 'o', repo: 'r', workflowId: 7, ref: 'main' };
  assert.equal(detailOf(() => validateWorkflowInputsPayload(inputsBase, invalid)), 'accepted');
  assert.equal(detailOf(() => validateWorkflowInputsPayload({ ...inputsBase, extra: true }, invalid)), 'payload');
  assert.equal(detailOf(() => validateWorkflowInputsPayload({ ...inputsBase, repo: '-bad' }, invalid)), 'owner/repo');
  assert.equal(detailOf(() => validateWorkflowInputsPayload({ ...inputsBase, workflowId: 0 }, invalid)), 'workflowId');
  assert.equal(detailOf(() => validateWorkflowInputsPayload({ ...inputsBase, ref: 'bad branch' }, invalid)), 'ref');
  assert.equal(detailOf(() => validateWorkflowInputsPayload({ ...inputsBase, ref: '-flag' }, invalid)), 'ref');

  const dispatchBase = {
    owner: 'o',
    repo: 'r',
    workflowId: 7,
    ref: 'release/v1',
    inputs: { version: '1.0.0', dry_run: 'false' },
    idempotencyKey: 'dp-1',
    confirm: true,
  };
  assert.equal(detailOf(() => validateDispatchWorkflowPayload(dispatchBase, invalid)), 'accepted');
  assert.equal(
    detailOf(() =>
      validateDispatchWorkflowPayload(
        { owner: 'o', repo: 'r', workflowId: 7, ref: 'main', idempotencyKey: 'dp-2', confirm: true },
        invalid,
      ),
    ),
    'accepted',
  );
  assert.equal(detailOf(() => validateDispatchWorkflowPayload({ ...dispatchBase, extra: 1 }, invalid)), 'payload');
  assert.equal(detailOf(() => validateDispatchWorkflowPayload({ ...dispatchBase, owner: '' }, invalid)), 'owner/repo');
  assert.equal(detailOf(() => validateDispatchWorkflowPayload({ ...dispatchBase, workflowId: -1 }, invalid)), 'workflowId');
  assert.equal(detailOf(() => validateDispatchWorkflowPayload({ ...dispatchBase, ref: 'bad..ref' }, invalid)), 'ref');
  assert.equal(
    detailOf(() => validateDispatchWorkflowPayload({ ...dispatchBase, inputs: { '1bad': 'x' } }, invalid)),
    'inputs',
  );
  const eleven: Record<string, string> = {};
  for (let i = 0; i < 11; i += 1) eleven[`k_${i}`] = 'v';
  assert.equal(detailOf(() => validateDispatchWorkflowPayload({ ...dispatchBase, inputs: eleven }, invalid)), 'inputs');
});

/** P28: tag actions and release request payload validation + idempotency registration. */
test('validateAction covers tag-create and tag-push', () => {
  const fail = (detail: string): never => {
    throw new Error(`failed:${detail}`);
  };

  assert.doesNotThrow(() =>
    validateAction(
      { action: 'tag-create', name: 'v2.8.0', target: 'main', message: 'Release v2.8.0', annotated: true, idempotencyKey: 'tc-1' },
      fail,
    ),
  );
  assert.doesNotThrow(() =>
    validateAction(
      { action: 'tag-create', name: 'v2.8.0', target: 'a'.repeat(40), annotated: false, idempotencyKey: 'tc-2' },
      fail,
    ),
  );
  assert.doesNotThrow(() =>
    validateAction({ action: 'tag-push', remote: 'origin', name: 'v2.8.0', idempotencyKey: 'tp-1' }, fail),
  );

  assert.throws(
    () => validateAction({ action: 'tag-create', name: '-f', target: 'main', idempotencyKey: 'tc-3' }, fail),
    /failed:name/,
  );
  assert.throws(
    () => validateAction({ action: 'tag-create', name: 'v2.8.0', target: '-bad', idempotencyKey: 'tc-4' }, fail),
    /failed:target/,
  );
  assert.throws(
    () =>
      validateAction(
        { action: 'tag-create', name: 'v2.8.0', target: 'main', message: 'x'.repeat(2001), idempotencyKey: 'tc-5' },
        fail,
      ),
    /failed:message/,
  );
  assert.throws(
    () =>
      validateAction(
        {
          action: 'tag-create',
          name: 'v2.8.0',
          target: 'main',
          annotated: 'yes' as unknown as boolean,
          idempotencyKey: 'tc-6',
        },
        fail,
      ),
    /failed:annotated/,
  );
  assert.throws(
    () => validateAction({ action: 'tag-push', remote: '-origin', name: 'v2.8.0', idempotencyKey: 'tp-2' }, fail),
    /failed:remote/,
  );
  assert.throws(
    () => validateAction({ action: 'tag-push', remote: 'origin', name: '+v2.8.0', idempotencyKey: 'tp-3' }, fail),
    /failed:name/,
  );
});

test('validateReleaseNotesPayload, validateCreateReleasePayload, and GITHUB_MUTATION_KINDS cover P28', () => {
  assert.equal(GITHUB_MUTATION_KINDS.has('github/createRelease'), true);
  assert.equal(GITHUB_MUTATION_KINDS.has('github/releaseNotes'), false);

  const invalid = (detail: string): never => {
    throw new Error(detail);
  };
  const detailOf = (fn: () => void): string => {
    try {
      fn();
      return 'accepted';
    } catch (err) {
      return (err as Error).message;
    }
  };

  const notesBase = { owner: 'o', repo: 'r', tag: 'v2.8.0', previousTag: 'v2.7.0', target: 'main' };
  assert.equal(detailOf(() => validateReleaseNotesPayload(notesBase, invalid)), 'accepted');
  assert.equal(detailOf(() => validateReleaseNotesPayload({ owner: 'o', repo: 'r', tag: 'v2.8.0' }, invalid)), 'accepted');
  assert.equal(detailOf(() => validateReleaseNotesPayload({ ...notesBase, extra: 1 }, invalid)), 'payload');
  assert.equal(detailOf(() => validateReleaseNotesPayload({ ...notesBase, owner: '../o' }, invalid)), 'owner/repo');
  assert.equal(detailOf(() => validateReleaseNotesPayload({ ...notesBase, tag: '-bad' }, invalid)), 'tag');
  assert.equal(detailOf(() => validateReleaseNotesPayload({ ...notesBase, previousTag: 'a..b' }, invalid)), 'previousTag');
  assert.equal(detailOf(() => validateReleaseNotesPayload({ ...notesBase, target: '-bad' }, invalid)), 'target');

  const releaseBase = {
    owner: 'o',
    repo: 'r',
    tag: 'v2.8.0',
    name: 'v2.8.0',
    body: '## Notes\n- Added tags',
    prerelease: false,
    target: 'a'.repeat(40),
    idempotencyKey: 'rel-1',
    confirm: true,
  };
  assert.equal(detailOf(() => validateCreateReleasePayload(releaseBase, invalid)), 'accepted');
  assert.equal(detailOf(() => validateCreateReleasePayload({ ...releaseBase, target: 'main' }, invalid)), 'accepted');
  assert.equal(detailOf(() => validateCreateReleasePayload({ ...releaseBase, extra: 1 }, invalid)), 'payload');
  assert.equal(detailOf(() => validateCreateReleasePayload({ ...releaseBase, owner: '' }, invalid)), 'owner/repo');
  assert.equal(detailOf(() => validateCreateReleasePayload({ ...releaseBase, tag: 'HEAD' }, invalid)), 'tag');
  assert.equal(detailOf(() => validateCreateReleasePayload({ ...releaseBase, name: '   ' }, invalid)), 'name');
  assert.equal(detailOf(() => validateCreateReleasePayload({ ...releaseBase, body: 'a\u0000b' }, invalid)), 'body');
  assert.equal(detailOf(() => validateCreateReleasePayload({ ...releaseBase, prerelease: 'no' }, invalid)), 'prerelease');
  assert.equal(detailOf(() => validateCreateReleasePayload({ ...releaseBase, target: '-bad' }, invalid)), 'target');
});
