/**
 * Node context menu, frame 03 (`15:2`).
 *
 * The frame draws three named groups and one footer hint box:
 *   Inspect         - read-only: open the diff, copy hashes, open on GitHub
 *   Branch          - checkout, create a branch here, merge, push up to here
 *   Rewrite history - cherry-pick, revert, reset soft, reset hard
 * and a `FocusHint` (`15:91`, 286x46) that explains the item the pointer or the
 * keyboard cursor is on.
 *
 * Two rules survive the regrouping, and they are why this is tested rather than
 * eyeballed: the read-only group can never run git, and every item that can run
 * git says which group it is in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  focusHintFor,
  groupedMenuItems,
  menuGroupLabel,
  menuItemsFor,
  type MenuItem,
} from '../src/webview/NodeContextMenu';
import type { GraphNode, RefInfo, RepoStatus } from '../src/messages';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const HASH = '0123456789012345678901234567890123456789';

function node(patch: Partial<GraphNode> = {}): GraphNode {
  return {
    hash: HASH,
    shortHash: HASH.slice(0, 7),
    x: 0,
    y: 0,
    lane: 0,
    isHead: false,
    isMerge: false,
    local: true,
    subject: 'fix: dispose menus',
    authorName: 'Tryger',
    authoredAt: '',
    refNames: [],
    ...patch,
  };
}

function ref(patch: Partial<RefInfo> = {}): RefInfo {
  return {
    refName: 'refs/heads/main',
    shortName: 'main',
    kind: 'local',
    objectName: HASH,
    upstream: null,
    ahead: 0,
    behind: 0,
    isHead: false,
    gone: false,
    committedAt: null,
    ...patch,
  };
}

function status(patch: Partial<RepoStatus> = {}): RepoStatus {
  return {
    repoRoot: 'D:/repo',
    branch: 'main',
    head: HASH,
    detached: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    incoming: 0,
    outgoing: 0,
    dirty: false,
    staged: false,
    operation: 'idle',
    changes: [],
    conflicts: [],
    churnTruncated: false,
    statusToken: 'token',
    lastFetchedAt: null,
    lastFetchAt: null,
    ...patch,
  };
}

const refs = [
  ref({ shortName: 'main', refName: 'refs/heads/main' }),
  ref({ shortName: 'feat/x', refName: 'refs/heads/feat/x' }),
  ref({ kind: 'remote', shortName: 'origin/main', refName: 'refs/remotes/origin/main' }),
];

// ------------------------------------------------------------------- groups

test('the frame three groups, in the frame order', () => {
  const groups = groupedMenuItems(menuItemsFor(node(), status(), refs, 'https://github.com/a/b'));
  assert.deepEqual(
    groups.map((g) => g.group),
    ['inspect', 'branch', 'rewrite'],
  );
});

test('the read-only group cannot run git, and everything that can is grouped', () => {
  const items = menuItemsFor(node({ local: true }), status(), refs, 'https://github.com/a/b');
  for (const item of items) {
    assert.ok(
      item.group === 'inspect' || item.group === 'branch' || item.group === 'rewrite',
      `${item.id} declares a group`,
    );
    if (item.group === 'inspect') {
      assert.notEqual(item.command.kind, 'action', `${item.id} must not run git`);
      assert.notEqual(item.command.kind, 'createBranch', `${item.id} must not write a ref`);
      assert.notEqual(item.command.kind, 'mergeInto', `${item.id} must not mutate`);
    }
    if (item.command.kind === 'action' || item.command.kind === 'mergeInto') {
      assert.notEqual(item.group, 'inspect', `${item.id} runs git and cannot sit in Inspect`);
    }
  }
});

test('history rewriting never lands in Branch, and branch moves never land in Rewrite', () => {
  const items = menuItemsFor(node({ local: true }), status(), refs, 'https://github.com/a/b');
  const groupOf = new Map(items.map((item) => [item.id, item.group]));
  for (const id of ['checkout-commit', 'checkout-feat/x', 'create-branch', 'merge', 'merge-into', 'push-up-to']) {
    if (!groupOf.has(id)) continue;
    assert.equal(groupOf.get(id), 'branch', `${id} moves the branch, not its history`);
  }
  for (const id of ['cherry-pick', 'revert', 'reset-soft', 'reset-hard']) {
    assert.equal(groupOf.get(id), 'rewrite', `${id} rewrites history`);
  }
  for (const id of ['view-diff', 'copy-full', 'copy-short', 'open-github']) {
    if (!groupOf.has(id)) continue;
    assert.equal(groupOf.get(id), 'inspect', `${id} only looks`);
  }
});

test('the group headings are the frame words, in both catalogs', () => {
  assert.equal(menuGroupLabel('inspect', 'en'), 'Inspect');
  assert.equal(menuGroupLabel('branch', 'en'), 'Branch');
  assert.equal(menuGroupLabel('rewrite', 'en'), 'Rewrite history');
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    for (const key of ['inspect', 'branch', 'rewrite']) {
      assert.ok(catalog.includes(`      ${key}:`), `${lang} catalog is missing group ${key}`);
    }
  }
});

// --------------------------------------------------------------- focus hint

test('every item carries a focus hint, and the risky ones name the risk', () => {
  const items = menuItemsFor(node({ local: true }), status(), refs, 'https://github.com/a/b');
  for (const item of items) {
    const hint = focusHintFor(item, 'en');
    assert.ok(hint.length > 0, `${item.id} has a hint`);
    assert.ok(!hint.includes('\n'), `${item.id} hint is one line`);
    if (item.risky === true) {
      assert.match(hint, /risky|permanent|detach|discard/i, `${item.id} hint names the risk`);
    }
  }
});

test('the hint follows the item, not a fixed sentence', () => {
  const items = menuItemsFor(node({ local: true }), status(), refs, 'https://github.com/a/b');
  const hints = new Set(items.map((item) => focusHintFor(item, 'en')));
  assert.ok(hints.size > 3, 'a single sentence reused for every row would defeat the box');
  const diff = items.find((i) => i.id === 'view-diff') as MenuItem;
  const hard = items.find((i) => i.id === 'reset-hard') as MenuItem;
  assert.notEqual(focusHintFor(diff, 'en'), focusHintFor(hard, 'en'));
});

test('the hint box is a footer of the menu, not a sub-line under each row', () => {
  const src = read('src/webview/NodeContextMenu.tsx');
  assert.match(src, /gc-menu__focus-hint/, 'the frame box has its own element');
  // Rendered once, after the groups.
  assert.equal((src.match(/gc-menu__focus-hint/g) ?? []).length, 1);
  const hintIndex = src.indexOf('gc-menu__focus-hint');
  const groupIndex = src.indexOf('groups.map(');
  assert.ok(groupIndex > 0 && hintIndex > groupIndex, 'the box follows the groups');
  // The old per-row sub-line is gone: the box replaces it.
  assert.doesNotMatch(src, /gc-menu__hint/);
});

test('the hint tracks pointer and keyboard focus, and falls back to the first item', () => {
  const src = read('src/webview/NodeContextMenu.tsx');
  assert.match(src, /onPointerEnter=\{/, 'hovering a row updates the box');
  assert.match(src, /onFocus=\{/, 'arrowing onto a row updates the box');
  assert.match(src, /setActive\(/, 'both paths go through the one cursor');
  // `active` indexes the flattened item order, so the box reads the same item the
  // roving tabindex sits on.
  assert.match(src, /items\[active\]|flat\[active\]|groups\.flatMap/);
});

test('the hint is announced, not decoration', () => {
  const src = read('src/webview/NodeContextMenu.tsx');
  // A menu is a single AT context; the box names the focused item, so it must be
  // reachable as a description rather than hidden.
  assert.match(src, /aria-live="polite"/);
  assert.match(src, /strings\.menu\.focusHintAria|focusHintAria/);
});

test('the stylesheet draws the frame box with tokens only', () => {
  const css = read('src/webview/styles.css');
  const box = css.match(/\.gc-menu__focus-hint\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(box.length > 0, 'the box has a rule');
  assert.match(box, /border-top|border:/, 'the frame separates it from the last item');
  const literals = css.match(/\.gc-menu__focus-hint[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.deepEqual(literals, []);
});
