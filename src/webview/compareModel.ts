/**
 * Pure presentation and form helpers for Phase 29 (Compare and worktrees).
 * Zero `vscode` or `node:` imports.
 */
import type { CompareResult, Lang } from '../messages';
import { t } from './i18n';

export function summaryLine(
  r: Pick<CompareResult, 'ahead' | 'files' | 'totals' | 'truncated'>,
  lang: Lang,
): string {
  const strings = t(lang).compare;
  const line = strings.summary(
    String(r.ahead),
    String(r.totals.files),
    String(r.totals.additions),
    String(r.totals.deletions),
  );
  return r.truncated ? `${line} ${strings.truncated(String(r.files.length))}` : line;
}

export function swapSides(sel: { base: string; head: string }): { base: string; head: string } {
  return { base: sel.head, head: sel.base };
}

export function defaultWorktreePath(repoName: string, branch: string, repoRoot: string): string {
  const safeBranch = branch.replace(/\//g, '-');
  const trimmed = repoRoot.replace(/[\\/]+$/, '');
  const sep = repoRoot.includes('\\') ? '\\' : '/';
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (lastSep === -1) return `${repoName}-${safeBranch}`;
  const parent = trimmed.slice(0, lastSep);
  return `${parent}${sep}${repoName}-${safeBranch}`;
}

function normalizeWorktreeFormPath(raw: string): string {
  const trimmed = raw.trim().replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:/.test(trimmed)) {
    return trimmed.replace(/\\/g, '/').toLowerCase();
  }
  return trimmed;
}

export function canAddWorktree(form: { path: string; branch: string }, existing: readonly string[]): boolean {
  const path = form.path.trim();
  const branch = form.branch.trim();
  if (path.length === 0 || branch.length === 0) return false;
  const normalized = normalizeWorktreeFormPath(path);
  return !existing.some((entry) => normalizeWorktreeFormPath(entry) === normalized);
}

export function canOfferAddWorktree(
  row: { kind: 'local' | 'remote'; name: string },
  worktrees: ReadonlyArray<{ branch: string | null }>,
): boolean {
  return row.kind === 'local' && !worktrees.some((w) => w.branch === row.name);
}

export function compareCommand(base: string, head: string): string {
  return `git diff ${base}...${head}`;
}

export function worktreeCommand(targetPath: string, branch: string): string {
  return `git worktree add -- ${targetPath} ${branch}`;
}
