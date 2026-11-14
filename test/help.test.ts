/**
 * Help panel model (P17).
 *
 * `helpFeatureRows` decides which features the panel may advertise. A row that
 * names a view this build does not register is a dead end, so the model takes
 * the registered routes and filters, exactly like the nav strip does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { helpFeatureRows, shortcutGroups } from '../src/webview/helpModel';
import { t } from '../src/webview/i18n';
import { SHORTCUTS } from '../src/webview/shortcuts';
import type { Capability } from '../src/quickActions';
import { SHIPPED_ROUTES } from '../src/quickActions';

const ALL: ReadonlySet<Capability> = new Set<Capability>([...SHIPPED_ROUTES, 'checklist']);

test('every shipped route gets its row, in the fixed group order', () => {
  const rows = helpFeatureRows(ALL);
  assert.deepEqual(
    rows.map((r) => r.id),
    ['graph', 'changes', 'publish', 'prs', 'issues', 'actions', 'branches', 'stashes'],
  );
  const order = ['everyday', 'github', 'organize'];
  const seen = rows.map((r) => order.indexOf(r.group));
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'groups never interleave');
});

test('the graph row is always present, because the Explorer always exists', () => {
  const rows = helpFeatureRows(new Set<Capability>());
  assert.deepEqual(rows.map((r) => r.id), ['graph']);
  assert.deepEqual(rows[0]?.target, { kind: 'openExplorer' });
});

test('no row targets a route the build does not register', () => {
  const rows = helpFeatureRows(new Set<Capability>(['changes']));
  for (const row of rows) {
    if (row.target.kind !== 'navigate') continue;
    assert.ok(SHIPPED_ROUTES.has(row.target.route), `${row.id} targets ${row.target.route}`);
  }
  assert.deepEqual(rows.map((r) => r.id), ['graph', 'changes', 'publish', 'stashes']);
});

test('Publish and Stashes follow the Changes route, not a route of their own', () => {
  const rows = helpFeatureRows(new Set<Capability>(['changes']));
  const publish = rows.find((r) => r.id === 'publish');
  assert.deepEqual(publish?.target, { kind: 'navigate', route: 'changes', focus: 'publish' });
  const stashes = rows.find((r) => r.id === 'stashes');
  assert.deepEqual(stashes?.target, { kind: 'navigate', route: 'changes', sub: 'stashes' });
});

test('a feature row carries an icon and a catalog key, so nothing is hardcoded', () => {
  for (const row of helpFeatureRows(ALL)) {
    assert.ok(row.icon.length > 0, `${row.id} has no icon`);
    assert.ok(row.titleKey.length > 0, `${row.id} has no title key`);
    assert.ok(row.descKey.length > 0, `${row.id} has no description key`);
  }
});

test('every feature title and description key exists in both catalogs', () => {
  // The panel reads the catalog through a `Record<string, string>` cast, so a
  // typo in a key would render `undefined` and no compiler would notice.
  for (const row of helpFeatureRows(ALL)) {
    for (const lang of ['en', 'id'] as const) {
      const help = t(lang).help as Record<string, unknown>;
      for (const key of [row.titleKey, row.descKey]) {
        assert.equal(typeof help[key], 'string', `${lang}.help.${key} is missing (${row.id})`);
      }
    }
  }
});

test('every group and shortcut-group heading key exists in both catalogs', () => {
  // Same cast, same failure mode: the panel resolves these through the group
  // tables rather than through a row, so the row loop above cannot see them.
  const headingKeys = ['gGraph', 'gChanges', 'gMenus', 'gAnywhere'];
  for (const lang of ['en', 'id'] as const) {
    const help = t(lang).help as Record<string, unknown>;
    for (const key of headingKeys) {
      assert.equal(typeof help[key], 'string', `${lang}.help.${key} is missing`);
    }
  }
});

test('the checklist capability gates only the footer button, never a feature row', () => {
  const withFlag = helpFeatureRows(ALL).map((r) => r.id);
  const withoutFlag = helpFeatureRows(new Set<Capability>(SHIPPED_ROUTES)).map((r) => r.id);
  assert.deepEqual(withFlag, withoutFlag);
});

test('shortcutGroups returns the groups in reading order with their entries', () => {
  const groups = shortcutGroups();
  assert.deepEqual(groups.map((g) => g.id), ['graph', 'changes', 'menus', 'anywhere']);
  for (const group of groups) {
    assert.ok(group.entries.length > 0, `${group.id} is empty`);
    for (const entry of group.entries) assert.equal(entry.group, group.id);
  }
  assert.equal(
    groups.reduce((n, g) => n + g.entries.length, 0),
    SHORTCUTS.length,
    'every shortcut lands in exactly one group',
  );
});

// ------------------------------------------ create pull request row (P22)

test('the create pull request row appears once the capability is registered', () => {
  const withCreate: ReadonlySet<Capability> = new Set<Capability>([...SHIPPED_ROUTES, 'checklist', 'create-pr']);
  const row = helpFeatureRows(withCreate).find((entry) => entry.id === 'createPr');
  assert.ok(row !== undefined, 'the panel advertises the new dialog');
  assert.equal(row.group, 'github');
  assert.deepEqual(row.target, { kind: 'navigate', route: 'prs', focus: 'create-pr' });

  // Without the capability the row is absent, so a build that lacks the dialog
  // never advertises it.
  assert.equal(
    helpFeatureRows(new Set<Capability>([...SHIPPED_ROUTES, 'checklist'])).find((e) => e.id === 'createPr'),
    undefined,
  );
});
