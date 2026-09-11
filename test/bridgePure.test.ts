import test from 'node:test';
import assert from 'node:assert/strict';
import {
  idempotencyKeyOf,
  isNonNegativeInt,
  isPositiveInt,
  isSlug,
  messageOf,
  parseRequest,
  shouldRemember,
  validateEmptyPayload,
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
});
