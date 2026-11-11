/**
 * Explorer More menu model (P18), frame 17.
 *
 * Pure model: order, gating, counts, and the GitHub group. The rendered menu is
 * pinned separately at the source level in `explorerHeader.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildMoreMenu, quickActionsHint, type MoreMenuContext } from '../src/webview/explorerMenu';
import type { RouteId } from '../src/messages';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const ALL: ReadonlySet<RouteId> = new Set<RouteId>([
  'changes',
  'prs',
  'issues',
  'actions',
  'branches',
  'help',
]);

function ctx(patch: Partial<MoreMenuContext> = {}): MoreMenuContext {
  return {
    available: ALL,
    quickActionsAvailable: true,
    counts: { changes: 6, prs: 12 },
    github: { linked: true, connected: true, login: 'TrygerZ' },
    ...patch,
  };
}

const ids = (groups: ReturnType<typeof buildMoreMenu>): string[] =>
  groups.flatMap((g) => g.map((i) => i.id));

test('group and item order match frame 17', () => {
  const groups = buildMoreMenu(ctx());
  assert.deepEqual(
    groups.map((g) => g.map((i) => i.id)),
    [
      ['quick'],
      ['view.changes', 'view.prs', 'view.issues', 'view.actions', 'view.branches'],
      ['refresh', 'logs'],
      ['github.disconnect'],
      ['repository'],
    ],
  );
});

test('each view item opens its own route', () => {
  const groups = buildMoreMenu(ctx());
  const views = groups[1] ?? [];
  assert.deepEqual(
    views.map((i) => i.route),
    [
      { id: 'changes', sub: 'changes' },
      { id: 'prs' },
      { id: 'issues' },
      { id: 'actions' },
      { id: 'branches', sub: 'local' },
    ],
  );
  // Non-view items carry no route, so they can never be mistaken for navigation.
  for (const item of [...(groups[0] ?? []), ...(groups[2] ?? []), ...(groups[3] ?? []), ...(groups[4] ?? [])]) {
    assert.equal(item.route, null, `${item.id} carries no route`);
  }
});

test('unregistered views are omitted', () => {
  const groups = buildMoreMenu(ctx({ available: new Set<RouteId>(['changes', 'branches']) }));
  assert.deepEqual(
    groups[1]?.map((i) => i.id),
    ['view.changes', 'view.branches'],
  );
});

test('Quick actions is omitted when the palette is not shipped', () => {
  const groups = buildMoreMenu(ctx({ quickActionsAvailable: false }));
  assert.deepEqual(ids(groups), [
    'view.changes',
    'view.prs',
    'view.issues',
    'view.actions',
    'view.branches',
    'refresh',
    'logs',
    'github.disconnect',
    'repository',
  ]);
  assert.equal(groups.length, 4, 'the quick group disappears entirely');
});

test('Quick actions carries the contributed chord as its hint', () => {
  const quick = buildMoreMenu(ctx())[0]?.[0];
  assert.equal(quick?.hint, 'shortcut');
  assert.equal(quickActionsHint(), 'Ctrl K G');
});

test('signed out offers Connect with no login, signed in offers Disconnect with the login', () => {
  const out = buildMoreMenu(ctx({ github: { linked: true, connected: false, login: null } }));
  assert.deepEqual(out[3]?.map((i) => i.id), ['github.connect']);
  assert.equal(out[3]?.[0]?.hint, null);
  assert.equal(out[3]?.[0]?.login, null);

  const in_ = buildMoreMenu(ctx());
  assert.deepEqual(in_[3]?.map((i) => i.id), ['github.disconnect']);
  assert.equal(in_[3]?.[0]?.hint, 'login');
  assert.equal(in_[3]?.[0]?.login, 'TrygerZ');
});

test('a repository without a GitHub remote omits the GitHub group and keeps the rest', () => {
  const groups = buildMoreMenu(ctx({ github: { linked: false, connected: false, login: null } }));
  assert.equal(groups.length, 4);
  assert.equal(ids(groups).some((id) => id.startsWith('github.')), false);
});

test('a null count draws no count, a real count is passed through', () => {
  const groups = buildMoreMenu(ctx({ counts: { changes: null, prs: 12 } }));
  const views = groups[1] ?? [];
  assert.equal(views[0]?.count, null, 'unknown Changes count stays null');
  assert.equal(views[1]?.count, 12);
});

test('the output is deterministic for the same input', () => {
  assert.deepEqual(buildMoreMenu(ctx()), buildMoreMenu(ctx()));
});

test('the hint text is the shipped chord, not a second hand-written copy', () => {
  // The panel and the palette must agree on one chord. `test/shortcuts.test.ts`
  // already ties the inventory to `package.json`, so this only needs to prove the
  // menu reads it instead of restating it.
  const src = read('src/webview/explorerMenu.ts');
  assert.match(src, /SHORTCUTS/, 'the menu reads the shared inventory');
  assert.doesNotMatch(src, /Ctrl K G|ctrl\+k g/i, 'no hardcoded chord');
});
