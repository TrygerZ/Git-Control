/**
 * Explorer sync action model (P18b), frame 01.
 *
 * The header buttons encode the same rules `CommitForm` encodes inline, so the
 * rules live here as data and the component only renders them. Two behaviours are
 * deliberately different from the sidebar footer, and both are asserted below:
 * Pull is disabled without an upstream (git pull has nothing to merge), and Fetch
 * from the header never prunes (prune is an error remedy, not a default).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSyncActions, syncActionRequest, type SyncContext } from '../src/webview/syncActions';

function ctx(patch: Partial<SyncContext> = {}): SyncContext {
  return {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    remote: 'origin',
    busy: false,
    ...patch,
  };
}

test('no remote means no group at all', () => {
  assert.deepEqual(deriveSyncActions(ctx({ remote: null })), []);
});

test('the buttons always read fetch, pull, push', () => {
  assert.deepEqual(
    deriveSyncActions(ctx()).map((b) => b.id),
    ['fetch', 'pull', 'push'],
  );
});

test('a synced branch disables Push but leaves Fetch and Pull live', () => {
  const [fetch, pull, push] = deriveSyncActions(ctx());
  assert.equal(fetch?.disabled, false);
  assert.equal(pull?.disabled, false, 'pull with an upstream is always allowed');
  assert.equal(push?.disabled, true);
  assert.equal(push?.reason, 'in-sync');
});

test('ahead and behind become the Push and Pull counts', () => {
  const [, pull, push] = deriveSyncActions(ctx({ ahead: 2, behind: 3 }));
  assert.equal(pull?.count, 3);
  assert.equal(push?.count, 2);
  assert.equal(deriveSyncActions(ctx())[0]?.count, null, 'fetch carries no count');
});

test('detached HEAD disables Pull and Push with no-branch and leaves Fetch alone', () => {
  const [fetch, pull, push] = deriveSyncActions(ctx({ branch: null, upstream: null }));
  assert.equal(fetch?.disabled, false);
  assert.equal(pull?.disabled, true);
  assert.equal(pull?.reason, 'no-branch');
  assert.equal(push?.disabled, true);
  assert.equal(push?.reason, 'no-branch');
});

test('without an upstream the third button is Publish and Pull explains itself', () => {
  const [, pull, push] = deriveSyncActions(ctx({ upstream: null, ahead: 0 }));
  assert.equal(push?.kind, 'publish');
  assert.equal(push?.disabled, false, 'publishing is the whole point without an upstream');
  assert.equal(push?.count, null);
  assert.equal(pull?.disabled, true);
  assert.equal(pull?.reason, 'no-upstream');
  assert.equal(pull?.count, null);
});

test('with an upstream the third button is Push', () => {
  assert.equal(deriveSyncActions(ctx())[2]?.kind, 'push');
});

test('busy wins over every other reason', () => {
  for (const button of deriveSyncActions(ctx({ busy: true, ahead: 2, behind: 1 }))) {
    assert.equal(button.disabled, true, button.id);
    assert.equal(button.reason, 'busy', button.id);
  }
  // A detached HEAD with no upstream is still reported as busy while an
  // operation runs: the run is what blocks the click, not the branch state.
  const detached = deriveSyncActions(ctx({ busy: true, branch: null, upstream: null }));
  assert.deepEqual(
    detached.map((b) => b.reason),
    ['busy', 'busy', 'busy'],
  );
});

test('the result is deterministic and freshly allocated', () => {
  const first = deriveSyncActions(ctx({ ahead: 1 }));
  const second = deriveSyncActions(ctx({ ahead: 1 }));
  assert.deepEqual(first, second);
  assert.notEqual(first, second, 'callers cannot corrupt the next render');
});

test('fetch sends no prune flag', () => {
  assert.deepEqual(syncActionRequest('fetch', ctx()), { action: 'fetch' });
});

test('pull and push send the payloads the host already validates', () => {
  assert.deepEqual(syncActionRequest('pull', ctx()), { action: 'pull' });
  assert.deepEqual(syncActionRequest('push', ctx()), {
    action: 'push',
    remote: 'origin',
    branch: 'main',
    setUpstream: false,
  });
  assert.deepEqual(syncActionRequest('push', ctx({ upstream: null })), {
    action: 'push',
    remote: 'origin',
    branch: 'main',
    setUpstream: true,
  });
});

test('push builds no payload when there is no branch or no remote', () => {
  assert.equal(syncActionRequest('push', ctx({ branch: null })), null);
  assert.equal(syncActionRequest('push', ctx({ remote: null })), null);
});
