/**
 * Help route and store actions (P17).
 *
 * Help is a route like any other, so it goes through `parseRoute` at every trust
 * boundary. It is the only route that has somewhere to go back to, and that
 * memory is webview-only: it never reaches the host and never survives a reload.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROUTE, changesSubOf, parseRoute } from '../src/webview/route';
import { loadState, saveState } from '../src/webview/bridge';
import { useRouteStore } from '../src/webview/store';

function reset(route = DEFAULT_ROUTE): void {
  useRouteStore.setState({ route, pendingFocus: null, helpReturn: null });
}

test('parseRoute accepts the help route and defaults its tab to features', () => {
  assert.deepEqual(parseRoute({ id: 'help' }), { id: 'help', tab: 'features' });
  assert.deepEqual(parseRoute({ id: 'help', tab: 'features' }), { id: 'help', tab: 'features' });
  assert.deepEqual(parseRoute({ id: 'help', tab: 'shortcuts' }), { id: 'help', tab: 'shortcuts' });
});

test('parseRoute rejects an unknown help tab and a sub on the help view', () => {
  for (const raw of [
    { id: 'help', tab: 'nope' },
    { id: 'help', tab: null },
    { id: 'help', sub: 'changes' },
  ]) {
    assert.equal(parseRoute(raw), null, JSON.stringify(raw));
  }
});

test('changesSubOf reads the help route as changes, so the sub-tab strip stays empty', () => {
  assert.equal(changesSubOf({ id: 'help', tab: 'features' }), 'changes');
});

test('openHelp remembers the route it was opened from and defaults to the features tab', () => {
  reset({ id: 'branches', sub: 'tags' });
  useRouteStore.getState().openHelp();
  assert.deepEqual(useRouteStore.getState().route, { id: 'help', tab: 'features' });
  assert.deepEqual(useRouteStore.getState().helpReturn, { id: 'branches', sub: 'tags' });
});

test('openHelp switches the tab without overwriting the remembered route', () => {
  reset({ id: 'prs' });
  useRouteStore.getState().openHelp('shortcuts');
  assert.deepEqual(useRouteStore.getState().route, { id: 'help', tab: 'shortcuts' });
  useRouteStore.getState().openHelp('features');
  assert.deepEqual(useRouteStore.getState().route, { id: 'help', tab: 'features' });
  assert.deepEqual(useRouteStore.getState().helpReturn, { id: 'prs' }, 'still the original view');
});

test('closeHelp restores the previous route, persists it, and clears the memory', () => {
  reset({ id: 'changes', sub: 'stashes' });
  useRouteStore.getState().openHelp();
  useRouteStore.getState().closeHelp();
  assert.deepEqual(useRouteStore.getState().route, { id: 'changes', sub: 'stashes' });
  assert.equal(useRouteStore.getState().helpReturn, null);
  assert.deepEqual(loadState().route, { id: 'changes', sub: 'stashes' });

  // A second close has nowhere to go, so it lands on the default rather than
  // leaving the user on a panel with a dead close button.
  useRouteStore.getState().closeHelp();
  assert.deepEqual(useRouteStore.getState().route, DEFAULT_ROUTE);
});

test('navigating away from help forgets the return route', () => {
  reset({ id: 'issues' });
  useRouteStore.getState().openHelp();
  useRouteStore.getState().navigate({ id: 'actions' });
  assert.equal(useRouteStore.getState().helpReturn, null);
  assert.deepEqual(useRouteStore.getState().route, { id: 'actions' });
});

test('the help route is persisted like every other route', () => {
  reset({ id: 'prs' });
  useRouteStore.getState().openHelp('shortcuts');
  assert.deepEqual(loadState().route, { id: 'help', tab: 'shortcuts' });
});

test('hydrate never rewrites the saved route and leaves the return memory alone', () => {
  reset({ id: 'issues' });
  saveState({ route: { id: 'issues' } });
  useRouteStore.setState({ helpReturn: { id: 'issues' } });
  useRouteStore.getState().hydrate({ id: 'help', tab: 'features' });
  assert.deepEqual(useRouteStore.getState().route, { id: 'help', tab: 'features' });
  assert.deepEqual(useRouteStore.getState().helpReturn, { id: 'issues' });
  assert.deepEqual(loadState().route, { id: 'issues' }, 'hydrate does not persist');
});
