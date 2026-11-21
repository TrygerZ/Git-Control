import test from 'node:test';
import assert from 'node:assert/strict';
import { bridge, BridgeRequestError } from '../src/webview/bridge';
import { useReleaseStore } from '../src/webview/store';
import { t } from '../src/webview/i18n';

interface Call {
  kind: string;
  payload: unknown;
}

function stubBridge(reply: (kind: string, payload: unknown) => unknown): { calls: Call[]; restore(): void } {
  const calls: Call[] = [];
  const original = bridge.request;
  bridge.request = (async (kind: string, payload: unknown): Promise<unknown> => {
    calls.push({ kind, payload });
    return reply(kind, payload);
  }) as typeof bridge.request;
  return {
    calls,
    restore() {
      bridge.request = original;
    },
  };
}

test('useReleaseStore.openDialog never runs any command on open', () => {
  const s = stubBridge(() => {
    throw new Error('should not be called');
  });
  try {
    useReleaseStore.getState().openDialog({ tag: 'v2.8.0', target: 'main', title: 'v2.8.0', remote: 'origin' });
    const state = useReleaseStore.getState();
    assert.equal(state.open, true);
    assert.equal(state.phase, 'idle');
    assert.equal(state.form.tag, 'v2.8.0');
    assert.equal(s.calls.length, 0);
  } finally {
    s.restore();
    useReleaseStore.getState().reset();
  }
});

test('useReleaseStore.submit("tag") runs tag-create and tag-push only, never calls GitHub API', async () => {
  const s = stubBridge((kind) => {
    if (kind === 'repos/refs') return { refs: [], head: null, currentBranch: 'main', base: 'main' };
    if (kind === 'repos/worktrees') return { worktrees: [] };
    return { success: true };
  });
  try {
    useReleaseStore.getState().openDialog({
      tag: 'v2.8.0',
      target: 'main',
      title: 'v2.8.0',
      annotated: true,
      remote: 'origin',
    });
    await useReleaseStore.getState().submit('tag');

    const gitCalls = s.calls.filter((c) => c.kind === 'actions/git');
    assert.equal(gitCalls.length, 2);
    assert.equal((gitCalls[0]!.payload as { action: string }).action, 'tag-create');
    assert.equal((gitCalls[1]!.payload as { action: string }).action, 'tag-push');
    assert.equal(
      s.calls.some((c) => c.kind.startsWith('github/')),
      false,
      'Tag only must never call GitHub API',
    );
    const state = useReleaseStore.getState();
    assert.equal(state.phase, 'done');
    assert.equal(state.steps.tag, 'done');
    assert.equal(state.steps.push, 'done');
    assert.equal(state.steps.release, 'skipped');
  } finally {
    s.restore();
    useReleaseStore.getState().reset();
  }
});

test('useReleaseStore.submit("release") runs tag-create -> tag-push -> createRelease in order and guards double click', async () => {
  let releaseCalls = 0;
  const s = stubBridge(async (kind) => {
    if (kind === 'repos/refs') return { refs: [], head: null, currentBranch: 'main', base: 'main' };
    if (kind === 'repos/worktrees') return { worktrees: [] };
    if (kind === 'github/createRelease') {
      releaseCalls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { id: 55, htmlUrl: 'https://github.com/o/r/releases/tag/v2.8.0' };
    }
    return { success: true };
  });
  try {
    useReleaseStore.getState().openDialog({
      tag: 'v2.8.0',
      target: 'main',
      title: 'v2.8.0',
      notes: '## Notes',
      annotated: true,
      prerelease: false,
      remote: 'origin',
    });

    const p1 = useReleaseStore.getState().submit('release', 'o', 'r');
    const p2 = useReleaseStore.getState().submit('release', 'o', 'r');
    await Promise.all([p1, p2]);

    assert.equal(releaseCalls, 1, 'double click must create only one release');
    const orderedKinds = s.calls
      .filter((c) => c.kind === 'actions/git' || c.kind === 'github/createRelease')
      .map((c) => (c.kind === 'actions/git' ? (c.payload as { action: string }).action : c.kind));
    assert.deepEqual(orderedKinds, ['tag-create', 'tag-push', 'github/createRelease']);

    const state = useReleaseStore.getState();
    assert.equal(state.phase, 'done');
    assert.equal(state.steps.tag, 'done');
    assert.equal(state.steps.push, 'done');
    assert.equal(state.steps.release, 'done');
    assert.equal(state.createdUrl, 'https://github.com/o/r/releases/tag/v2.8.0');
  } finally {
    s.restore();
    useReleaseStore.getState().reset();
  }
});

test('useReleaseStore stops on partial failure, keeps earlier steps, maps errors, and retries from failed step', async () => {
  let failRelease = true;
  const s = stubBridge((kind) => {
    if (kind === 'repos/refs') return { refs: [], head: null, currentBranch: 'main', base: 'main' };
    if (kind === 'repos/worktrees') return { worktrees: [] };
    if (kind === 'github/createRelease') {
      if (failRelease) {
        throw new BridgeRequestError({ status: 403, code: 'FORBIDDEN', message: 'missing scope' });
      }
      return { id: 88, htmlUrl: 'https://github.com/o/r/releases/tag/v2.8.0' };
    }
    return { success: true };
  });
  try {
    useReleaseStore.getState().openDialog({
      tag: 'v2.8.0',
      target: 'main',
      title: 'v2.8.0',
      notes: '## Notes',
      annotated: true,
      prerelease: false,
      remote: 'origin',
    });

    await useReleaseStore.getState().submit('release', 'o', 'r');
    let state = useReleaseStore.getState();
    assert.equal(state.phase, 'failed');
    assert.equal(state.failedStep, 'release');
    assert.equal(state.steps.tag, 'done');
    assert.equal(state.steps.push, 'done');
    assert.equal(state.steps.release, 'failed');
    assert.equal(state.error, t('en').release.needScope);

    // Retry skips tag-create and tag-push, runs only github/createRelease
    failRelease = false;
    s.calls.length = 0;
    await useReleaseStore.getState().submit('release', 'o', 'r');
    const retryKinds = s.calls
      .filter((c) => c.kind === 'actions/git' || c.kind === 'github/createRelease')
      .map((c) => (c.kind === 'actions/git' ? (c.payload as { action: string }).action : c.kind));
    assert.deepEqual(retryKinds, ['github/createRelease']);

    state = useReleaseStore.getState();
    assert.equal(state.phase, 'done');
    assert.equal(state.createdUrl, 'https://github.com/o/r/releases/tag/v2.8.0');
  } finally {
    s.restore();
    useReleaseStore.getState().reset();
  }
});

test('useReleaseStore.generateNotes populates notes and title from GitHub response', async () => {
  const s = stubBridge((kind) => {
    if (kind === 'github/releaseNotes') {
      return {
        name: 'v2.8.0',
        body: "## What's Changed\n* feat: tags",
        rateLimit: { limit: 5000, remaining: 4999, resetAt: null, cached: false, offline: false },
      };
    }
    return {};
  });
  try {
    useReleaseStore.getState().openDialog({ tag: 'v2.8.0', target: 'main', title: '', remote: 'origin' });
    await useReleaseStore.getState().generateNotes('o', 'r', 'v2.7.0');
    const state = useReleaseStore.getState();
    assert.equal(state.generating, false);
    assert.equal(state.form.notes, "## What's Changed\n* feat: tags");
    assert.equal(state.form.title, 'v2.8.0');
    assert.equal(state.notesError, null);
  } finally {
    s.restore();
    useReleaseStore.getState().reset();
  }
});
