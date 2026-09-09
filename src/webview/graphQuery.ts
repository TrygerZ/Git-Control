import type { GraphNode, RepoGraph } from '../messages';
import { sanitizeGitText } from './format';
import type { IconName } from './icons';

export function computeStaggerMap(nodes: readonly GraphNode[]): Map<string, 'above' | 'below'> {
  const map = new Map<string, 'above' | 'below'>();
  const laneMap = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    let list = laneMap.get(node.lane);
    if (!list) { list = []; laneMap.set(node.lane, list); }
    list.push(node);
  }
  for (const laneNodes of laneMap.values()) {
    laneNodes.sort((a, b) => a.x - b.x);
    for (let i = 0; i < laneNodes.length; i += 1) {
      const node = laneNodes[i] as GraphNode;
      map.set(node.hash, i % 2 === 1 ? 'above' : 'below');
    }
  }
  return map;
}

type ChipKind = 'current' | 'local' | 'remote' | 'tag';
export interface Chip { kind: ChipKind; icon: IconName; prefix: string; name: string; }

const CHIP_ICON: Record<ChipKind, IconName> = {
  current: 'git-branch', local: 'circle-filled', remote: 'cloud', tag: 'tag',
};

export function chipsFor(refNames: readonly string[], currentBranch: string | null): Chip[] {
  const chips: Chip[] = [];
  for (const raw of refNames) {
    const name = raw.trim();
    if (name.length === 0 || name === 'HEAD') continue;
    if (name.startsWith('tag: ')) {
      chips.push({ kind: 'tag', icon: CHIP_ICON.tag, prefix: 'tag ', name: sanitizeGitText(name.slice(5)) });
      continue;
    }
    const isRemote = name.includes('/') && !name.startsWith('refs/heads/');
    const short = name.replace('refs/heads/', '').replace('refs/remotes/', '');
    if (isRemote) {
      chips.push({ kind: 'remote', icon: CHIP_ICON.remote, prefix: 'remote ', name: sanitizeGitText(short) });
      continue;
    }
    const isCurrent = currentBranch !== null && short === currentBranch;
    chips.push({ kind: isCurrent ? 'current' : 'local', icon: isCurrent ? CHIP_ICON.current : CHIP_ICON.local, prefix: '', name: sanitizeGitText(short) });
  }
  const order: Record<ChipKind, number> = { current: 0, local: 1, remote: 2, tag: 3 };
  return chips.sort((a, b) => order[a.kind] - order[b.kind]);
}

export function matchesSearch(node: GraphNode, needle: string): boolean {
  if (needle.length === 0) return true;
  const q = needle.toLowerCase();
  return node.hash.toLowerCase().includes(q) || node.subject.toLowerCase().includes(q) || node.authorName.toLowerCase().includes(q);
}

export function lanesForFilter(graph: RepoGraph, filter: string): Set<number> | null {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return null;
  const keep = new Set<number>();
  for (const lane of graph.lanes) {
    if (lane.ref !== undefined && lane.ref.toLowerCase().includes(needle)) keep.add(lane.index);
  }
  return keep.size === 0 ? null : keep;
}
