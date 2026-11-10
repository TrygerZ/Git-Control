/**
 * Sidebar route model, state persistence, and store plumbing (P03).
 *
 * `parseRoute` is the single gate for routes arriving from the host and from
 * webview `getState`, so these tests pin what it accepts and, more important,
 * what it refuses and what it strips.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROUTE,
  PENDING_ROUTE_TTL_MS,
  changesSubOf,
  isFresh,
  parseRoute,
  resolveInitialRoute,
  sameRoute,
} from '../src/webview/route';
import { bridge, loadState, saveState, type WebviewState } from '../src/webview/bridge';
import { useRouteStore, wireHostEvents } from '../src/webview/store';
import type { Route } from '../src/messages';

const VALID_ROUTES: readonly Route[] = [
  { id: 'changes', sub: 'changes' },
  { id: 'changes', sub: 'stashes' },
  { id: 'branches', sub: 'local' },
  { id: 'branches', sub: 'remote' },
  { id: 'branches', sub: 'tags' },
  { id: 'prs' },
  { id: 'issues' },
  { id: 'actions' },
];

test('parseRoute returns an equal route for all 8 valid routes', () => {
  for (const route of VALID_ROUTES) assert.deepEqual(parseRoute(route), route);
});

test('parseRoute fills the default sub-tab when it is missing', () => {
  assert.deepEqual(parseRoute({ id: 'changes' }), { id: 'changes', sub: 'changes' });
  assert.deepEqual(parseRoute({ id: 'branches' }), { id: 'branches', sub: 'local' });
});

test('parseRoute rejects unknown ids, subs on the wrong view, and non-objects', () => {
  const rejected: unknown[] = [
    { id: 'nope' },
    { id: 'Changes' },
    { id: '' },
    { id: 7 },
    {},
    { id: 'changes', sub: 'local' },
    { id: 'changes', sub: 'nope' },
    { id: 'changes', sub: null },
    { id: 'branches', sub: 'stashes' },
    { id: 'prs', sub: 'changes' },
    { id: 'issues', sub: '' },
    { id: 'actions', sub: null },
    { id: 'changes', sub: '__proto__' },
    null,
    undefined,
    'prs',
    42,
    true,
  ];
  for (const raw of rejected) assert.equal(parseRoute(raw), null, JSON.stringify(raw));
});

test('parseRoute copies known fields only, so extra keys never survive', () => {
  assert.deepEqual(parseRoute({ id: 'prs', extra: 1, path: '/etc/passwd' }), { id: 'prs' });
  assert.deepEqual(parseRoute({ id: 'branches', sub: 'tags', token: 'x' }), { id: 'branches', sub: 'tags' });
});

test('sameRoute compares id and sub', () => {
  assert.equal(sameRoute({ id: 'prs' }, { id: 'prs' }), true);
  assert.equal(sameRoute({ id: 'prs' }, { id: 'issues' }), false);
  assert.equal(sameRoute({ id: 'changes', sub: 'changes' }, { id: 'changes', sub: 'stashes' }), false);
  assert.equal(sameRoute({ id: 'branches', sub: 'tags' }, { id: 'branches', sub: 'tags' }), true);
  assert.equal(sameRoute({ id: 'changes', sub: 'changes' }, { id: 'branches', sub: 'local' }), false);
});

test('resolveInitialRoute prefers pending, then local, then the default', () => {
  const pending: Route = { id: 'prs' };
  const local: Route = { id: 'branches', sub: 'remote' };
  assert.deepEqual(resolveInitialRoute({ pending, local }), pending);
  assert.deepEqual(resolveInitialRoute({ pending, local: { id: 'bogus' } }), pending);
  assert.deepEqual(resolveInitialRoute({ pending, local: undefined }), pending);
  assert.deepEqual(resolveInitialRoute({ pending: null, local }), local);
  assert.deepEqual(resolveInitialRoute({ pending: null, local: { id: 'bogus' } }), DEFAULT_ROUTE);
  assert.deepEqual(resolveInitialRoute({ pending: null, local: undefined }), DEFAULT_ROUTE);
  assert.deepEqual(resolveInitialRoute({ pending: null, local: 'prs' }), DEFAULT_ROUTE);
});

test('changesSubOf reads the Changes sub-tab and falls back to changes for every other view', () => {
  assert.equal(changesSubOf({ id: 'changes', sub: 'changes' }), 'changes');
  assert.equal(changesSubOf({ id: 'changes', sub: 'stashes' }), 'stashes');
  // No other view is registered yet, but a restored or pushed route can still name one.
  for (const route of [{ id: 'prs' }, { id: 'issues' }, { id: 'actions' }, { id: 'branches', sub: 'tags' }] as const) {
    assert.equal(changesSubOf(route), 'changes', route.id);
  }
});

test('isFresh holds up to the ttl and not past it', () => {
  assert.equal(PENDING_ROUTE_TTL_MS, 30_000);
  assert.equal(isFresh(1_000, 1_000, PENDING_ROUTE_TTL_MS), true);
  assert.equal(isFresh(1_000, 1_000 + PENDING_ROUTE_TTL_MS, PENDING_ROUTE_TTL_MS), true);
  assert.equal(isFresh(1_000, 1_001 + PENDING_ROUTE_TTL_MS, PENDING_ROUTE_TTL_MS), false);
});

test('loadState falls back to the default route and keeps the other keys', () => {
  saveState({ commitMessage: 'keep me', route: { id: 'bogus' } as unknown as Route });
  const state = loadState();
  assert.deepEqual(state.route, DEFAULT_ROUTE);
  assert.equal(state.commitMessage, 'keep me');

  saveState({ route: { id: 'issues' } });
  assert.deepEqual(loadState().route, { id: 'issues' });
  assert.equal(loadState().commitMessage, 'keep me');
});

test('navigate persists the route in webview state, hydrate does not', () => {
  useRouteStore.setState({ route: DEFAULT_ROUTE });
  useRouteStore.getState().navigate({ id: 'prs' });
  assert.deepEqual(useRouteStore.getState().route, { id: 'prs' });
  assert.deepEqual(loadState().route, { id: 'prs' });

  useRouteStore.getState().hydrate({ id: 'issues' });
  assert.deepEqual(useRouteStore.getState().route, { id: 'issues' });
  assert.deepEqual(loadState().route, { id: 'prs' });
});

function stubRequest(reply: (kind: string) => unknown): () => void {
  const original = bridge.request;
  bridge.request = (async (kind: any): Promise<any> => reply(kind)) as any;
  return () => {
    bridge.request = original;
  };
}

test('pullPending applies a queued route and keeps the current one when nothing is queued', async () => {
  useRouteStore.setState({ route: DEFAULT_ROUTE });

  let restore = stubRequest(() => ({ route: { id: 'branches', sub: 'tags' } }));
  await useRouteStore.getState().pullPending();
  restore();
  assert.deepEqual(useRouteStore.getState().route, { id: 'branches', sub: 'tags' });
  assert.deepEqual(loadState().route, { id: 'branches', sub: 'tags' });

  restore = stubRequest(() => ({ route: null }));
  await useRouteStore.getState().pullPending();
  restore();
  assert.deepEqual(useRouteStore.getState().route, { id: 'branches', sub: 'tags' });

  restore = stubRequest(() => {
    throw new Error('host unavailable');
  });
  await useRouteStore.getState().pullPending();
  restore();
  assert.deepEqual(useRouteStore.getState().route, { id: 'branches', sub: 'tags' });
});

test('event/navigate reaches the store in the sidebar only and clears the host queue', () => {
  const receive = (message: unknown): void => (bridge as unknown as { receive(m: unknown): void }).receive(message);
  const requested: string[] = [];
  const restore = stubRequest((kind) => {
    requested.push(kind);
    return { route: null };
  });
  try {
    useRouteStore.setState({ route: DEFAULT_ROUTE });

    const offExplorer = wireHostEvents('explorer');
    receive({ kind: 'event/navigate', payload: { route: { id: 'actions' } } });
    assert.deepEqual(useRouteStore.getState().route, DEFAULT_ROUTE, 'explorer ignores navigate');
    assert.deepEqual(requested, []);
    offExplorer();

    const offPending = wireHostEvents('pending');
    receive({ kind: 'event/navigate', payload: { route: { id: 'actions' } } });
    assert.deepEqual(useRouteStore.getState().route, { id: 'actions' });
    assert.deepEqual(requested, ['ui/takePendingRoute'], 'a delivered route is cleared on the host');

    receive({ kind: 'event/navigate', payload: { route: { id: 'nope' } } });
    assert.deepEqual(useRouteStore.getState().route, { id: 'actions' }, 'invalid route is dropped');

    offPending();
    receive({ kind: 'event/navigate', payload: { route: { id: 'prs' } } });
    assert.deepEqual(useRouteStore.getState().route, { id: 'actions' }, 'cleanup unsubscribes navigate');
  } finally {
    restore();
  }
});

test('prFilter and prQuery survive a saveState/loadState round trip', () => {
  saveState({ prFilter: 'mine', prQuery: 'graph' });
  const state = loadState();
  assert.equal(state.prFilter, 'mine');
  assert.equal(state.prQuery, 'graph');

  // An unknown filter id and a non-string query fall back to the defaults
  // rather than reaching the view, for the same reason `parseRoute` drops
  // unknown ids: the value comes from storage, not from this build.
  saveState({ prFilter: 'bogus' as unknown as WebviewState['prFilter'], prQuery: 7 as unknown as string });
  const restored = loadState();
  assert.equal(restored.prFilter, 'open');
  assert.equal(restored.prQuery, '');
});

test('a navigate event with a focus target lands in the pending-focus store', () => {
  const receive = (message: unknown): void => (bridge as unknown as { receive(m: unknown): void }).receive(message);
  const restore = stubRequest(() => ({ route: null }));
  try {
    useRouteStore.setState({ route: DEFAULT_ROUTE });
    useRouteStore.setState({ pendingFocus: null });

    const off = wireHostEvents('pending');
    receive({ kind: 'event/navigate', payload: { route: { id: 'changes', sub: 'changes' }, focus: 'publish' } });
    assert.deepEqual(useRouteStore.getState().route, { id: 'changes', sub: 'changes' });
    assert.equal(useRouteStore.getState().pendingFocus, 'publish', 'the view consumes the focus once');

    // Consuming clears it, so a later repaint cannot steal focus again.
    assert.equal(useRouteStore.getState().takeFocus(), 'publish');
    assert.equal(useRouteStore.getState().pendingFocus, null);
    assert.equal(useRouteStore.getState().takeFocus(), null);

    // A route without a focus target leaves nothing to consume.
    receive({ kind: 'event/navigate', payload: { route: { id: 'issues' } } });
    assert.equal(useRouteStore.getState().pendingFocus, null);
    off();
  } finally {
    restore();
  }
});
