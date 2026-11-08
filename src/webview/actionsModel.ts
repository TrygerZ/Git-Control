/**
 * Pure Actions view model (P13).
 *
 * No react, DOM, or vscode imports, like `route.ts` and `githubGate.ts`: every
 * decision the Actions view makes about what to draw is a function here, so it is
 * testable without a browser.
 */
import type { Lang, WorkflowRunInfo } from '../messages';
import { sanitizeGitText, shortHash } from './format';
import { t } from './i18n';

export type RunTone = 'success' | 'danger' | 'running' | 'queued' | 'neutral' | 'warning';

/** Rows the All branches group draws before it stops; the API page is larger. */
export const ALL_BRANCHES_CAP = 20;

export function toneOf(run: Pick<WorkflowRunInfo, 'status' | 'conclusion'>): RunTone {
  // A running status wins over any stale conclusion from a previous attempt.
  if (run.status === 'in_progress') return 'running';
  if (
    run.status === 'queued' ||
    run.status === 'waiting' ||
    run.status === 'requested' ||
    run.status === 'pending'
  ) {
    return 'queued';
  }
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'danger';
    case 'action_required':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function groupRuns(
  runs: readonly WorkflowRunInfo[],
  currentBranch: string | null,
): { thisBranch: WorkflowRunInfo[]; others: WorkflowRunInfo[] } {
  const thisBranch: WorkflowRunInfo[] = [];
  const others: WorkflowRunInfo[] = [];
  for (const r of runs) {
    if (currentBranch !== null && r.branch === currentBranch) {
      thisBranch.push(r);
    } else {
      others.push(r);
    }
  }
  return { thisBranch, others: others.slice(0, ALL_BRANCHES_CAP) };
}

export function branchesWithRuns(
  runs: readonly WorkflowRunInfo[],
  currentBranch: string | null,
): string[] {
  const branches = new Set<string>();
  if (currentBranch !== null) {
    branches.add(currentBranch);
  }
  for (const r of runs) {
    if (r.branch !== null) {
      branches.add(r.branch);
    }
  }
  return Array.from(branches);
}

export function filterByWorkflow(
  runs: readonly WorkflowRunInfo[],
  workflowId: number | null,
): WorkflowRunInfo[] {
  if (workflowId === null) return runs.slice();
  return runs.filter((r) => r.workflowId === workflowId);
}

export function failingDot(
  runs: readonly WorkflowRunInfo[],
  currentBranch: string | null,
): boolean {
  if (!currentBranch || runs.length === 0) return false;
  for (const r of runs) {
    if (r.branch === currentBranch && r.status === 'completed') {
      return (
        r.conclusion === 'failure' ||
        r.conclusion === 'timed_out' ||
        r.conclusion === 'startup_failure'
      );
    }
  }
  return false;
}

export function needsPolling(runs: readonly WorkflowRunInfo[]): boolean {
  return runs.some((r) => r.status !== 'completed');
}

/**
 * Shared duration formatter for runs and jobs.
 *
 * `endMs` is the completion stamp for a finished row and "now" for a live one.
 * Clock skew clamps to zero: a runner and this machine disagree by seconds, and
 * a negative duration reads as a bug rather than as skew.
 */
export function formatDuration(
  startedAt: string | null,
  endMs: number,
  running: boolean,
  lang: Lang,
): string {
  const strings = t(lang).actions;
  if (startedAt === null) return strings.durationQueued;
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) return strings.durationQueued;
  const validEnd = Number.isNaN(endMs) ? startMs : endMs;
  const totalSeconds = Math.max(0, Math.floor((validEnd - startMs) / 1000));
  let formatted: string;
  if (totalSeconds < 60) {
    formatted = `${totalSeconds}s`;
  } else if (totalSeconds < 3600) {
    formatted = `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  } else {
    formatted = `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
  }
  return running ? strings.durationRunning(formatted) : formatted;
}

export function durationText(run: WorkflowRunInfo, now: number, lang: Lang): string {
  const running = run.status !== 'completed';
  const endMs = running ? now : Date.parse(run.updatedAt);
  return formatDuration(run.startedAt, endMs, running, lang);
}

export function metaLine(run: WorkflowRunInfo, lang: Lang = 'en'): string {
  const strings = t(lang).actions;
  const sha = shortHash(run.sha);
  const num = String(run.runNumber);
  const name = sanitizeGitText(run.name);
  if (!run.event) {
    return `${name} #${num} - ${sha}`;
  }
  const event = sanitizeGitText(run.event);
  return strings.runMeta(name, num, event, sha);
}
