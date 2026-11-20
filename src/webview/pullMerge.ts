/**
 * P25 pull request merge view model.
 *
 * Pure data-in/data-out: no `vscode`, no React, no DOM. `mergeBlockReason` decides
 * whether the merge button is live and why not; `mergeCommands` is the exact list
 * the confirmation dialog shows, which is the whole promise of frame 50.
 */
import type { CheckSummary, PullDetail } from '../messages';
import { sanitizeGitText } from './format';

/** Why the merge control is unavailable. Each id is a sentence in the catalog. */
export type BlockReason =
  | 'draft'
  | 'conflicts'
  | 'checks-failing'
  | 'checks-pending'
  | 'review-required'
  | 'behind'
  | 'unknown'
  | 'closed';

export type MergeMethod = 'merge' | 'squash';

export interface MergeOptions {
  method: MergeMethod;
  deleteBranch: boolean;
}

export interface MergeTarget {
  owner: string;
  repo: string;
  number: number;
  headRef: string;
}

/**
 * Precedence, highest first: closed, draft, conflicts, review required, checks
 * failing, checks pending, behind, unstable, unknown. The order is the promise:
 * it names the one thing the user must fix first, so a stale mergeability read
 * never outranks a conflict, and a conflict never waits on a check run.
 */
export function mergeBlockReason(detail: PullDetail, checks: CheckSummary): BlockReason | null {
  if (detail.state !== 'open') return 'closed';
  if (detail.draft) return 'draft';
  if (detail.mergeableState === 'dirty') return 'conflicts';
  if (detail.mergeableState === 'blocked') return 'review-required';
  if (checks.state === 'failing') return 'checks-failing';
  if (checks.state === 'pending') return 'checks-pending';
  if (detail.mergeableState === 'behind') return 'behind';
  if (detail.mergeableState === 'unstable') return 'checks-failing';
  if (detail.mergeableState === 'unknown') return 'unknown';
  return null;
}

/**
 * The exact commands the confirmation dialog shows (frame 50). Local delete
 * comes before the remote delete: `git branch -d` proves merged-ness against the
 * tracking ref, which `push --delete` then removes. Every untrusted segment is
 * folded through `sanitizeGitText` so no bidi mark or NUL reaches a display.
 */
export function mergeCommands(pr: MergeTarget, opts: MergeOptions): string[] {
  const owner = sanitizeGitText(pr.owner);
  const repo = sanitizeGitText(pr.repo);
  const headRef = sanitizeGitText(pr.headRef);
  const commands = [`PUT /repos/${owner}/${repo}/pulls/${pr.number}/merge`];
  if (opts.deleteBranch) {
    commands.push(`git branch -d ${headRef}`, `git push origin --delete ${headRef}`);
  }
  return commands;
}

export function defaultSquashMessage(detail: Pick<PullDetail, 'title' | 'number'>): string {
  return `${sanitizeGitText(detail.title.trim() || 'Pull request')} (#${detail.number})`;
}

/**
 * Build the exact read-only preview shown in the Close Pull Request
 * confirmation dialog. Every untrusted segment is folded through
 * `sanitizeGitText` so no bidi mark or NUL reaches the display.
 */
export function closeCommand(pr: Pick<MergeTarget, 'owner' | 'repo' | 'number'>): string {
  const owner = sanitizeGitText(pr.owner);
  const repo = sanitizeGitText(pr.repo);
  return `PATCH /repos/${owner}/${repo}/pulls/${pr.number}`;
}
