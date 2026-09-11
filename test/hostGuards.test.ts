import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidCommitFocus,
  isValidIconTheme,
  isValidOperationProgress,
  isValidRepoChanged,
  isValidResponse,
  isValidSettingsSnapshot,
  isValidToast,
  validateHostEvent,
} from '../src/webview/hostGuards';
import { bridge } from '../src/webview/bridge';
import type {
  CommitFocusEvent,
  IconThemeSnapshot,
  OperationProgressEvent,
  RepoChangedEvent,
  SettingsSnapshot,
  ToastEvent,
} from '../src/messages';

test('validateHostEvent accepts valid repoChanged event', () => {
  const payload: RepoChangedEvent = { reason: 'action', statusToken: 'tok-123' };
  const res = validateHostEvent({ kind: 'event/repoChanged', payload });
  assert.ok(res);
  assert.equal(res.kind, 'event/repoChanged');
  assert.deepEqual(res.payload, payload);
});

test('validateHostEvent rejects malformed repoChanged event', () => {
  assert.equal(validateHostEvent({ kind: 'event/repoChanged', payload: { reason: 'invalid', statusToken: 'tok' } }), null);
  assert.equal(validateHostEvent({ kind: 'event/repoChanged', payload: { reason: 'action', statusToken: 123 } }), null);
  assert.equal(validateHostEvent({ kind: 'event/repoChanged', payload: null }), null);
});

test('validateHostEvent accepts valid operationProgress event', () => {
  const p1: OperationProgressEvent = { id: 'req-1', operation: 'pull', phase: 'progress', message: 'fetching' };
  const res1 = validateHostEvent({ kind: 'event/operationProgress', payload: p1 });
  assert.ok(res1);
  assert.equal(res1.kind, 'event/operationProgress');

  const p2: OperationProgressEvent = { id: 'req-2', operation: 'push', phase: 'finished' };
  const res2 = validateHostEvent({ kind: 'event/operationProgress', payload: p2 });
  assert.ok(res2);
});

test('validateHostEvent rejects malformed operationProgress event', () => {
  assert.equal(validateHostEvent({ kind: 'event/operationProgress', payload: { id: '', operation: 'x', phase: 'started' } }), null);
  assert.equal(validateHostEvent({ kind: 'event/operationProgress', payload: { id: '1', operation: 'x', phase: 'unknown' } }), null);
  assert.equal(validateHostEvent({ kind: 'event/operationProgress', payload: { id: '1', operation: 123, phase: 'started' } }), null);
  assert.equal(validateHostEvent({ kind: 'event/operationProgress', payload: { id: '1', operation: 'x', phase: 'started', message: 123 } }), null);
});

test('validateHostEvent accepts valid toast event', () => {
  const t1: ToastEvent = { level: 'info', message: 'Hello' };
  const res1 = validateHostEvent({ kind: 'event/toast', payload: t1 });
  assert.ok(res1);

  const t2: ToastEvent = { level: 'error', message: 'Fail', detail: 'More info' };
  const res2 = validateHostEvent({ kind: 'event/toast', payload: t2 });
  assert.ok(res2);
});

test('validateHostEvent rejects malformed toast event', () => {
  assert.equal(validateHostEvent({ kind: 'event/toast', payload: { level: 'fatal', message: 'msg' } }), null);
  assert.equal(validateHostEvent({ kind: 'event/toast', payload: { level: 'info', message: 123 } }), null);
  assert.equal(validateHostEvent({ kind: 'event/toast', payload: { level: 'info', message: 'msg', detail: 123 } }), null);
});

test('validateHostEvent accepts valid settingsChanged event', () => {
  const snapshot: SettingsSnapshot = {
    gitPath: '/usr/bin/git',
    commitLimit: 1000,
    pageSize: 50,
    showIgnoredFiles: false,
    githubApiUrl: 'https://api.github.com',
    fetchStalenessMs: 60000,
    language: 'id',
    ui: { zoom: 1, branchFilter: 'all' },
  };
  const res = validateHostEvent({ kind: 'event/settingsChanged', payload: snapshot });
  assert.ok(res);
  assert.equal(res.kind, 'event/settingsChanged');
});

test('validateHostEvent rejects malformed settingsChanged event', () => {
  assert.equal(validateHostEvent({
    kind: 'event/settingsChanged',
    payload: {
      gitPath: '/usr/bin/git',
      commitLimit: 1000,
      pageSize: 50,
      showIgnoredFiles: false,
      githubApiUrl: 'https://api.github.com',
      fetchStalenessMs: 60000,
      language: 'fr', // invalid language
      ui: { zoom: 1, branchFilter: 'all' },
    },
  }), null);

  assert.equal(validateHostEvent({
    kind: 'event/settingsChanged',
    payload: {
      gitPath: '/usr/bin/git',
      commitLimit: '1000', // not number
      pageSize: 50,
      showIgnoredFiles: false,
      githubApiUrl: 'https://api.github.com',
      fetchStalenessMs: 60000,
      language: 'en',
      ui: { zoom: 1, branchFilter: 'all' },
    },
  }), null);
});

test('validateHostEvent accepts valid iconThemeChanged event with snapshot and null', () => {
  const resNull = validateHostEvent({ kind: 'event/iconThemeChanged', payload: null });
  assert.ok(resNull);
  assert.equal(resNull.payload, null);

  const snapshot: IconThemeSnapshot = {
    themeId: 'vs-seti',
    definitions: {},
    fileExtensions: {},
    fileNames: {},
    folderNames: {},
    folderNamesExpanded: {},
    languageIds: {},
    languageByExtension: {},
    languageByFilename: {},
    fonts: [],
    hidesExplorerArrows: false,
  };
  const resSnap = validateHostEvent({ kind: 'event/iconThemeChanged', payload: snapshot });
  assert.ok(resSnap);
});

