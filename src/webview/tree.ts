/**
 * Flat change paths → collapsible tree, plus tri-state selection maths.
 * Pure: no DOM, no React. `test/tree.test.ts` exercises every rule here.
 */
import type { ChangeEntry } from '../messages';

export type TriState = 'checked' | 'unchecked' | 'indeterminate';

export interface FileNode {
  kind: 'file';
  /** Repo-relative path; the selection key. */
  path: string;
  /** Last path segment. */
  name: string;
  entry: ChangeEntry;
}

export interface FolderNode {
  kind: 'folder';
  /** Path prefix WITHOUT a trailing slash, e.g. `src/webview`. */
  path: string;
  name: string;
  children: TreeNode[];
}

export type TreeNode = FileNode | FolderNode;

/**
 * Build a folder tree from flat entries.
 *
 * Renames key on `entry.path` (the new location) because that is what git
 * stages; `origPath` is display-only and handled by `format.displayPath`.
 * Duplicate paths collapse onto the last entry, which mirrors porcelain output
 * where a path appears once.
 */
export function buildTree(entries: readonly ChangeEntry[]): FolderNode {
  const root: FolderNode = { kind: 'folder', path: '', name: '', children: [] };
  const folders = new Map<string, FolderNode>([['', root]]);

  for (const entry of entries) {
    const segments = entry.path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    const fileName = segments[segments.length - 1] as string;
    let parent = root;
    let prefix = '';
    for (let i = 0; i < segments.length - 1; i += 1) {
      prefix = prefix === '' ? (segments[i] as string) : `${prefix}/${segments[i] as string}`;
      let folder = folders.get(prefix);
      if (folder === undefined) {
        folder = { kind: 'folder', path: prefix, name: segments[i] as string, children: [] };
        folders.set(prefix, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    parent.children.push({ kind: 'file', path: entry.path, name: fileName, entry });
  }

  sortTree(root);
  return root;
}

/** Folders before files, then case-insensitive name order. Stable across renders. */
function sortTree(folder: FolderNode): void {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'id-ID');
  });
  for (const child of folder.children) {
    if (child.kind === 'folder') sortTree(child);
  }
}

/** Every file path under a node, in tree order. */
export function collectPaths(node: TreeNode): string[] {
  if (node.kind === 'file') return [node.path];
  const out: string[] = [];
  for (const child of node.children) out.push(...collectPaths(child));
  return out;
}

/**
 * Tri-state for a node: a folder is `checked` only when every descendant file is
 * selected, `unchecked` when none is, `indeterminate` otherwise. An empty folder
 * counts as `unchecked` — there is nothing to stage.
 */
export function triState(node: TreeNode, selection: ReadonlySet<string>): TriState {
  if (node.kind === 'file') return selection.has(node.path) ? 'checked' : 'unchecked';
  const paths = collectPaths(node);
  if (paths.length === 0) return 'unchecked';
  let selected = 0;
  for (const path of paths) {
    if (selection.has(path)) selected += 1;
  }
  if (selected === 0) return 'unchecked';
  return selected === paths.length ? 'checked' : 'indeterminate';
}

/**
 * Recursive folder toggle. A folder that is fully selected clears; anything else
 * (empty or partial) selects everything under it, which is what users expect
 * from a partially ticked box.
 */
export function toggleNode(node: TreeNode, selection: ReadonlySet<string>): Set<string> {
  const next = new Set(selection);
  const paths = collectPaths(node);
  const shouldSelect = triState(node, selection) !== 'checked';
  for (const path of paths) {
    if (shouldSelect) next.add(path);
    else next.delete(path);
  }
  return next;
}

