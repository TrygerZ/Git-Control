/**
 * Quick actions: ranking and row model (P15).
 *
 * Pure. No `vscode` import: the host turns these rows into QuickPick items, and
 * everything decidable without the host is decided here so it can be tested
 * headless. Rows only navigate and focus; nothing in this module can run a git
 * or GitHub mutation (D-18).
 */
import type { OperationState, Route, RouteId } from './messages';

/** Non-route features. A phase that ships one adds it in the same commit (R2). */
export type Feature = 'create-pr' | 'checklist';
export type Capability = RouteId | Feature;

/** Compile-time constant, never a runtime flag. Empty until P22 and P16 ship. */
export const FEATURES: ReadonlySet<Feature> = new Set<Feature>([]);

/** Routes this build registers. Mirrors `navRegistry`; a test keeps the two in step. */
export const SHIPPED_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>([
  'changes',
  'prs',
  'issues',
  'actions',
  'branches',
]);

export type QuickRowId =
  | 'suggest.resolve'
  | 'suggest.publish'
  | 'suggest.push'
  | 'suggest.commit'
  | 'suggest.create-pr'
  | 'suggest.open-actions'
  | 'go.changes'
  | 'go.pull-requests'
  | 'go.issues'
  | 'go.actions'
  | 'go.branches'
  | 'go.stashes'
  | 'help.checklist'
  | 'help.open';

export type QuickGroup = 'suggested' | 'go' | 'help';

export type FocusTarget = 'publish' | 'push' | 'commit' | 'create-pr' | 'resolve';

export type QuickTarget =
  | { kind: 'navigate'; route: Route; focus?: FocusTarget }
  | { kind: 'openExplorer' };

export interface QuickRow {
  id: QuickRowId;
  group: QuickGroup;
  /** Codicon name without `$()`. */
  icon: string;
  target: QuickTarget;
  count: number | null;
  failing: number | null;
}

export interface QuickContext {
  branch: string | null;
  hasUpstream: boolean;
  hasRemote: boolean;
  ahead: number;
  behind: number;
  stagedCount: number;
  conflictCount: number;
  /** Local commits on an unpublished branch, used by the publish suggestion. */
  unpublishedCount: number;
  operation: OperationState;
  github: { linked: boolean; connected: boolean };
  branchHasPr: boolean | null;
  failingRuns: number | null;
  counts: { changes: number; stashes: number; prs: number | null; issues: number | null };
  available: ReadonlySet<Capability>;
}

export function escapeCodicons(text: string): string {
  return text.replaceAll('$(', '\\$(');
}

export function buildQuickRows(ctx: QuickContext): QuickRow[] {
  const suggested: QuickRow[] = [];
  const hasResolve = ctx.operation !== 'idle' || ctx.conflictCount > 0;

  if (hasResolve) {
    suggested.push({
      id: 'suggest.resolve',
      group: 'suggested',
      icon: 'warning',
      target: {
        kind: 'navigate',
        route: { id: 'changes', sub: 'changes' },
        focus: 'resolve',
      },
      count: ctx.conflictCount > 0 ? ctx.conflictCount : null,
      failing: null,
    });
  }

  if (!hasResolve) {
    if (ctx.branch !== null && ctx.hasRemote && !ctx.hasUpstream && ctx.unpublishedCount > 0) {
      suggested.push({
        id: 'suggest.publish',
        group: 'suggested',
        icon: 'cloud-upload',
        target: {
          kind: 'navigate',
          route: { id: 'changes', sub: 'changes' },
          focus: 'publish',
        },
        count: ctx.unpublishedCount,
        failing: null,
      });
    }

    if (ctx.hasUpstream && ctx.ahead > 0 && ctx.behind === 0) {
      suggested.push({
        id: 'suggest.push',
        group: 'suggested',
        icon: 'cloud-upload',
        target: {
          kind: 'navigate',
          route: { id: 'changes', sub: 'changes' },
          focus: 'push',
        },
        count: ctx.ahead,
        failing: null,
      });
    }

    if (ctx.stagedCount > 0) {
      suggested.push({
        id: 'suggest.commit',
        group: 'suggested',
        icon: 'check',
        target: {
          kind: 'navigate',
          route: { id: 'changes', sub: 'changes' },
          focus: 'commit',
        },
        count: ctx.stagedCount,
        failing: null,
      });
    }
  }

  if (
    ctx.github.linked &&
    ctx.branch !== null &&
    ctx.branchHasPr !== true &&
    ctx.available.has('create-pr') &&
    FEATURES.has('create-pr')
  ) {
    suggested.push({
      id: 'suggest.create-pr',
      group: 'suggested',
      icon: 'git-pull-request',
      target: {
        kind: 'navigate',
        route: { id: 'changes', sub: 'changes' },
        focus: 'create-pr',
      },
      count: null,
      failing: null,
    });
  }

  if (ctx.failingRuns !== null && ctx.failingRuns > 0 && ctx.available.has('actions')) {
    suggested.push({
      id: 'suggest.open-actions',
      group: 'suggested',
      icon: 'play',
      target: {
        kind: 'navigate',
        route: { id: 'actions' },
      },
      count: null,
      failing: ctx.failingRuns,
    });
  }

  const go: QuickRow[] = [];
  if (ctx.available.has('changes')) {
    go.push({
      id: 'go.changes',
      group: 'go',
      icon: 'diff',
      target: { kind: 'navigate', route: { id: 'changes', sub: 'changes' } },
      count: ctx.counts.changes,
      failing: null,
    });
  }
  if (ctx.available.has('prs')) {
    go.push({
      id: 'go.pull-requests',
      group: 'go',
      icon: 'git-pull-request',
      target: { kind: 'navigate', route: { id: 'prs' } },
      count: ctx.counts.prs,
      failing: null,
    });
  }
  if (ctx.available.has('issues')) {
    go.push({
      id: 'go.issues',
      group: 'go',
      icon: 'issue-reopened',
      target: { kind: 'navigate', route: { id: 'issues' } },
      count: ctx.counts.issues,
      failing: null,
    });
  }
  if (ctx.available.has('actions')) {
    go.push({
      id: 'go.actions',
      group: 'go',
      icon: 'play',
      target: { kind: 'navigate', route: { id: 'actions' } },
      count: null,
      failing: ctx.failingRuns,
    });
  }
  if (ctx.available.has('branches')) {
    go.push({
      id: 'go.branches',
      group: 'go',
      icon: 'git-branch',
      target: { kind: 'navigate', route: { id: 'branches', sub: 'local' } },
      count: null,
      failing: null,
    });
  }
  if (ctx.available.has('changes')) {
    go.push({
      id: 'go.stashes',
      group: 'go',
      icon: 'archive',
      target: { kind: 'navigate', route: { id: 'changes', sub: 'stashes' } },
      count: ctx.counts.stashes,
      failing: null,
    });
  }

  const help: QuickRow[] = [];
  if (ctx.available.has('checklist') && FEATURES.has('checklist')) {
    help.push({
      id: 'help.checklist',
      group: 'help',
      icon: 'checklist',
      target: { kind: 'navigate', route: { id: 'changes', sub: 'changes' } },
      count: null,
      failing: null,
    });
  }
  // help.open ships with P17 when the help route exists

  return [...suggested.slice(0, 3), ...go, ...help];
}
