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
  // unrelated view, which is worse than not offering the row. P22 shipped the
  // dialog, so `create-pr` now has a consumer and the module may emit it.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'quickActions.ts'), 'utf8');
  assert.match(src, /focus: 'create-pr'/, 'create-pr focus ships with its consumer');

  const messages = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'messages.ts'), 'utf8');
  const union = /export type FocusTarget = ([^;]+);/.exec(messages)?.[1] ?? '';
  assert.match(union, /create-pr/, 'the type ships with the view that consumes it');
});

test('the checklist and create-pr rows both ship, and each still needs its own conditions', () => {
  // P16 shipped the card and P22 shipped the dialog, so both capabilities are on.
  // `create-pr` additionally needs a published branch with commits to review, so
  // this context (no upstream) deliberately does not offer it.
  assert.equal(FEATURES.has('checklist'), true);
  assert.equal(FEATURES.has('create-pr'), true);

  const rows = buildQuickRows(
    ctx({ available: new Set<Capability>([...SHIPPED_ROUTES, 'create-pr', 'checklist']) }),
  );
  const checklist = row(rows, 'help.checklist');
  assert.ok(checklist !== undefined, 'the checklist row is offered');
  assert.deepEqual(checklist.target, {
    kind: 'navigate',
    route: { id: 'changes', sub: 'changes' },
  });
  assert.equal(row(rows, 'suggest.create-pr'), undefined, 'no upstream means nothing to review');

  // P17 shipped the Help route, so the row is offered and it opens the panel.
  const helpOpen = row(rows, 'help.open');
  assert.ok(helpOpen !== undefined, 'the help row is offered once the route exists');
  assert.deepEqual(helpOpen.target, { kind: 'navigate', route: { id: 'help', tab: 'features' } });

  // A host that does not advertise the capability still hides the row.
  const withoutCapability = buildQuickRows(ctx({ available: new Set<Capability>([...SHIPPED_ROUTES]) }));
  assert.equal(row(withoutCapability, 'help.checklist'), undefined);

  // A build without the route drops the row, exactly like a missing go row.
  const withoutHelp = buildQuickRows(
    ctx({ available: new Set<Capability>([...SHIPPED_ROUTES].filter((id) => id !== 'help')) }),
  );
  assert.equal(row(withoutHelp, 'help.open'), undefined);
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
    // P17: the help group closes the list, after every go row.
    'help.open',
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
  // `help.checklist` is absent from this context (no `checklist` capability), so
  // the help group opens with `help.open` once P17 registers the route.
  assert.deepEqual([...new Set(groups)], ['suggested', 'go', 'help']);
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
  // set is duplicated. This test is what keeps the copy honest. Help is the one
  // route with no strip destination (it opens from the header), so it is the
  // single documented exception.
  const strip = navRegistry.list().map((d) => d.id);
  const shipped = [...SHIPPED_ROUTES].filter((id) => id !== 'help').sort();
  assert.deepEqual(shipped, [...strip].sort());
  assert.ok(SHIPPED_ROUTES.has('help'), 'the Help route is served by this build');
});

// ------------------------------------------ create pull request capability (P22)

test('create-pr ships now, so the feature set and the row both carry it', () => {
  assert.equal(FEATURES.has('create-pr'), true);
  assert.equal(FEATURES.has('checklist'), true);

  const rows = buildQuickRows(
    ctx({ hasUpstream: true, ahead: 2, available: new Set<Capability>([...SHIPPED_ROUTES, ...FEATURES]) }),
  );
  const row = rows.find((entry) => entry.id === 'suggest.create-pr');
  assert.ok(row !== undefined, 'the row is offered once the dialog exists');
  assert.deepEqual(row.target, {
    kind: 'navigate',
    route: { id: 'prs' },
    focus: 'create-pr',
  });
});

test('the create-pr row is hidden when the capability is absent, and never hides a conflict remedy', () => {
  const without = buildQuickRows(ctx({ available: new Set<Capability>([...SHIPPED_ROUTES]) }));
  assert.equal(without.find((entry) => entry.id === 'suggest.create-pr'), undefined);

  // A conflict is the only thing worth acting on, so nothing else is suggested.
  const conflicted = buildQuickRows(
    ctx({ conflictCount: 2, available: new Set<Capability>([...SHIPPED_ROUTES, ...FEATURES]) }),
  );
  assert.equal(conflicted.find((entry) => entry.id === 'suggest.create-pr'), undefined);
  assert.ok(conflicted.find((entry) => entry.id === 'suggest.resolve') !== undefined);
});

test('the create-pr row needs a branch, an upstream, and commits ahead', () => {
  const available = new Set<Capability>([...SHIPPED_ROUTES, ...FEATURES]);
  const has = (overrides: Partial<QuickContext>): boolean =>
    buildQuickRows(ctx({ available, ...overrides })).some((entry) => entry.id === 'suggest.create-pr');

  assert.equal(has({ branch: null }), false, 'no branch, no pull request');
  assert.equal(has({ hasUpstream: false }), false, 'publishing comes first');
  assert.equal(has({ ahead: 0 }), false, 'nothing to review');
  assert.equal(has({ hasRemote: false }), false, 'no remote, no pull request');
  assert.equal(has({ hasUpstream: true, ahead: 2 }), true);
});

test('the create-pr row never displaces the three-suggestion cap', () => {
  const rows = buildQuickRows(
    ctx({
      hasUpstream: true,
      ahead: 3,
      stagedCount: 2,
      failingRuns: 1,
      available: new Set<Capability>([...SHIPPED_ROUTES, ...FEATURES]),
    }),
  );
  const suggested = rows.filter((entry) => entry.group === 'suggested');
  assert.ok(suggested.length <= 3, `suggested stays at most three (${suggested.length})`);
});

test('the focus target now has a consumer, so the type may express it', () => {
  const messages = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'messages.ts'), 'utf8');
  const union = /export type FocusTarget = ([^;]+);/.exec(messages)?.[1] ?? '';
  assert.match(union, /create-pr/, 'the target ships with the dialog that consumes it');
});
