/**
 * Check summary (P21). Pure: takes check runs, returns one badge's worth of
 * truth. No `vscode`, no React, no network.
 *
 * The rules are priority-ordered, not counted, because the badge answers one
 * question: does the user have to act? A completed failure is actionable no
 * matter how many checks are still running, so it outranks `pending`.
 */
import type { CheckConclusion, CheckRunInfo, CheckSummary } from './messages';

/** Completed conclusions that mean the run failed. Everything else passed. */
const FAILING: ReadonlySet<CheckConclusion> = new Set<CheckConclusion>([
  'failure',
  'timed_out',
  'action_required',
  'cancelled',
]);

/** How many failing names the summary carries; the UI adds `+N more`. */
export const FAILING_NAMES_MAX = 3;

export function summarizeChecks(runs: readonly CheckRunInfo[]): CheckSummary {
  if (runs.length === 0) {
    return { state: 'none', total: 0, passed: 0, failing: 0, pending: 0, failingNames: [] };
  }

  let passed = 0;
  let failing = 0;
  let pending = 0;
  const failingNames: string[] = [];

  for (const run of runs) {
    if (run.status !== 'completed') {
      pending += 1;
      continue;
    }
    if (FAILING.has(run.conclusion)) {
      failing += 1;
      if (failingNames.length < FAILING_NAMES_MAX) failingNames.push(run.name);
      continue;
    }
    // A completed run is over, so it counts as passed unless it failed above.
    // Unknown and null conclusions land here on purpose: waiting on a run that
    // will never change again would leave the badge spinning forever.
    passed += 1;
  }

  const state = failing > 0 ? 'failing' : pending > 0 ? 'pending' : 'passing';
  return { state, total: runs.length, passed, failing, pending, failingNames };
}