test('validateHostEvent rejects malformed iconThemeChanged event', () => {
  assert.equal(validateHostEvent({ kind: 'event/iconThemeChanged', payload: { themeId: 123 } }), null);
  assert.equal(validateHostEvent({ kind: 'event/iconThemeChanged', payload: { themeId: 't', definitions: null } }), null);
  assert.equal(validateHostEvent({ kind: 'event/iconThemeChanged', payload: { themeId: 't', definitions: {}, fonts: 'not-array' } }), null);
});

test('validateHostEvent accepts valid commitFocus event', () => {
  const payload: CommitFocusEvent = { hash: 'a1b2c3d' };
  const res = validateHostEvent({ kind: 'event/commitFocus', payload });
  assert.ok(res);
  assert.deepEqual(res.payload, payload);
});

test('validateHostEvent rejects malformed commitFocus event', () => {
  assert.equal(validateHostEvent({ kind: 'event/commitFocus', payload: { hash: '' } }), null);
  assert.equal(validateHostEvent({ kind: 'event/commitFocus', payload: { hash: 123 } }), null);
  assert.equal(validateHostEvent({ kind: 'event/commitFocus', payload: {} }), null);
});

test('validateHostEvent drops unknown kind and non-objects', () => {
  assert.equal(validateHostEvent({ kind: 'event/unknown', payload: {} }), null);
  assert.equal(validateHostEvent({ kind: 'custom/event', payload: {} }), null);
  assert.equal(validateHostEvent(null), null);
  assert.equal(validateHostEvent(undefined), null);
  assert.equal(validateHostEvent('a string'), null);
  assert.equal(validateHostEvent(42), null);
});

test('isValidResponse accepts valid success and error responses', () => {
  assert.equal(isValidResponse({ id: 'req-1', ok: true, data: { status: 'clean' } }), true);
  assert.equal(isValidResponse({ id: 'req-2', ok: true, data: null }), true);
  assert.equal(isValidResponse({ id: 'req-3', ok: true, data: [1, 2, 3] }), true);
  assert.equal(isValidResponse({
    id: 'req-4',
    ok: false,
    error: { status: 409, code: 'DIRTY_TREE', message: 'Tree dirty' },
  }), true);
});

test('isValidResponse rejects malformed responses', () => {
  assert.equal(isValidResponse(null), false);
  assert.equal(isValidResponse({}), false);
  assert.equal(isValidResponse({ id: '', ok: true }), false);
  assert.equal(isValidResponse({ id: 123, ok: true }), false);
  assert.equal(isValidResponse({ id: 'req-1', ok: 'yes' }), false);
  assert.equal(isValidResponse({ id: 'req-1', ok: true, error: { code: 'ERR' } }), false);
  assert.equal(isValidResponse({ id: 'req-1', ok: false }), false);
  assert.equal(isValidResponse({ id: 'req-1', ok: false, error: null }), false);
  assert.equal(isValidResponse({ id: 'req-1', ok: false, error: 'string error' }), false);
  assert.equal(isValidResponse({ id: 'req-1', ok: false, error: { code: '', message: 'fail' } }), false);
  assert.equal(isValidResponse({ id: 'req-1', ok: false, error: { code: 'ERR', message: 123 } }), false);
  assert.equal(isValidResponse({ kind: 'event/toast', id: 'req-1', ok: true }), false);
});

test('bridge receive drops unknown kind or malformed shapes without notifying listeners', () => {
  let calls = 0;
  const off = bridge.on('event/toast', () => {
    calls++;
  });

  const bridgeInternal = bridge as unknown as { receive(msg: unknown): void };

  // Unknown kind dropped
  bridgeInternal.receive({ kind: 'event/unknown', payload: {} });
  assert.equal(calls, 0);

  // Malformed payload dropped
  bridgeInternal.receive({ kind: 'event/toast', payload: { level: 'invalid', message: 'hi' } });
  assert.equal(calls, 0);

  // Valid payload delivered
  bridgeInternal.receive({ kind: 'event/toast', payload: { level: 'info', message: 'hi' } });
  assert.equal(calls, 1);

  off();
});

test('bridge settle ignores malformed responses and does not resolve or crash', () => {
  const bridgeInternal = bridge as unknown as {
    settle(resp: unknown): void;
    pending: Map<string, { resolve(d: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }>;
  };

  let resolved = false;
  let rejected = false;
  const fakePending = {
    resolve: () => { resolved = true; },
    reject: () => { rejected = true; },
    timer: setTimeout(() => {}, 100000),
  };
  bridgeInternal.pending.set('test-req', fakePending);

  // Malformed: ok is false but error is a string
  bridgeInternal.settle({ id: 'test-req', ok: false, error: 'bad' });
  assert.equal(resolved, false);
  assert.equal(rejected, false);
  assert.ok(bridgeInternal.pending.has('test-req'));

  // Clean error response settles properly
  bridgeInternal.settle({
    id: 'test-req',
    ok: false,
    error: { status: 400, code: 'VALIDATION_ERROR', message: 'Bad arg' },
  });
  assert.equal(rejected, true);
  assert.equal(bridgeInternal.pending.has('test-req'), false);
});
