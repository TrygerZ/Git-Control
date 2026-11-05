/**
 * Sidebar nav registry, tab key model, and badge text (P05).
 *
 * All three are pure, so they are pinned here without react or a store. The strip
 * stays hidden below two destinations (D-06), which is what makes shipping the
 * registry before any second view safe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_VISIBLE_DESTINATIONS,
  createNavRegistry,
  isNavVisible,
  navRegistry,
  nextTabIndex,
  routeForNav,
  type NavDestination,
} from '../src/webview/navRegistry';
import { formatBadge, navBadge } from '../src/webview/navCounts';
import type { Route } from '../src/messages';

function dest(id: NavDestination['id'], order: number, extra: Partial<NavDestination> = {}): NavDestination {
  return {
    id,
    order,
    icon: 'changes',
    label: () => id,
    ariaName: (_strings, count) => `${id}:${String(count)}`,
    requiresGitHub: false,
    ...extra,
  };
}

// ----------------------------------------------------------------- registry

test('registry lists destinations by order, not by registration order', () => {
  const registry = createNavRegistry();
  registry.register(dest('branches', 50));
  registry.register(dest('changes', 10));
  registry.register(dest('actions', 40));
  registry.register(dest('prs', 20));
  assert.deepEqual(
    registry.list().map((d) => d.id),
    ['changes', 'prs', 'actions', 'branches'],
  );
});

test('registering an id again replaces it and keeps one entry', () => {
  const registry = createNavRegistry();
  registry.register(dest('changes', 10));
  registry.register(dest('prs', 20));
  registry.register(dest('changes', 30, { requiresGitHub: true }));
  const list = registry.list();
  assert.deepEqual(
    list.map((d) => d.id),
    ['prs', 'changes'],
    'the replacement takes the new order',
  );
  assert.equal(list[1]?.requiresGitHub, true);
});

test('each registry is independent, and the shared one is a registry', () => {
  const a = createNavRegistry();
  const b = createNavRegistry();
  a.register(dest('changes', 10));
  assert.equal(a.list().length, 1);
  assert.equal(b.list().length, 0);
  assert.equal(typeof navRegistry.register, 'function');
  assert.ok(Array.isArray(navRegistry.list()));
});

test('the strip needs at least two destinations to show', () => {
  assert.equal(MIN_VISIBLE_DESTINATIONS, 2);
  assert.equal(isNavVisible(0), false);
  assert.equal(isNavVisible(1), false);
  for (const count of [2, 3, 4, 5]) assert.equal(isNavVisible(count), true, String(count));
});

// ---------------------------------------------------------------- tab keys

test('ArrowRight and ArrowLeft move one tab and wrap at both ends', () => {
  assert.equal(nextTabIndex(0, 'ArrowRight', 5), 1);
  assert.equal(nextTabIndex(3, 'ArrowRight', 5), 4);
  assert.equal(nextTabIndex(4, 'ArrowRight', 5), 0);
  assert.equal(nextTabIndex(4, 'ArrowLeft', 5), 3);
  assert.equal(nextTabIndex(1, 'ArrowLeft', 5), 0);
  assert.equal(nextTabIndex(0, 'ArrowLeft', 5), 4);
});

test('Home and End jump to the first and last tab', () => {
  assert.equal(nextTabIndex(3, 'Home', 5), 0);
  assert.equal(nextTabIndex(0, 'Home', 5), 0);
  assert.equal(nextTabIndex(1, 'End', 5), 4);
  assert.equal(nextTabIndex(4, 'End', 5), 4);
});

test('other keys are ignored so Tab can leave the strip', () => {
  for (const key of ['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'Escape', 'a', 'Shift', '']) {
    assert.equal(nextTabIndex(2, key, 5), null, JSON.stringify(key));
  }
});

test('an empty strip has no target for any key', () => {
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.equal(nextTabIndex(0, key, 0), null, key);
  }
  assert.equal(nextTabIndex(0, 'ArrowRight', 1), 0, 'a single tab wraps onto itself');
});

// ------------------------------------------------------------------ routing

test('choosing another view lands on that view default sub-tab', () => {
  const fromChanges: Route = { id: 'changes', sub: 'changes' };
  assert.deepEqual(routeForNav(fromChanges, 'prs'), { id: 'prs' });
  assert.deepEqual(routeForNav(fromChanges, 'branches'), { id: 'branches', sub: 'local' });
  assert.deepEqual(routeForNav({ id: 'prs' }, 'changes'), { id: 'changes', sub: 'changes' });
});

test('choosing the active view keeps its sub-tab instead of resetting it', () => {
  const stashes: Route = { id: 'changes', sub: 'stashes' };
  assert.deepEqual(routeForNav(stashes, 'changes'), stashes);
  const remote: Route = { id: 'branches', sub: 'remote' };
  assert.deepEqual(routeForNav(remote, 'branches'), remote);
});

// ------------------------------------------------------------------- badges

test('formatBadge shows 1 to 99 as is and caps larger counts at 99+', () => {
  assert.equal(formatBadge(1), '1');
  assert.equal(formatBadge(12), '12');
  assert.equal(formatBadge(99), '99');
  assert.equal(formatBadge(100), '99+');
  assert.equal(formatBadge(5000), '99+');
});

test('formatBadge draws nothing for zero, unknown, or a count that is not a whole number', () => {
  for (const value of [0, null, undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatBadge(value), null, String(value));
  }
});

test('a signed-out user gets no badge on a GitHub view, while a local view keeps it', () => {
  const github = { requiresGitHub: true };
  const local = { requiresGitHub: false };
  assert.equal(navBadge(github, 12, false), null);
  assert.equal(navBadge(github, 12, true), '12');
  assert.equal(navBadge(local, 6, false), '6');
  assert.equal(navBadge(local, 0, true), null);
});
