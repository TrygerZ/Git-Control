/**
 * Configured remotes in the repo store (P16).
 *
 * `repos/remotes` is the only source that knows about a remote added with
 * `git remote add` but never fetched. The graph ref list cannot answer that
 * question, which is why the store caches this separately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bridge } from '../src/webview/bridge';
import { useRepoStore } from '../src/webview/store';
import type { RemoteInfo } from '../src/messages';

const REMOTE: RemoteInfo = {
  name: 'origin',
  fetchUrl: 'https://github.com/o/r.git',
  pushUrl: 'https://github.com/o/r.git',
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  isGitHub: true,
};

interface Call {
  kind: string;
  payload: unknown;
}

function stub(reply: (kind: string) => unknown): { calls: Call[]; restore(): void } {
  const calls: Call[] = [];
  const original = bridge.request;
  bridge.request = (async (kind: string, payload: unknown): Promise<unknown> => {
    calls.push({ kind, payload });
    return reply(kind);
  }) as typeof bridge.request;
  return {
    calls,
    restore: () => {
      bridge.request = original;
    },
  };
}

function reset(): void {
  useRepoStore.setState({ remotes: null });
}

test('remotes start unknown, which is not the same as absent', () => {
  reset();
  assert.equal(useRepoStore.getState().remotes, null);
});

test('loadRemotes caches the configured list once', async (t) => {
  reset();
  const s = stub(() => ({ remotes: [REMOTE] }));
  t.after(s.restore);

  await useRepoStore.getState().loadRemotes();
  assert.deepEqual(useRepoStore.getState().remotes, [REMOTE]);
  assert.equal(s.calls.filter((call) => call.kind === 'repos/remotes').length, 1);
});

test('a second load is served from the cache, not from a new request', async (t) => {
  reset();
  const s = stub(() => ({ remotes: [REMOTE] }));
  t.after(s.restore);

  await useRepoStore.getState().loadRemotes();
  await useRepoStore.getState().loadRemotes();
  assert.equal(s.calls.filter((call) => call.kind === 'repos/remotes').length, 1);
});

test('a configured remote with no fetched refs still counts', async (t) => {
  reset();
  const s = stub(() => ({ remotes: [REMOTE] }));
  t.after(s.restore);

  // The graph holds no `refs/remotes/*` because nothing was pushed yet.
  useRepoStore.setState({ graph: { nodes: [], edges: [], lanes: [], dateBuckets: [], refs: [], head: null, truncated: false, nextCursor: null, stale: false } as never });
  await useRepoStore.getState().loadRemotes();
  assert.equal(useRepoStore.getState().remotes?.length, 1, 'the configured remote is known');
});

test('a failed read leaves the cache unknown so the next mount retries', async (t) => {
  reset();
  const s = stub(() => {
    throw new Error('git failed');
  });
  t.after(s.restore);

  await useRepoStore.getState().loadRemotes();
  assert.equal(useRepoStore.getState().remotes, null);
});

test('invalidate drops the cache, so a repository switch cannot keep the old remotes', () => {
  useRepoStore.setState({ remotes: [REMOTE] });
  useRepoStore.getState().invalidateRemotes();
  assert.equal(useRepoStore.getState().remotes, null);
});
