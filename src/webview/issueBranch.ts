/**
 * Branch name suggestion for "Start work" on an issue (P09).
 *
 * Pure: the issue title and labels come from GitHub, so they are folded to ASCII
 * and reduced to `[a-z0-9-]` before any byte of them can reach a git argument.
 * The host validates the name again (`validateAction`), this side is convenience.
 */
import { validateBranchName } from '../validation';
import type { GitActionRequest } from '../messages';

export interface IssueRef {
  number: number;
  title: string;
  labels: readonly string[];
}

export const BRANCH_SLUG_MAX = 40;

// ponytail: fixed filler list reproduces frame 93 sample; upgrade to full NLP stopwords if needed
const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'for', 'in', 'on', 'at', 'by', 'with',
  'per', 'should', 'show', 'from',
]);

function cutOnWordBoundary(folded: string, max: number): string {
  if (folded.length <= max) return folded;
  if (folded[max] === '-') return folded.slice(0, max);
  const candidate = folded.slice(0, max);
  const trimmed = candidate.replace(/-+$/, '');
  if (trimmed.length < candidate.length) {
    return trimmed;
  }
  const lastHyphen = trimmed.lastIndexOf('-');
  return lastHyphen === -1 ? trimmed : trimmed.slice(0, lastHyphen);
}

export function slugifyTitle(title: string, max: number = BRANCH_SLUG_MAX): string {
  if (max <= 0) return '';
  const normalized = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const hyphenated = normalized.replace(/[^a-z0-9]+/g, '-');
  const trimmed = hyphenated.replace(/^-+|-+$/g, '');
  if (trimmed === '') return '';
  return cutOnWordBoundary(trimmed, max);
}

export function suggestBranchName(issue: IssueRef): string {
  const type = issue.labels.some((l) => l.toLowerCase() === 'bug') ? 'fix' : 'feat';
  const normalized = issue.title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const words = normalized
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w));
  if (words.length > 0 && words[words.length - 1] === 'branch') {
    words.pop();
  }
  const slug = slugifyTitle(words.join(' '));
  return slug.length > 0 ? `${type}/${issue.number}-${slug}` : `${type}/${issue.number}`;
}

export type BranchNameProblem = 'empty' | 'invalid' | 'exists';

export function branchNameProblem(
  name: string,
  existingLocal: readonly string[],
): BranchNameProblem | null {
  if (name.trim().length === 0) return 'empty';
  if (!validateBranchName(name)) return 'invalid';
  if (existingLocal.includes(name)) return 'exists';
  return null;
}

export function startWorkRequest(name: string, headHash: string | null): GitActionRequest | null {
  const clean = name.trim();
  if (headHash === null || branchNameProblem(clean, []) !== null) return null;
  return {
    action: 'create-branch',
    name: clean,
    startPoint: headHash,
  };
}
