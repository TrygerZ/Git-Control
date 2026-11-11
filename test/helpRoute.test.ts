/**
 * Help route and store actions (P17).
 *
 * Help is a route like any other, so it goes through `parseRoute` at every trust
 * boundary. It is the only route that has somewhere to go back to. That memory
 * never reaches the host, but it is persisted beside the route so a rebuilt
 * webview can still return, which the reload case below pins.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROUTE, changesSubOf, parseRoute, sameRoute } from '../src/webview/route';
import { loadState, saveState } from '../src/webview/bridge';
import { useRouteStore } from '../src/webview/store';
import type { Route } from '../src/messages';

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

test('opening help from the host or the palette still remembers where to go back to', () => {
  // The command and the Quick actions row push `event/navigate`, which lands in
  // `navigateWithFocus`; `openHelp` is never called. The transition into help is
  // what has to capture the origin, or close lands on the default route.
  reset({ id: 'issues' });
  useRouteStore.getState().navigateWithFocus({ id: 'help', tab: 'features' }, null);
  assert.deepEqual(useRouteStore.getState().helpReturn, { id: 'issues' });
  useRouteStore.getState().closeHelp();
  assert.deepEqual(useRouteStore.getState().route, { id: 'issues' });
});

test('a reload that restores the help route still knows where to go back to', () => {
  // `helpReturn` is session memory and the route is persisted, so a rebuilt
  // webview restores `{ id: 'help' }` with nothing to return to. The persisted
  // return route is what closes that gap.
  reset({ id: 'branches', sub: 'tags' });
  saveState({ route: { id: 'help', tab: 'features' }, helpReturn: { id: 'branches', sub: 'tags' } });
  const persisted = loadState();
  assert.deepEqual(persisted.route, { id: 'help', tab: 'features' });
  assert.deepEqual(persisted.helpReturn, { id: 'branches', sub: 'tags' });

  useRouteStore.setState({ route: DEFAULT_ROUTE, helpReturn: null });
  useRouteStore.getState().hydrate(persisted.route, persisted.helpReturn);
  useRouteStore.getState().closeHelp();
  assert.deepEqual(useRouteStore.getState().route, { id: 'branches', sub: 'tags' });
});

test('a queued help route that only changes tab is not dropped as already current', () => {
  // `sameRoute` compares the second dimension. Help's is `tab`, not `sub`, so a
  // queued switch from Shortcuts to Features has to survive the comparison.
  reset({ id: 'help', tab: 'shortcuts' });
  assert.equal(sameRoute({ id: 'help', tab: 'shortcuts' }, { id: 'help', tab: 'features' }), false);
  assert.equal(sameRoute({ id: 'help', tab: 'features' }, { id: 'help', tab: 'features' }), true);
});

test('a persisted return route that is not a valid route is dropped, not stored', () => {
  saveState({ helpReturn: { id: 'nope' } as unknown as Route });
  assert.equal(loadState().helpReturn, null);
  saveState({ helpReturn: { id: 'help', tab: 'features' } });
  assert.equal(loadState().helpReturn, null, 'help cannot return to itself');
});

test('only close asks for focus back, navigation away does not', () => {
  // The shell returns focus to the opener on the way out of help. That is correct
  // for Back and Close, which have no other target, and wrong for every other exit:
  // a nav strip click, a feature row, or the Publish row already own their focus.
  // So the request is a one-shot flag set by `closeHelp` and consumed by the shell,
  // never inferred from "the route used to be help".
  reset({ id: 'prs' });
  useRouteStore.getState().openHelp();
  assert.equal(useRouteStore.getState().takeHelpFocusReturn(), false, 'opening does not ask');
  useRouteStore.getState().closeHelp();
  assert.equal(useRouteStore.getState().takeHelpFocusReturn(), true, 'closing asks once');
  assert.equal(useRouteStore.getState().takeHelpFocusReturn(), false, 'and only once');

  for (const exit of [
    () => useRouteStore.getState().navigate({ id: 'actions' }),
    () => useRouteStore.getState().navigateWithFocus({ id: 'changes', sub: 'changes' }, 'publish'),
  ]) {
    reset({ id: 'prs' });
    useRouteStore.getState().openHelp();
    exit();
    assert.equal(useRouteStore.getState().takeHelpFocusReturn(), false, 'navigation never asks');
  }
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
