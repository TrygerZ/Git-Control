/**
 * Explorer sync action model (P18b).
 *
 * Pure: turns the branch state into the three header buttons and their payloads.
 * The rules mirror `CommitForm`, with two deliberate differences recorded in the
 * phase file: Pull needs an upstream here, and header Fetch never prunes.
 */
import type { GitActionRequest } from '../messages';

export interface SyncContext {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Upstream prefix, else the first remote-tracking ref, else null. */
  remote: string | null;
  /** Any operation or change load in flight. */
  busy: boolean;
}

export type SyncButtonId = 'fetch' | 'pull' | 'push';

export type SyncDisabledReason = 'busy' | 'no-branch' | 'in-sync' | 'no-upstream';

export interface SyncButton {
  id: SyncButtonId;
  /** Push becomes publish while the branch has no upstream. */
  kind: 'fetch' | 'pull' | 'push' | 'publish';
  count: number | null;
  disabled: boolean;
  reason: SyncDisabledReason | null;
}

/**
 * The three buttons in reading order, or an empty array when the repository has
 * no remote: a repository that cannot sync shows no sync group rather than three
 * dead controls.
 */
export function deriveSyncActions(ctx: SyncContext): SyncButton[] {
  if (ctx.remote === null) return [];

  const pushKind: SyncButton['kind'] = ctx.upstream === null ? 'publish' : 'push';

  const reasonFor = (rule: SyncDisabledReason | null): SyncDisabledReason | null =>
    ctx.busy ? 'busy' : rule;

  let pushReason: SyncDisabledReason | null = null;
  if (ctx.branch === null) pushReason = 'no-branch';
  else if (ctx.upstream !== null && ctx.ahead === 0) pushReason = 'in-sync';

  let pullReason: SyncDisabledReason | null = null;
  if (ctx.branch === null) pullReason = 'no-branch';
  else if (ctx.upstream === null) pullReason = 'no-upstream';

  const fetchReason = reasonFor(null);
  const pullReasonFinal = reasonFor(pullReason);
  const pushReasonFinal = reasonFor(pushReason);

  return [
    {
      id: 'fetch',
      kind: 'fetch',
      count: null,
      disabled: fetchReason !== null,
      reason: fetchReason,
    },
    {
      id: 'pull',
      kind: 'pull',
      // A count without an upstream would claim commits to pull that do not exist.
      count: ctx.upstream !== null && ctx.behind > 0 ? ctx.behind : null,
      disabled: pullReasonFinal !== null,
      reason: pullReasonFinal,
    },
    {
      id: 'push',
      kind: pushKind,
      count: ctx.upstream !== null && ctx.ahead > 0 ? ctx.ahead : null,
      disabled: pushReasonFinal !== null,
      reason: pushReasonFinal,
    },
  ];
}

/**
 * The request a button sends, or `null` when the state cannot build one (no
 * branch or no remote). Fetch carries no prune flag on purpose: prune is offered
 * as an error remedy, and a plain button must not delete remote-tracking refs.
 */
export function syncActionRequest(
  id: SyncButtonId,
  ctx: SyncContext,
): GitActionRequest | null {
  switch (id) {
    case 'fetch':
      return { action: 'fetch' };
    case 'pull':
      return { action: 'pull' };
    case 'push':
      if (ctx.remote === null || ctx.branch === null) return null;
      return {
        action: 'push',
        remote: ctx.remote,
        branch: ctx.branch,
        setUpstream: ctx.upstream === null,
      };
    default:
      return null;
  }
}
