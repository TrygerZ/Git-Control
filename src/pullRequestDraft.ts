/**
 * Pull request draft builder and input validation (P22).
 *
 * Pure: no vscode, no fetch, no clock. The dialog's prefilled title and body, and
 * the rules that decide whether a submission may leave the webview at all, live
 * here so both are testable without an editor or a network.
 *
 * ponytail: the builder is intentionally small. It fills a title and a body from
 * data the host already reads; every richer behaviour (labels, linked issues,
 * assignees) is a field the user types into, not a rule this module has to model.
 */

import { validateBranchName } from './validation';

export const TITLE_MAX = 256;
export const BODY_MAX = 65_536;
export const REVIEWERS_MAX = 15;

/**
 * A GitHub login, as the API accepts it in `requested_reviewers`. A login cannot
 * begin or end with a hyphen, so the character class alone would let `-x` through.
 */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface DraftCommit {
  subject: string;
  body?: string;
}

export interface DraftInput {
  title: string;
  body: string;
  base: string;
  head: string;
  reviewers: readonly string[];
}

export type DraftField = 'title' | 'body' | 'base' | 'head' | 'reviewers';

/**
 * Turns `feat/graph-ribbons` into `Graph ribbons`. Only the last segment is used
 * because a nested `team/feat/x` describes `x`. A slug with nothing left after
 * trimming separators returns unchanged: an empty title is worse than a raw one.
 */
export function humanizeBranch(branch: string): string {
  const slug = branch.slice(branch.lastIndexOf('/') + 1);
  const words = slug.replace(/[-_]+/g, ' ').trim();
  if (words.length === 0) return branch;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Folds line endings so a Windows template and a POSIX one produce the same body. */
export function normalizeTemplate(template: string | null): string {
  if (template === null) return '';
  return template.replace(/\r\n?/g, '\n').trim();
}

/**
 * Folds a reviewer list to what the GitHub API accepts in `requested_reviewers`.
 * Dedupe is case-sensitive because GitHub logins are; the cap mirrors the API.
 */
export function normalizeReviewers(logins: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of logins) {
    const login = raw.trim();
    if (!LOGIN.test(login) || out.includes(login)) continue;
    out.push(login);
    if (out.length === REVIEWERS_MAX) break;
  }
  return out;
}

/**
 * A single commit names the pull request; several do not, so the branch does.
 * A template with content wins over the generated bullet list.
 */
export function buildDraft(
  commits: ReadonlyArray<DraftCommit>,
  template: string | null,
  branch: string,
): { title: string; body: string } {
  const subject = commits.length === 1 ? (commits[0]?.subject.trim() ?? '') : humanizeBranch(branch);
  const normalized = normalizeTemplate(template);
  const body =
    normalized.length > 0
      ? normalized
      : commits
          .map((commit) => commit.subject.trim())
          .filter((line) => line.length > 0)
          .map((line) => `- ${line}`)
          .join('\n');
  return { title: subject.slice(0, TITLE_MAX), body: body.slice(0, BODY_MAX) };
}

/**
 * The gate between webview input and the GitHub create call. Fields are checked
 * in order so the dialog can focus the first one that is wrong. A PR title is one
 * line, so any control character fails it; a body is multiline by nature, so only
 * NUL (which the API cannot carry) fails there. Non-strings are rejected, never
 * coerced.
 */
export function validatePullRequestInput(
  input: DraftInput,
): { ok: true } | { ok: false; field: DraftField } {
  const { title, body, base, head, reviewers } = input;
  if (
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > TITLE_MAX ||
    CONTROL_CHARS.test(title)
  ) {
    return { ok: false, field: 'title' };
  }
  if (typeof body !== 'string' || body.length > BODY_MAX || body.includes('\u0000')) {
    return { ok: false, field: 'body' };
  }
  if (!validateBranchName(base)) return { ok: false, field: 'base' };
  if (!validateBranchName(head)) return { ok: false, field: 'head' };
  if (head === base) return { ok: false, field: 'head' };
  if (!Array.isArray(reviewers) || reviewers.length > REVIEWERS_MAX) {
    return { ok: false, field: 'reviewers' };
  }
  for (const login of reviewers) {
    if (typeof login !== 'string' || !LOGIN.test(login)) return { ok: false, field: 'reviewers' };
  }
  return { ok: true };
}
