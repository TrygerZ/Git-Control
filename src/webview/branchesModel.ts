/**
 * Pure view model for the Branches destination (P11).
 *
 * No react, no DOM, no vscode. The view sorts, groups, filters, and labels
 * refs; every one of those decisions lives here so it can be asserted without a
 * DOM harness.
 */
import type { BranchRef, WorktreeInfo } from '../messages';

export type BranchesTab = 'local' | 'remote' | 'tags';
export type BranchSort = 'recent' | 'name' | 'aheadBehind';
export type BranchChip = 'merged' | 'localOnly' | 'upstreamGone';

export interface BranchRowModel {
  /** `refName`: unique even when two remotes carry the same short name. */
  key: string;
  shortName: string;
  isCurrent: boolean;
  ahead: number;
  behind: number;
  /** At most one chip, so the row stays narrow. */
  chips: BranchChip[];
  committedAt: string | null;
}

export interface RemoteGroupModel {
  remote: string;
  rows: BranchRowModel[];
}

export interface TagRowModel {
  key: string;
  name: string;
  shortHash: string;
  committedAt: string | null;
}

function parseDate(d: string | null): number | null {
  if (!d) return null;
  const time = Date.parse(d);
  return Number.isNaN(time) ? null : time;
}

function compareName(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

export function chipsFor(ref: BranchRef): BranchChip[] {
  // Only a real local branch can be merged, unpublished, or have a lost upstream.
  if (ref.kind !== 'local') return [];

  if (ref.gone) return ['upstreamGone'];
  if (ref.merged && !ref.isHead) return ['merged'];
  if (ref.upstream === null && !ref.merged && !ref.isHead) return ['localOnly'];
  return [];
}

export function branchRow(ref: BranchRef): BranchRowModel {
  return {
    key: ref.refName,
    shortName: ref.shortName,
    isCurrent: ref.isHead,
    ahead: ref.ahead,
    behind: ref.behind,
    chips: chipsFor(ref),
    committedAt: ref.committedAt,
  };
}

export function sortLocals(rows: readonly BranchRowModel[], sort: BranchSort): BranchRowModel[] {
  const copy = rows.slice();
  copy.sort((a, b) => {
    if (sort === 'name') {
      return compareName(a.shortName, b.shortName);
    }
    if (sort === 'recent') {
      const ta = parseDate(a.committedAt);
      const tb = parseDate(b.committedAt);
      if (ta !== null && tb !== null) {
        if (tb !== ta) return tb - ta;
        return compareName(a.shortName, b.shortName);
      }
      if (ta !== null) return -1;
      if (tb !== null) return 1;
      return compareName(a.shortName, b.shortName);
    }
    const divA = a.ahead + a.behind;
    const divB = b.ahead + b.behind;
    if (divB !== divA) return divB - divA;
    return compareName(a.shortName, b.shortName);
  });
  return copy;
}

export function filterRows<T extends { shortName?: string; name?: string }>(
  rows: readonly T[],
  query: string,
): T[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return rows as T[];
  const needle = trimmed.toLowerCase();
  return rows.filter((r) => {
    const label = (r.shortName ?? r.name ?? '').toLowerCase();
    return label.includes(needle);
  });
}

export function groupRemotes(refs: readonly BranchRef[]): RemoteGroupModel[] {
  const groups = new Map<string, BranchRowModel[]>();
  for (const ref of refs) {
    if (ref.kind !== 'remote') continue;
    const slash = ref.shortName.indexOf('/');
    const remote = slash === -1 ? ref.shortName : ref.shortName.slice(0, slash);
    if (ref.refName === `refs/remotes/${remote}/HEAD`) continue;
    let rows = groups.get(remote);
    if (!rows) {
      rows = [];
      groups.set(remote, rows);
    }
    rows.push(branchRow(ref));
  }
  const remotes = [...groups.keys()].sort((a, b) => {
    if (a === 'origin') return -1;
    if (b === 'origin') return 1;
    return a.localeCompare(b);
  });
  return remotes.flatMap((remote) => {
    const rows = groups.get(remote);
    return rows === undefined ? [] : [{ remote, rows }];
  });
}

export function tagRows(refs: readonly BranchRef[], limit?: number): TagRowModel[] {
  const tags: TagRowModel[] = [];
  for (const ref of refs) {
    if (ref.kind !== 'tag') continue;
    tags.push({
      key: ref.refName,
      name: ref.shortName,
      shortHash: ref.objectName.slice(0, 7),
      committedAt: ref.committedAt,
    });
  }
  tags.sort((a, b) => {
    const ta = parseDate(a.committedAt);
    const tb = parseDate(b.committedAt);
    if (ta !== null && tb !== null) {
      if (tb !== ta) return tb - ta;
      return compareName(a.name, b.name);
    }
    if (ta !== null) return -1;
    if (tb !== null) return 1;
    return compareName(a.name, b.name);
  });
  return limit !== undefined ? tags.slice(0, limit) : tags;
}

export function visibleWorktrees(list: readonly WorktreeInfo[]): WorktreeInfo[] {
  return list.length <= 1 ? [] : (list as WorktreeInfo[]);
}
