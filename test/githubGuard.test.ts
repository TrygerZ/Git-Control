/**
 * P19 T01/T02: the GitHub write guard is pure policy, so every verdict is
 * asserted here without a network, an editor, or a token.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGitHubAction,
  hasWriteScope,
  requiredScopes,
  type GitHubGuardContext,
  type GitHubWriteAction,
} from '../src/githubGuard';
import { hostText } from '../src/hostText';

const CONNECTED: GitHubGuardContext = {
  connected: true,
  scopes: ['repo'],
  tokenAllowed: true,
  circuitOpen: false,
};

const ACTIONS: GitHubWriteAction[] = [
  { action: 'create-pull-request', draft: false },
  { action: 'create-pull-request', draft: true },
  { action: 'merge-pull-request', method: 'merge' },
  { action: 'merge-pull-request', method: 'squash' },
  { action: 'submit-review', event: 'APPROVE' },
  { action: 'submit-review', event: 'REQUEST_CHANGES' },
  { action: 'submit-review', event: 'COMMENT' },
  { action: 'comment' },
  { action: 'close-issue' },
  { action: 'create-issue' },
  { action: 'rerun-failed-jobs' },
  { action: 'dispatch-workflow' },
  { action: 'create-release' },
];

// ------------------------------------------------------------------ ordering

test('a disconnected client is AUTH_ERROR and offers only cancel', () => {
  const verdict = evaluateGitHubAction({ action: 'create-issue' }, { ...CONNECTED, connected: false });
  assert.equal(verdict.allow, false);
  if (verdict.allow) return;
  assert.equal(verdict.code, 'AUTH_ERROR');
  assert.deepEqual(verdict.remedies, ['cancel']);
  assert.equal(verdict.message, hostText('en').github.notConnected);
});

test('an untrusted base is reported even when the host calls it disconnected', () => {
  // `githubAuth` reports an untrusted base as `connected: false`, because the
  // token is withheld. Telling that user to connect would be advice that can
  // never work, so trust is checked first.
  const verdict = evaluateGitHubAction(
    { action: 'create-issue' },
    { connected: false, scopes: [], tokenAllowed: false, circuitOpen: false },
  );
  assert.equal(verdict.allow, false);
  if (verdict.allow) return;
  assert.equal(verdict.code, 'FORBIDDEN');
  assert.equal(verdict.message, hostText('en').github.tokenNotTrusted);
});

test('an untrusted API base is FORBIDDEN before any scope or breaker check', () => {
  const verdict = evaluateGitHubAction(
    { action: 'create-issue' },
    { connected: true, scopes: [], tokenAllowed: false, circuitOpen: true },
  );
  assert.equal(verdict.allow, false);
  if (verdict.allow) return;
  assert.equal(verdict.code, 'FORBIDDEN');
  assert.equal(verdict.message, hostText('en').github.tokenNotTrusted);
  assert.deepEqual(verdict.remedies, ['cancel']);
});

test('an open breaker is UNAVAILABLE and says nothing was sent', () => {
  const verdict = evaluateGitHubAction({ action: 'comment' }, { ...CONNECTED, circuitOpen: true });
  assert.equal(verdict.allow, false);
  if (verdict.allow) return;
  assert.equal(verdict.code, 'UNAVAILABLE');
  assert.equal(verdict.message, hostText('en').github.writeUnavailable);
});

// -------------------------------------------------------------------- scopes

test('requiredScopes names a repo-level write scope for every action', () => {
  for (const action of ACTIONS) {
    const scopes = requiredScopes(action);
    assert.ok(scopes.length > 0, action.action);
    assert.ok(scopes.includes('repo'), action.action);
  }
});

test('hasWriteScope answers yes, no, and unknown', () => {
  assert.equal(hasWriteScope(['repo'], { action: 'create-issue' }), 'yes');
  assert.equal(hasWriteScope(['public_repo'], { action: 'create-issue' }), 'yes');
  assert.equal(hasWriteScope(['read:user', 'gist'], { action: 'create-issue' }), 'no');
  assert.equal(hasWriteScope([], { action: 'create-issue' }), 'no');
  assert.equal(hasWriteScope(null, { action: 'create-issue' }), 'unknown');
});

test('a missing scope is FORBIDDEN and names the scope it needs', () => {
  const verdict = evaluateGitHubAction({ action: 'merge-pull-request', method: 'merge' }, {
    ...CONNECTED,
    scopes: ['read:user'],
  });
  assert.equal(verdict.allow, false);
  if (verdict.allow) return;
  assert.equal(verdict.code, 'FORBIDDEN');
  assert.equal(verdict.message, hostText('en').github.missingScope('repo'));
  assert.deepEqual(verdict.remedies, ['cancel']);
});

test('an unknown scope set never blocks: the attempt is the only honest check', () => {
  for (const action of ACTIONS) {
    const verdict = evaluateGitHubAction(action, { ...CONNECTED, scopes: null });
    assert.notEqual(
      verdict.allow === false ? verdict.code : null,
      'FORBIDDEN',
      `${action.action} must not be refused on an unknown scope set`,
    );
  }
});

// -------------------------------------------------------------- confirmation

function levelOf(action: GitHubWriteAction): 1 | 2 | null {
  const verdict = evaluateGitHubAction(action, CONNECTED);
  if (verdict.allow) return null;
  return verdict.confirmationLevel ?? null;
}

test('the actions that change shared state ask for one confirmation', () => {
  assert.equal(levelOf({ action: 'merge-pull-request', method: 'merge' }), 1);
  assert.equal(levelOf({ action: 'merge-pull-request', method: 'squash' }), 1);
  assert.equal(levelOf({ action: 'create-release' }), 1);
  assert.equal(levelOf({ action: 'dispatch-workflow' }), 1);
  assert.equal(levelOf({ action: 'close-issue' }), 1);
  assert.equal(levelOf({ action: 'submit-review', event: 'APPROVE' }), 1);
  assert.equal(levelOf({ action: 'submit-review', event: 'REQUEST_CHANGES' }), 1);
});

test('a plain comment review needs no confirmation', () => {
  assert.equal(levelOf({ action: 'submit-review', event: 'COMMENT' }), null);
});

test('creating things and re-running jobs need no confirmation', () => {
  assert.equal(levelOf({ action: 'create-pull-request', draft: false }), null);
  assert.equal(levelOf({ action: 'create-pull-request', draft: true }), null);
  assert.equal(levelOf({ action: 'comment' }), null);
  assert.equal(levelOf({ action: 'create-issue' }), null);
  assert.equal(levelOf({ action: 'rerun-failed-jobs' }), null);
});

test('a confirmation verdict carries the confirm remedy, the level, and its risk', () => {
  const merge = evaluateGitHubAction({ action: 'merge-pull-request', method: 'squash' }, CONNECTED);
  assert.equal(merge.allow, false);
  if (merge.allow) return;
  assert.equal(merge.code, 'CONFIRMATION_REQUIRED');
  assert.equal(merge.requiresConfirmation, true);
  assert.deepEqual(merge.remedies, ['confirm', 'cancel']);
  assert.equal(merge.risk, 'medium');

  const close = evaluateGitHubAction({ action: 'close-issue' }, CONNECTED);
  assert.equal(close.allow, false);
  if (close.allow) return;
  assert.equal(close.risk, 'low');
  assert.equal(close.message, hostText('en').github.confirmWrite);
});

test('every action either allows or returns a fully shaped verdict', () => {
  for (const action of ACTIONS) {
    const verdict = evaluateGitHubAction(action, CONNECTED);
    if (verdict.allow) continue;
    assert.ok(verdict.code.length > 0, action.action);
    assert.ok(verdict.message.length > 0, action.action);
    assert.ok(Array.isArray(verdict.remedies), action.action);
  }
});

// --------------------------------------------------------------- localisation

test('Indonesian copy resolves for every blocking message', () => {
  const id = hostText('id').github;
  const missing = evaluateGitHubAction({ action: 'create-issue' }, { ...CONNECTED, scopes: [] }, 'id');
  assert.equal(missing.allow, false);
  if (missing.allow) return;
  assert.equal(missing.message, id.missingScope('repo'));

  const offline = evaluateGitHubAction({ action: 'create-issue' }, { ...CONNECTED, circuitOpen: true }, 'id');
  assert.equal(offline.allow, false);
  if (offline.allow) return;
  assert.equal(offline.message, id.writeUnavailable);

  const offlineEn = evaluateGitHubAction({ action: 'create-issue' }, { ...CONNECTED, circuitOpen: true }, 'en');
  assert.equal(offlineEn.allow, false);
  if (offlineEn.allow) return;
  assert.notEqual(offlineEn.message, offline.message, 'the language argument is honoured');
});

// ------------------------------------------------------- create pull request (P22)

test('creating a pull request is allowed once connected with a write scope', () => {
  assert.deepEqual(evaluateGitHubAction({ action: 'create-pull-request', draft: false }, CONNECTED), {
    allow: true,
  });
});

test('a publish-then-create request needs one confirmation, because it pushes', () => {
  const verdict = evaluateGitHubAction({ action: 'create-pull-request', draft: false, publish: true }, CONNECTED);
  assert.equal(verdict.allow, false);
  if (verdict.allow) return;
  assert.equal(verdict.code, 'CONFIRMATION_REQUIRED');
  assert.equal(verdict.confirmationLevel, 1);
  assert.equal(verdict.requiresConfirmation, true);
});

test('creating a pull request without a token is refused, and the refusal names the connection', () => {
  const verdict = evaluateGitHubAction(
    { action: 'create-pull-request', draft: false },
    { ...CONNECTED, connected: false },
  );
  assert.equal(verdict.allow, false);
  if (verdict.allow) return;
  assert.equal(verdict.code, 'AUTH_ERROR');
});

test('creating a pull request with a read-only token is refused with the scope message', () => {
  const verdict = evaluateGitHubAction(
    { action: 'create-pull-request', draft: false },
    { ...CONNECTED, scopes: ['public_repo'] },
  );
  // public_repo is a write scope for public repositories, so this one is allowed.
  assert.equal(verdict.allow, true);

  const readOnly = evaluateGitHubAction(
    { action: 'create-pull-request', draft: false },
    { ...CONNECTED, scopes: ['read:user'] },
  );
  assert.equal(readOnly.allow, false);
  if (readOnly.allow) return;
  assert.equal(readOnly.code, 'FORBIDDEN');
});
