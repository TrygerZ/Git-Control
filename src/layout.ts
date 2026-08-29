/**
 * Deterministic DAG layout engine. Pure: no DOM, no git, no vscode.
 * Same input always produces byte-identical output, which the tests assert.
 */

export interface LayoutCommit {
  hash: string;
  parents: string[];
}

export interface LayoutRef {
  /** Full ref name, e.g. `refs/heads/main` or `refs/remotes/origin/main`. */
  refName: string;
  /** Commit the ref points at. */
  objectName: string;
}

export interface LayoutOptions {
  rowHeight?: number;
  laneWidth?: number;
}

export interface LayoutInput {
  /** Commits in topological order, newest first, exactly as `git log` returns. */
  commits: readonly LayoutCommit[];
  refs: readonly LayoutRef[];
  /** HEAD commit hash, or `null` in an empty repository. */
  head: string | null;
  /** Short name of the checked-out branch, or `null` when detached. */
  currentBranch?: string | null;
}

export interface LayoutNode {
  hash: string;
  x: number;
  y: number;
  lane: number;
  isHead: boolean;
  isMerge: boolean;
  /** True when unreachable from every remote-tracking ref. */
  local: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
  fromLane: number;
  toLane: number;
  kind: 'direct' | 'merge';
}

export interface LayoutLane {
  index: number;
  ref?: string;
  color: string;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  lanes: LayoutLane[];
}

const DEFAULT_ROW_HEIGHT = 24;
const DEFAULT_LANE_WIDTH = 16;

/** Fixed palette: index-based so colors are stable across renders. */
const LANE_COLORS = [
  '#4e9bff',
  '#f2994a',
  '#27ae60',
  '#eb5757',
  '#9b51e0',
  '#2d9cdb',
  '#f2c94c',
  '#56ccf2',
] as const;

/** Lane seeding priority: lower rank claims a lower lane index. */
const RANK_CURRENT_BRANCH = 0;
const RANK_REMOTE = 1;
const RANK_LOCAL = 2;
const RANK_DETACHED_HEAD = 3;
const RANK_TAG = 4;

export function layoutGraph(input: LayoutInput, options: LayoutOptions = {}): LayoutResult {
  const rowHeight = options.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const laneWidth = options.laneWidth ?? DEFAULT_LANE_WIDTH;

  const known = new Set(input.commits.map((c) => c.hash));
  const localOnly = computeLocalOnly(input.commits, input.refs, known);

  /** Lane slot i holds the hash that lane expects next, or null when free. */
  const laneExpect: Array<string | null> = [];
  const laneRef = new Map<number, string>();

  // Seed lanes by ref priority so lane order is meaningful and deterministic.
  for (const seed of seedOrder(input)) {
    if (!known.has(seed.hash)) continue;
    if (laneExpect.includes(seed.hash)) continue;
    laneExpect.push(seed.hash);
    if (seed.refName !== undefined) laneRef.set(laneExpect.length - 1, seed.refName);
  }

  const laneOf = new Map<string, number>();
  const nodes: LayoutNode[] = [];

  input.commits.forEach((commit, index) => {
    let lane = laneExpect.indexOf(commit.hash);
    if (lane === -1) lane = claimLane(laneExpect, commit.hash);
    laneOf.set(commit.hash, lane);

    // Free duplicate reservations: several children can await the same commit.
    for (let i = 0; i < laneExpect.length; i += 1) {
      if (i !== lane && laneExpect[i] === commit.hash) laneExpect[i] = null;
    }

    const parents = commit.parents;
    const firstParent = parents[0];
    // First-parent continuity: the parent inherits this commit's lane.
    laneExpect[lane] = firstParent !== undefined && known.has(firstParent) ? firstParent : null;

    for (let p = 1; p < parents.length; p += 1) {
      const parent = parents[p] as string;
      if (!known.has(parent)) continue;
      if (laneExpect.includes(parent)) continue;
      claimLane(laneExpect, parent);
    }

    nodes.push({
      hash: commit.hash,
      x: lane * laneWidth,
      y: index * rowHeight,
      lane,
      isHead: input.head !== null && commit.hash === input.head,
      isMerge: parents.length > 1,
      local: localOnly.has(commit.hash),
    });
  });

  const edges: LayoutEdge[] = [];
  for (const commit of input.commits) {
    const fromLane = laneOf.get(commit.hash);
    if (fromLane === undefined) continue;
    commit.parents.forEach((parent, position) => {
      const toLane = laneOf.get(parent);
      if (toLane === undefined) return;
      edges.push({
        from: commit.hash,
        to: parent,
        fromLane,
        toLane,
        kind: position === 0 ? 'direct' : 'merge',
      });
    });
  }

  const laneCount = nodes.reduce((max, node) => Math.max(max, node.lane + 1), 0);
  const lanes: LayoutLane[] = [];
  for (let index = 0; index < laneCount; index += 1) {
    const ref = laneRef.get(index);
    lanes.push({
      index,
      ...(ref === undefined ? {} : { ref }),
      color: LANE_COLORS[index % LANE_COLORS.length] as string,
    });
  }

  return { nodes, edges, lanes };
}

