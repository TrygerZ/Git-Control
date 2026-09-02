/**
 * Safety guard: the single place where "may this action run?" is decided.
 *
 * Pure by construction — no git, no vscode, no I/O. It takes a snapshot of the
 * repository plus the requested action and returns a verdict. The bridge is
 * responsible for building the snapshot and for honouring the verdict, which
 * keeps every PRD rule unit-testable without a real repository.
 *
 * Confirmation is modelled as a *blocked* verdict carrying
 * `requiresConfirmation`. The bridge unblocks it only when the request supplies
 * `confirm: true` (plus `forceAcknowledgement: true` at level 2), so a webview
 * cannot bypass a gate by omitting a flag.
 */
import type { ErrorCode, GitActionRequest, Lang, OperationState, Remedy } from './messages';
import { hostText } from './hostText';

/** Index/commit actions are not part of {@link GitActionRequest} but are guarded too. */
export type GuardAction = GitActionRequest | { action: 'stage' } | { action: 'commit' };

export interface GuardSnapshot {
  /** Unstaged or untracked changes present. */
  dirty: boolean;
  /** Changes present in the index. */
  staged: boolean;
  /** At least one unresolved conflict. */
  conflicted: boolean;
  operation: OperationState;
  ahead: number;
  behind: number;
  upstream: string | null;
  /** Epoch ms of the last successful fetch, or `null` when never fetched. */
  lastFetchAt: number | null;
  /** Epoch ms "now", injected so tests are deterministic. */
  now: number;
  /** Age after which remote data counts as stale. */
  stalenessMs: number;
}

export type GuardVerdict =
  | { allow: true }
  | {
      allow: false;
      code: ErrorCode;
      message: string;
      remedies: Remedy[];
      requiresConfirmation?: boolean;
      confirmationLevel?: 1 | 2;
      risk?: 'low' | 'medium' | 'high';
    };

export const DEFAULT_STALENESS_MS = 300_000;

/** Actions that make sense while a merge/rebase/etc. is in progress. */
const RESOLUTION_ACTIONS = new Set<GuardAction['action']>([
  'merge-continue',
  'merge-abort',
  'stage',
  'commit',
]);

/**
 * A dirty working tree would be overwritten or blocked by these.
 * Note: `reset-hard` is intentionally excluded so it proceeds to the 2-stage
 * CONFIRMATION_REQUIRED flow — discarding a dirty tree is its explicit purpose.
 */
const DIRTY_BLOCKED = new Set<GuardAction['action']>([
  'checkout-branch',
  'checkout-commit',
  'merge',
]);

/** Actions needing a single confirmation click. */
const CONFIRM_LEVEL_1 = new Set<GuardAction['action']>(['push-up-to', 'revert', 'reset-soft']);

/**
 * Decide whether `action` may run against `snapshot`.
 *
 * Check order matters and mirrors the PRD: in-progress operation, then
 * conflicts, then dirty tree, then remote freshness, then confirmation. The
 * first blocking rule wins so the user is shown the most fundamental problem.
 */
export function evaluate(action: GuardAction, snapshot: GuardSnapshot, lang: Lang = 'en'): GuardVerdict {
  const inProgress = snapshot.operation !== 'idle';
  const text = hostText(lang).guard;

  // An in-progress operation blocks everything except the ways out of it.
  if (inProgress && !RESOLUTION_ACTIONS.has(action.action)) {
    return {
      allow: false,
      code: 'CONFLICT',
      message: text.conflictInProgress,
      remedies: ['resolve-conflicts', 'cancel'],
    };
  }

  // Committing a half-resolved merge would record conflict markers.
  if (action.action === 'commit' && snapshot.conflicted) {
    return {
      allow: false,
      code: 'CONFLICT',
      message: text.conflictFiles,
      remedies: ['resolve-conflicts', 'cancel'],
    };
  }

  if (snapshot.dirty && DIRTY_BLOCKED.has(action.action)) {
    return {
      allow: false,
      code: 'DIRTY_TREE',
      message: text.dirty,
      remedies: ['commit', 'stash', 'cancel'],
    };
  }

  if (action.action === 'push' || action.action === 'push-up-to') {
    if (isStale(snapshot)) {
      return {
        allow: false,
        code: 'STALE_STATUS',
        message: text.stale,
        remedies: ['fetch'],
      };
    }
    if (snapshot.behind > 0) {
      // Force push is never offered: fetch and integrate instead.
      return action.action === 'push'
        ? {
            allow: false,
            code: 'REMOTE_AHEAD',
            message: text.remoteAhead,
            remedies: ['fetch'],
          }
        : {
            allow: false,
            code: 'NON_FAST_FORWARD',
            message: text.nonFastForward,
            remedies: ['fetch'],
          };
    }
  }

  if (action.action === 'reset-hard') {
    return {
      allow: false,
      code: 'CONFIRMATION_REQUIRED',
      message: text.resetHard,
      remedies: ['confirm', 'cancel'],
      requiresConfirmation: true,
      confirmationLevel: 2,
      risk: 'high',
    };
  }

  if (CONFIRM_LEVEL_1.has(action.action)) {
    return {
      allow: false,
      code: 'CONFIRMATION_REQUIRED',
      message: text.confirm,
      remedies: ['confirm', 'cancel'],
      requiresConfirmation: true,
      confirmationLevel: 1,
      risk: 'medium',
    };
  }

  return { allow: true };
}

/**
 * Remote data is stale when it is *older* than the window. A fetch landing
 * exactly on the threshold still counts as fresh; never fetching is always stale.
 */
function isStale(snapshot: GuardSnapshot): boolean {
  if (snapshot.lastFetchAt === null) return true;
  return snapshot.now - snapshot.lastFetchAt > snapshot.stalenessMs;
}

/** Namespace-style export so call sites read `SafetyGuard.evaluate(...)`. */
export const SafetyGuard = { evaluate } as const;
