/**
 * Cleanup candidate selection (P20).
 *
 * Pure: no git, no vscode, no DOM. The dialog asks this module which branches are
 * safe to offer, so the answer can be asserted without rendering anything.
 *
 * The `merged` flag is advisory (D-21). `git branch -d` runs its own check
 * against the upstream or HEAD, which is not the same question as "merged into
 * the base branch", so a candidate here can still be refused by git. That refusal
 * is surfaced, never worked around: nothing in this module or its callers may
 * reach for `-D`.
 */
import type { BranchRef } from './messages';

export interface CleanupCandidate {
  name: string;
  /** ISO date of the branch tip, display only. */
  mergedAt: string | null;
  upstreamGone: boolean;
  /** Remote that still carries the branch, or null when none does. */
  remote: string | null;
}

/**
 * Local branches git could safely delete, in the order the ref list supplied.
 *
 * Excluded: the current branch (git refuses it), the base branch (`main` is not
 * cleanup material), unmerged branches, and every non-local ref. A gone upstream
 * reports no remote, because the tracking ref the config still names no longer
 * exists on the server.
 */
export function selectCleanupCandidates(
  refs: readonly BranchRef[],
  current: string | null,
  defaultBranch: string,
): CleanupCandidate[] {
  const out: CleanupCandidate[] = [];
  for (const ref of refs) {
    if (ref.kind !== 'local') continue;
    if (!ref.merged) continue;
    if (ref.isHead) continue;
    if (ref.shortName === current) continue;
    if (ref.shortName === defaultBranch) continue;
    out.push({
      name: ref.shortName,
      mergedAt: ref.committedAt,
      upstreamGone: ref.gone,
      remote: ref.gone ? null : remoteOf(ref),
    });
  }
  return out;
}

/**
 * The remote whose tracking ref carries this branch.
 *
 * Read from the ref list, not from `ref.upstream`: the config can name a remote
 * whose tracking ref was pruned, and offering a delete for it produces git's
 * "remote ref does not exist" instead of a result.
 */
function remoteOf(ref: BranchRef): string | null {
  if (ref.upstream === null) return null;
  const prefix = 'refs/remotes/';
  if (!ref.upstream.startsWith(prefix)) return null;
  const rest = ref.upstream.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? null : rest.slice(0, slash);
}