/** Take the lowest free lane, appending a new one only when all are busy. */
function claimLane(laneExpect: Array<string | null>, hash: string): number {
  const free = laneExpect.indexOf(null);
  if (free !== -1) {
    laneExpect[free] = hash;
    return free;
  }
  laneExpect.push(hash);
  return laneExpect.length - 1;
}

interface Seed {
  hash: string;
  refName?: string;
  rank: number;
}

/**
 * Ordered lane seeds: current branch, remote branches, local branches,
 * detached HEAD, then tags. Ties break by ref name and then hash so the
 * result never depends on input ordering.
 */
function seedOrder(input: LayoutInput): Seed[] {
  const seeds: Seed[] = [];
  const currentRef = input.currentBranch != null ? `refs/heads/${input.currentBranch}` : null;

  for (const ref of input.refs) {
    const rank = rankOf(ref.refName, currentRef);
    if (rank === null) continue;
    seeds.push({ hash: ref.objectName, refName: ref.refName, rank });
  }

  if (input.head !== null && currentRef === null) {
    seeds.push({ hash: input.head, rank: RANK_DETACHED_HEAD });
  }

  return seeds.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const aRef = a.refName ?? '';
    const bRef = b.refName ?? '';
    if (aRef !== bRef) return aRef < bRef ? -1 : 1;
    return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
  });
}

function rankOf(refName: string, currentRef: string | null): number | null {
  if (currentRef !== null && refName === currentRef) return RANK_CURRENT_BRANCH;
  if (refName.startsWith('refs/remotes/')) return RANK_REMOTE;
  if (refName.startsWith('refs/heads/')) return RANK_LOCAL;
  if (refName.startsWith('refs/tags/')) return RANK_TAG;
  return null;
}

/**
 * Commits NOT reachable from any remote-tracking ref, computed by walking
 * parents from every `refs/remotes/*` tip inside the loaded commit window.
 */
function computeLocalOnly(
  commits: readonly LayoutCommit[],
  refs: readonly LayoutRef[],
  known: ReadonlySet<string>,
): Set<string> {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const reachable = new Set<string>();
  const stack: string[] = [];

  for (const ref of refs) {
    if (!ref.refName.startsWith('refs/remotes/')) continue;
    if (known.has(ref.objectName)) stack.push(ref.objectName);
  }

  while (stack.length > 0) {
    const hash = stack.pop() as string;
    if (reachable.has(hash)) continue;
    reachable.add(hash);
    const commit = byHash.get(hash);
    if (commit === undefined) continue;
    for (const parent of commit.parents) {
      if (known.has(parent) && !reachable.has(parent)) stack.push(parent);
    }
  }

  const localOnly = new Set<string>();
  for (const commit of commits) {
    if (!reachable.has(commit.hash)) localOnly.add(commit.hash);
  }
  return localOnly;
}
