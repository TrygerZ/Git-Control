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
      remote: ref.gone ? null : remoteOf(ref, refs),
    });
  }
  return out;
}

/**
 * The remote that carries this branch under its OWN name, or null.
 *
 * Two conditions, and both are needed. The upstream config names a remote, but
 * it can point at a differently named branch (`foo` tracking `origin/bar`) or at
 * a ref that was pruned. The store deletes `refs/remotes/<remote>/<local>`, so
 * the selector only offers a remote when exactly that ref is in the list:
 * anything else would be offered, skipped, and leave the user wondering.
 *
 * `remoteNameOf` reads the config; the ref list confirms the ref exists.
 */
function remoteOf(ref: BranchRef, refs: readonly BranchRef[]): string | null {
  const remote = remoteNameOf(ref.upstream);
  if (remote === null) return null;
  return refs.some((other) => other.refName === `refs/remotes/${remote}/${ref.shortName}`)
    ? remote
    : null;
}

/** Remote named by an upstream ref, e.g. `refs/remotes/origin/main` -> `origin`. */
function remoteNameOf(upstream: string | null): string | null {
  if (upstream === null) return null;
  const prefix = 'refs/remotes/';
  if (!upstream.startsWith(prefix)) return null;
  const rest = upstream.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? null : rest.slice(0, slash);
}
