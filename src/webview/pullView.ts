/**
 * P24 pull request detail view model.
 *
 * Pure data-in/data-out: no `vscode`, no React, no DOM. Everything the PR detail
 * panel states before rendering lives here, so a wrong sentence is a failing
 * assertion rather than a wrong pixel.
 */
import type {
  CheckRunInfo,
  CheckSummary,
  OpenDiffPayload,
  PullDetail,
  PullFile,
} from '../messages';
import { validateRepoRelativePath } from '../validation';

export type PullTab = 'conversation' | 'commits' | 'checks' | 'files';

export const pullTabIds: readonly PullTab[] = ['conversation', 'commits', 'checks', 'files'];

export type StatusTone = 'success' | 'pending' | 'failure' | 'neutral';

export interface StatusLine {
  id: 'checks' | 'review' | 'conflicts';
  tone: StatusTone;
  /** Second line: counts, names, or the merge rule. Empty when the tone says it all. */
  detail: string;
}

const CHECK_TONE: Record<CheckSummary['state'], StatusTone> = {
  passing: 'success',
  pending: 'pending',
  failing: 'failure',
  none: 'neutral',
};

const MERGE_TONE: Record<PullDetail['mergeableState'], StatusTone> = {
  clean: 'success',
  dirty: 'failure',
  blocked: 'pending',
  behind: 'pending',
  unstable: 'pending',
  unknown: 'neutral',
};

export function statusLines(detail: PullDetail, checks: CheckSummary): StatusLine[] {
  const checkDetail =
    checks.state === 'pending'
      ? `${checks.passed}/${checks.total}`
      : checks.state === 'failing'
        ? checks.failingNames.join(', ')
        : '';

  // A pending request outranks an approval: an approval that does not cover
  // everyone asked is not a green review.
  const reviewTone: StatusTone =
    detail.changesRequestedBy.length > 0
      ? 'failure'
      : detail.reviewers.length > 0
        ? 'pending'
        : detail.approvedBy.length > 0
          ? 'success'
          : 'neutral';

  return [
    { id: 'checks', tone: CHECK_TONE[checks.state], detail: checkDetail },
    { id: 'review', tone: reviewTone, detail: '' },
    { id: 'conflicts', tone: MERGE_TONE[detail.mergeableState], detail: '' },
  ];
}

export function tabCounts(detail: PullDetail, checks: CheckSummary | null): Record<PullTab, number | null> {
  return {
    conversation: null,
    commits: detail.commits,
    checks: checks === null ? null : checks.total,
    files: detail.changedFiles,
  };
}

export function groupChecks(checks: CheckRunInfo[]): Array<{ app: string; runs: CheckRunInfo[] }> {
  const groups = new Map<string, CheckRunInfo[]>();
  for (const run of checks) {
    const runs = groups.get(run.app);
    if (runs === undefined) groups.set(run.app, [run]);
    else runs.push(run);
  }
  return Array.from(groups, ([app, runs]) => ({ app, runs }));
}

export function fileTotals(files: PullFile[]): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files: files.length, additions, deletions };
}

export function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 0) return '';
  if (max === 1) return '…';
  return `${value.slice(0, max - 1)}…`;
}

export function diffRequest(
  file: PullFile,
  detail: Pick<PullDetail, 'headSha'>,
  mergeBase: string | null,
): OpenDiffPayload | null {
  if (mergeBase === null) return null;
  // The bridge re-validates this path; refusing here keeps the webview from
  // sending a request the host must reject.
  if (!validateRepoRelativePath(file.path)) return null;
  return { path: file.path, hash: detail.headSha, parent: mergeBase };
}