/** Toggle a single path without touching siblings. */
export function togglePath(path: string, selection: ReadonlySet<string>): Set<string> {
  const next = new Set(selection);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** Drop selected paths that no longer exist after a refresh. */
export function pruneSelection(
  selection: ReadonlySet<string>,
  entries: readonly ChangeEntry[],
): Set<string> {
  const live = new Set(entries.map((e) => e.path));
  let removed = false;
  for (const path of selection) {
    if (!live.has(path)) {
      removed = true;
      break;
    }
  }
  // ponytail: reference equality check avoids downstream memo invalidation when selection is unchanged.
  if (!removed && selection instanceof Set) {
    return selection;
  }
  const next = new Set<string>();
  for (const path of selection) {
    if (live.has(path)) next.add(path);
  }
  return next;
}

export type ChangeSection = 'conflicted' | 'staged' | 'unstaged' | 'untracked';

/**
 * Split entries into the panel's four sections. Order is deliberate: a
 * conflicted file must not also appear under staged, so the first match wins.
 */
export function sectionOf(entry: ChangeEntry): ChangeSection {
  if (entry.indexStatus === 'U' || entry.worktreeStatus === 'U') return 'conflicted';
  if (entry.untracked) return 'untracked';
  if (entry.staged) return 'staged';
  return 'unstaged';
}

/** Group entries by section, preserving input order inside each group. */
export function groupBySection(
  entries: readonly ChangeEntry[],
): Record<ChangeSection, ChangeEntry[]> {
  const groups: Record<ChangeSection, ChangeEntry[]> = {
    conflicted: [],
    staged: [],
    unstaged: [],
    untracked: [],
  };
  for (const entry of entries) groups[sectionOf(entry)].push(entry);
  return groups;
}

/** Ancestor prefixes of a path, nearest last: `a`, `a/b` for `a/b/c.ts`. */
export function ancestorPrefixes(path: string): string[] {
  const segments = path.split('/').filter((s) => s.length > 0);
  const out: string[] = [];
  let prefix = '';
  for (let i = 0; i < segments.length - 1; i += 1) {
    prefix = prefix === '' ? (segments[i] as string) : `${prefix}/${segments[i] as string}`;
    out.push(prefix);
  }
  return out;
}

/** Flattened, expansion-aware row list for rendering without recursion. */
export interface TreeRow {
  node: TreeNode;
  depth: number;
}

/**
 * Filter selected paths for staging.
 *
 * Untracked files ('??') are included directly when the user checked them.
 * Ignored files ('!') are dropped because `git add` on an ignored path exits
 * with error and fails the entire batch. Unknown paths are dropped.
 */
export function stageableFrom(
  selection: ReadonlyArray<string> | ReadonlySet<string>,
  changes: readonly ChangeEntry[],
): string[] {
  const set = selection instanceof Set ? selection : new Set(selection);
  const out: string[] = [];
  for (const path of set) {
    const entry = changes.find((c) => c.path === path);
    if (entry === undefined) continue;
    if (entry.indexStatus !== '!' && entry.worktreeStatus !== '!') {
      out.push(path);
    }
  }
  return out;
}

/**
 * Filter paths for unstaging.
 *
 * Only staged paths or paths in conflict can be unstaged. Untracked entries are
 * dropped because `git restore --staged` on an untracked path fails the entire
 * batch with "pathspec did not match any file(s)".
 */
export function unstageableFrom(
  selection: ReadonlyArray<string> | ReadonlySet<string>,
  changes: readonly ChangeEntry[],
  conflicts: readonly { path: string }[] = [],
): string[] {
  const set = selection instanceof Set ? selection : new Set(selection);
  const out: string[] = [];
  for (const path of set) {
    const entry = changes.find((c) => c.path === path);
    if (entry === undefined) continue;
    if (entry.staged || conflicts.some((c) => c.path === path)) {
      out.push(path);
    }
  }
  return out;
}

export function isSectionBulkDisabled(
  busy: boolean,
  validPathsCount: number,
  isCollapsed: boolean,
): boolean {
  return busy || validPathsCount === 0 || isCollapsed;
}

export function flattenTree(
  root: FolderNode,
  collapsed: ReadonlySet<string>,
  depth: number = 0,
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const child of root.children) {
    rows.push({ node: child, depth });
    if (child.kind === 'folder' && !collapsed.has(child.path)) {
      rows.push(...flattenTree(child, collapsed, depth + 1));
    }
  }
  return rows;
}
