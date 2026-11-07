/**
 * Pure issue list helpers (P08). No react, DOM, or vscode imports.
 *
 * The host already narrows the list by assignee/creator/mentioned and caps the
 * body, so the client only narrows further: label, text, and the label menu.
 */
import type { IssueInfo } from '../messages';

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
