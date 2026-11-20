/**
 * Pure issue list helpers (P08). No react, DOM, or vscode imports.
 *
 * The host already narrows the list by assignee/creator/mentioned and caps the
 * body, so the client only narrows further: label, text, and the label menu.
 */
import type { IssueInfo, IssueLabelTone } from '../messages';
import {
  validateCommentBody,
  validateIssueBody,
  validateIssueTitle,
  validateLabelList,
} from '../validation';
import { sanitizeGitText } from './format';

export interface IssueQuery {
  /** Exact label name, or `null` for every label. */
  label: string | null;
  query: string;
}

export function filterIssues(issues: readonly IssueInfo[], view: IssueQuery): IssueInfo[] {
  return issues.filter((issue) => {
    if (view.label !== null && !issue.labels.some((l) => l.name === view.label)) {
      return false;
    }
    return matchesText(issue, view.query);
  });
}

export function labelOptions(
  issues: readonly IssueInfo[],
  max: number = 12,
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    const seen = new Set<string>();
    for (const label of issue.labels) {
      if (!seen.has(label.name)) {
        seen.add(label.name);
        counts.set(label.name, (counts.get(label.name) ?? 0) + 1);
      }
    }
  }
  const list = Array.from(counts.entries(), ([name, count]) => ({ name, count }));
  list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return list.slice(0, Math.max(0, max));
}

export function matchesText(issue: IssueInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    issue.title.toLowerCase().includes(needle) ||
    issue.author.toLowerCase().includes(needle) ||
    `#${issue.number}`.includes(needle) ||
    String(issue.number).includes(needle) ||
    issue.labels.some((l) => l.name.toLowerCase().includes(needle))
  );
}

// ------------------------------------------------------------ write model (P26)

const VALID_LABEL_TONES: ReadonlySet<IssueLabelTone> = new Set<IssueLabelTone>([
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'gray',
]);

/** True when a comment draft is non-empty after trimming, at most 65536 chars, and has no NUL. */
export function canSubmitComment(draft: string): boolean {
  return typeof draft === 'string' && draft.length <= 65_536 && validateCommentBody(draft);
}

/** True when a New issue form satisfies the host title, body, and label list rules. */
export function canCreateIssue(form: {
  title: string;
  body: string;
  labels: readonly string[];
}): boolean {
  return (
    validateIssueTitle(form.title) &&
    validateIssueBody(form.body) &&
    validateLabelList(form.labels)
  );
}

/** Exact read-only command preview shown in the New issue dialog (frame 101). */
export function issueCommand(owner: string, repo: string): string {
  return `POST /repos/${sanitizeGitText(owner)}/${sanitizeGitText(repo)}/issues`;
}

/**
 * Optimistically transition an issue between `open` and `closed` in a list.
 * The mutated item moves to the head of its target state partition (`open` first,
 * `closed` second) so open and closed slices derived from the result reflect the
 * new state and counts immediately.
 */
export function applyIssueMutation(
  list: readonly IssueInfo[],
  change: { number: number; state: 'open' | 'closed' },
): IssueInfo[] {
  const target = list.find((item) => item.number === change.number);
  if (target === undefined) return [...list];

  const updated: IssueInfo = {
    ...target,
    state: change.state,
    stateReason: change.state === 'closed' ? 'completed' : 'reopened',
    closedAt: change.state === 'closed' ? target.closedAt : null,
  };

  const remaining = list.filter((item) => item.number !== change.number);
  const open = remaining.filter((item) => item.state === 'open');
  const closed = remaining.filter((item) => item.state === 'closed');

  if (change.state === 'open') {
    return [updated, ...open, ...closed];
  }
  return [...open, updated, ...closed];
}

/**
 * Validate a 6-digit hex label color (`#rrggbb` or `rrggbb`). Returns lowercase
 * `#rrggbb` or `null` when the value is not a strict 6-hex string.
 */
export function sanitizeLabelColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex.toLowerCase()}`;
}

/** Safe tone key for a label chip; falls back to neutral `'gray'` on unknown input. */
export function labelChipTone(label: { colorKey?: unknown }): IssueLabelTone {
  return typeof label.colorKey === 'string' && VALID_LABEL_TONES.has(label.colorKey as IssueLabelTone)
    ? (label.colorKey as IssueLabelTone)
    : 'gray';
}
