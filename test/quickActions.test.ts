/**
 * Quick actions ranking and row model (P15).
 *
 * The palette is a native QuickPick, so everything worth pinning lives in this
 * pure module: which suggestion wins, what gets suppressed while a conflict is
 * open, and which rows are hidden because their target does not exist yet (R2).
 * The host only turns these rows into items.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FEATURES,
  SHIPPED_ROUTES,
  buildQuickRows,
  escapeCodicons,
  type Capability,
  type QuickContext,
  type QuickRow,
} from '../src/quickActions';
import { navRegistry } from '../src/webview/navRegistry';
import '../src/webview/NavStrip';

function ctx(overrides: Partial<QuickContext> = {}): QuickContext {
  return {
    branch: 'feat/graph-ribbons',
    hasUpstream: false,
    hasRemote: true,
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    conflictCount: 0,
    unpublishedCount: 3,
    operation: 'idle',
    github: { linked: true, connected: true },
    branchHasPr: null,
    failingRuns: null,
    counts: { changes: 6, stashes: 2, prs: 12, issues: 31 },
    available: new Set<Capability>([...SHIPPED_ROUTES]),
    ...overrides,
  };
}

function ids(rows: readonly QuickRow[]): string[] {
  return rows.map((row) => row.id);
}

function row(rows: readonly QuickRow[], id: QuickRow['id']): QuickRow | undefined {
  return rows.find((entry) => entry.id === id);
}

// -------------------------------------------------------------- suggestions

test('a branch with a remote and no upstream suggests publish first', () => {
  const rows = buildQuickRows(ctx());
  const first = rows[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 'suggest.publish');
  assert.equal(first.group, 'suggested');
  assert.equal(first.count, 3);
  assert.deepEqual(first.target, {
    kind: 'navigate',
    route: { id: 'changes', sub: 'changes' },
    focus: 'publish',
  });
});

test('staged files add a commit suggestion that focuses the message field', () => {
  const rows = buildQuickRows(ctx({ stagedCount: 2 }));
  const commit = row(rows, 'suggest.commit');
  assert.ok(commit !== undefined);
  assert.equal(commit.count, 2);
  assert.deepEqual(commit.target, {
    kind: 'navigate',
    route: { id: 'changes', sub: 'changes' },
    focus: 'commit',
  });
});

test('conflicts suppress publish, push, and commit, and rank resolve first', () => {
  const rows = buildQuickRows(
    ctx({ conflictCount: 2, stagedCount: 3, hasUpstream: true, ahead: 4 }),
  );
  const first = rows[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 'suggest.resolve');
  assert.equal(first.count, 2);
  assert.deepEqual(ids(rows).filter((id) => id.startsWith('suggest.')), ['suggest.resolve']);
});

test('an operation with no conflicted file still ranks resolve first, without a count', () => {
  const rows = buildQuickRows(ctx({ operation: 'merge', stagedCount: 1, conflictCount: 0 }));
  const first = rows[0];
  assert.ok(first !== undefined);
  assert.equal(first.id, 'suggest.resolve');
  assert.equal(first.count, null);
  assert.equal(row(rows, 'suggest.commit'), undefined);
});

test('ahead with an upstream gives push', () => {
  const rows = buildQuickRows(ctx({ hasUpstream: true, ahead: 2 }));
  const push = row(rows, 'suggest.push');
  assert.ok(push !== undefined);
  assert.equal(push.count, 2);
  assert.deepEqual(push.target, {
    kind: 'navigate',
    route: { id: 'changes', sub: 'changes' },
    focus: 'push',
  });
  assert.equal(row(rows, 'suggest.publish'), undefined);
});

test('behind blocks push, because a fast-forward is not possible', () => {
  const rows = buildQuickRows(ctx({ hasUpstream: true, ahead: 2, behind: 1 }));
  assert.equal(row(rows, 'suggest.push'), undefined);
});

test('nothing to publish means no publish row', () => {
  const rows = buildQuickRows(ctx({ unpublishedCount: 0 }));
  assert.equal(row(rows, 'suggest.publish'), undefined);
});

test('a detached HEAD hides publish', () => {
  const rows = buildQuickRows(ctx({ branch: null, hasUpstream: false, unpublishedCount: 5 }));
  assert.equal(row(rows, 'suggest.publish'), undefined);
});

test('no remote means no publish row', () => {
  const rows = buildQuickRows(ctx({ hasRemote: false, unpublishedCount: 5 }));
  assert.equal(row(rows, 'suggest.publish'), undefined);
});

test('failing runs give an Actions suggestion, null gives none', () => {
  const withRuns = buildQuickRows(ctx({ failingRuns: 2 }));
  const actions = row(withRuns, 'suggest.open-actions');
  assert.ok(actions !== undefined);
  assert.equal(actions.failing, 2);
  assert.equal(actions.count, null);
  assert.deepEqual(actions.target, { kind: 'navigate', route: { id: 'actions' } });

  const unknown = buildQuickRows(ctx({ failingRuns: null }));
  assert.equal(row(unknown, 'suggest.open-actions'), undefined);
});

test('the Actions go row carries the failing count, as frame 102 draws it', () => {
  const rows = buildQuickRows(ctx({ failingRuns: 1 }));
  assert.equal(row(rows, 'go.actions')?.failing, 1);
  assert.equal(row(rows, 'go.actions')?.count, null);
});

test('three suggestions appear in rank order, and the group never exceeds three', () => {
  const rows = buildQuickRows(
    ctx({ hasUpstream: true, ahead: 3, stagedCount: 2, failingRuns: 1 }),
  );
  const suggested = rows.filter((entry) => entry.group === 'suggested');
  assert.deepEqual(ids(suggested), ['suggest.push', 'suggest.commit', 'suggest.open-actions']);

  // A fourth row becomes reachable once P22 ships `create-pr`; the cap is what
  // keeps the group at three then. Sweep the boolean states we have today and
  // assert the invariant holds for every one of them.
  for (const hasUpstream of [true, false]) {
    for (const ahead of [0, 2]) {
      for (const stagedCount of [0, 1]) {
        for (const failingRuns of [null, 1]) {
          for (const conflictCount of [0, 1]) {
            const swept = buildQuickRows(
              ctx({ hasUpstream, ahead, stagedCount, failingRuns, conflictCount }),
            ).filter((entry) => entry.group === 'suggested');
            assert.ok(swept.length <= 3, `suggested group stays at most three (${swept.length})`);
          }
        }
      }
    }
  }
});

// ------------------------------------------------------------- capabilities

test('no row emits a focus target the webview cannot consume', () => {
  // A target with no consumer sits in `pendingFocus` and is later claimed by an
  // unrelated view, which is worse than not offering the row. `create-pr` has no
  // consumer until P22 ships the dialog, so the module must not emit it.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'quickActions.ts'), 'utf8');
  assert.doesNotMatch(src, /focus: 'create-pr'/, 'create-pr focus ships with its consumer');

  const messages = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'messages.ts'), 'utf8');
  const union = /export type FocusTarget = ([^;]+);/.exec(messages)?.[1] ?? '';
  assert.doesNotMatch(union, /create-pr/, 'the type cannot express an unconsumed target');
});

test('no feature is shipped yet, so feature rows never appear', () => {
  assert.equal(FEATURES.has('create-pr'), false);
  assert.equal(FEATURES.has('checklist'), false);

  // Even a host that claims the capability is not believed while FEATURES lacks it.
  const rows = buildQuickRows(
    ctx({ available: new Set<Capability>([...SHIPPED_ROUTES, 'create-pr', 'checklist']) }),
  );
  assert.equal(row(rows, 'suggest.create-pr'), undefined);
  assert.equal(row(rows, 'help.checklist'), undefined);

  // `help.open` is gated on a route this build does not register at all.
  assert.equal(row(rows, 'help.open'), undefined);
});

test('a route missing from the available set hides its row', () => {
  const rows = buildQuickRows(ctx({ available: new Set<Capability>() }));
  assert.deepEqual(ids(rows).filter((id) => id.startsWith('go.')), []);
});

// ---------------------------------------------------------------- go rows

test('go rows keep the fixed order of frame 102', () => {
  const rows = buildQuickRows(ctx({ stagedCount: 0, unpublishedCount: 0 }));
  assert.deepEqual(ids(rows), [
    'go.changes',
    'go.pull-requests',
    'go.issues',
    'go.actions',
    'go.branches',
    'go.stashes',
  ]);
});

test('counts pass through unchanged and stashes opens the stashes sub-tab', () => {
  const rows = buildQuickRows(ctx());
  assert.equal(row(rows, 'go.changes')?.count, 6);
  assert.equal(row(rows, 'go.pull-requests')?.count, 12);
  assert.equal(row(rows, 'go.issues')?.count, 31);
  const stashes = row(rows, 'go.stashes');
  assert.equal(stashes?.count, 2);
  assert.deepEqual(stashes?.target, {
    kind: 'navigate',
    route: { id: 'changes', sub: 'stashes' },
  });
});

test('every row is grouped in the order suggested, go, help', () => {
  const groups = buildQuickRows(ctx()).map((entry) => entry.group);
  assert.deepEqual([...new Set(groups)], ['suggested', 'go']);
});

// --------------------------------------------------------------- codicons

test('escapeCodicons neutralizes a git-sourced codicon prefix', () => {
  assert.equal(escapeCodicons('$(trash) x'), '\\$(trash) x');
  assert.equal(escapeCodicons('plain branch'), 'plain branch');
  assert.equal(escapeCodicons('$(a)$(b)'), '\\$(a)\\$(b)');
});

// ------------------------------------------------------------- determinism

test('equal input yields an identical row list', () => {
  const input = ctx({ stagedCount: 2, hasUpstream: true, ahead: 1 });
  assert.deepEqual(buildQuickRows(input), buildQuickRows(input));
});

test('SHIPPED_ROUTES matches the destinations the strip actually registers', () => {
  // The host cannot import `navRegistry` (it pulls in the webview stores), so the
  // set is duplicated. This test is what keeps the copy honest.
  assert.deepEqual([...SHIPPED_ROUTES].sort(), navRegistry.list().map((d) => d.id).sort());
});
