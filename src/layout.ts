/**
 * Deterministic DAG layout engine. Pure: no DOM, no git, no vscode.
 * Same input always produces byte-identical output, which the tests assert.
 */

import { parseCommitTimestamp } from './validation';

export interface LayoutCommit {
  hash: string;
  parents: string[];
  committedAt?: string | number;
}

export interface LayoutRef {
  /** Full ref name, e.g. `refs/heads/main` or `refs/remotes/origin/main`. */
  refName: string;
  /** Commit the ref points at. */
  objectName: string;
}

export interface LayoutOptions {
  laneHeight?: number;
  columnWidth?: number;
  dayGap?: number;
  gutterX?: number;
  rulerHeight?: number;
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
  /** Global chronological order (0 = oldest, N-1 = newest). */
  index: number;
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

export interface DateBucket {
  label: string;
  timestamp: number;
  startX: number;
  width: number;
  commitCount: number;
  /** 0-based ordinal position among all date buckets in chronological order. */
  index: number;
  /** World-space X coordinate where the day band background and ruler cell begin. */
  bandStartX: number;
  /** World-space width of the day band and ruler cell. */
  bandWidth: number;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  lanes: LayoutLane[];
  dateBuckets: DateBucket[];
}

export const COLUMN_WIDTH = 96;
export const LANE_HEIGHT = 88;
export const NODE_RADIUS = 14;
export const DAY_GAP = 48;
export const RULER_HEIGHT = 32;
export const GUTTER_X = 32;

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

function formatDateLabel(timestamp: number): string {
  if (timestamp <= 0) return 'Tanggal tidak diketahui';
  const d = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function dayKey(timestamp: number): string {
  if (timestamp <= 0) return 'unknown-date';
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function layoutGraph(input: LayoutInput, options: LayoutOptions = {}): LayoutResult {
  const laneHeight = options.laneHeight ?? LANE_HEIGHT;
  const columnWidth = options.columnWidth ?? COLUMN_WIDTH;
  const dayGap = options.dayGap ?? DAY_GAP;
  const gutterX = options.gutterX ?? GUTTER_X;

  const known = new Set(input.commits.map((c) => c.hash));
  const byHash = new Map(input.commits.map((c) => [c.hash, c]));
  const localOnly = computeLocalOnly(input.commits, input.refs, known, byHash);

  /** Lane slot i holds the hash that lane expects next, or null when free. */
  const laneExpect: Array<string | null> = [];

  // Seed lanes by ref priority. A tip already reachable from a higher-priority
  // tip shares that lane instead of reserving one it would never occupy.
  const seeds = seedOrder(input);
  const covered = new Set<string>();
  for (const seed of seeds) {
    if (!known.has(seed.hash)) continue;
    if (covered.has(seed.hash)) continue;
    laneExpect.push(seed.hash);
    markAncestors(seed.hash, byHash, covered);
  }

  const laneOf = new Map<string, number>();

  input.commits.forEach((commit) => {
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
  });

  // Sort chronological (oldest to newest: left to right).
  // Stable sort: when timestamps tie (or when no timestamp), preserve reverse input order (oldest first).
  const indexedCommits = input.commits.map((commit, inputIdx) => ({
    commit,
    inputIdx,
    timestamp: parseCommitTimestamp(commit.committedAt),
  }));

  const chronological = [...indexedCommits].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    // Lower reverse input index means older in topological git log output
    return b.inputIdx - a.inputIdx;
  });

  // Group into calendar day buckets
  const bucketsMap = new Map<string, { key: string; timestamp: number; commits: typeof chronological }>();
  for (const item of chronological) {
    const key = dayKey(item.timestamp);
    let bucket = bucketsMap.get(key);
    if (!bucket) {
      // Start of day timestamp (local time)
      let sod = 0;
      if (item.timestamp > 0) {
        const d = new Date(item.timestamp);
        sod = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      }
      bucket = { key, timestamp: sod, commits: [] };
      bucketsMap.set(key, bucket);
    }
    bucket.commits.push(item);
  }

  const rawBuckets: Array<{
    label: string;
    timestamp: number;
    startX: number;
    width: number;
    commitCount: number;
  }> = [];
  const nodes: LayoutNode[] = [];
  let currentX = gutterX;

  let globalIndex = 0;
  let bucketIdx = 0;

  for (const bucket of bucketsMap.values()) {
    if (bucketIdx > 0) {
      currentX += dayGap;
    }
    const startX = currentX;
    const count = bucket.commits.length;

    for (let i = 0; i < count; i += 1) {
      const item = bucket.commits[i] as (typeof chronological)[0];
      const commit = item.commit;
      const lane = laneOf.get(commit.hash) ?? 0;
      const nodeX = currentX + i * columnWidth;
      const nodeY = lane * laneHeight;

      nodes.push({
        hash: commit.hash,
        x: nodeX,
        y: nodeY,
        lane,
        index: globalIndex,
        isHead: input.head !== null && commit.hash === input.head,
        isMerge: commit.parents.length > 1,
        local: localOnly.has(commit.hash),
      });

      globalIndex += 1;
    }

    const bucketWidth = count * columnWidth;
    rawBuckets.push({
      label: formatDateLabel(bucket.timestamp),
      timestamp: bucket.timestamp,
      startX,
      width: bucketWidth,
      commitCount: count,
    });

    currentX += bucketWidth;
    bucketIdx += 1;
  }

  // Band geometry, separate from `startX`/`width` because those describe where the
  // nodes are and a band has to describe the space they occupy. A node's `x` is a
  // column CENTRE, so a band drawn from `startX` starts halfway through its own first
  // node; the half column comes off both ends to put each node in the middle of its
  // share. Half the day gap is added on each side so the band of one day meets the
  // band of the next with no unpainted seam between them, and the first band clamps
  // to 0 so the left gutter is covered rather than left as a stripe of nothing.
  const halfColumn = columnWidth / 2;
  const halfGap = dayGap / 2;
  const dateBuckets: DateBucket[] = rawBuckets.map((b, idx) => {
    const rawStart = b.startX - halfColumn - halfGap;
    const bandStartX = idx === 0 ? Math.max(0, rawStart) : rawStart;
    const bandWidth = b.startX + b.width - halfColumn + halfGap - bandStartX;

    return {
      label: b.label,
      timestamp: b.timestamp,
      startX: b.startX,
      width: b.width,
      commitCount: b.commitCount,
      index: idx,
      bandStartX,
      bandWidth,
    };
  });

  // `nodes` is already left-to-right chronological, matching `node.index`.

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
  const laneRef = assignLaneRefs(seeds, laneOf);
  const lanes: LayoutLane[] = [];
  for (let index = 0; index < laneCount; index += 1) {
    const ref = laneRef.get(index);
    lanes.push({
      index,
      ...(ref === undefined ? {} : { ref }),
      color: LANE_COLORS[index % LANE_COLORS.length] as string,
    });
  }

  return { nodes, edges, lanes, dateBuckets };
}

/**
 * Label each lane with the highest-priority ref whose tip landed in it. Seeds
 * arrive pre-sorted, so the first match per lane wins.
 */
function assignLaneRefs(seeds: readonly Seed[], laneOf: ReadonlyMap<string, number>): Map<number, string> {
  const laneRef = new Map<number, string>();
  for (const seed of seeds) {
    if (seed.refName === undefined) continue;
    const lane = laneOf.get(seed.hash);
    if (lane === undefined || laneRef.has(lane)) continue;
    laneRef.set(lane, seed.refName);
  }
  return laneRef;
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

/** Mark a tip and all of its in-window ancestors as covered/reachable. */
function markAncestors(
  tip: string,
  byHash: ReadonlyMap<string, LayoutCommit>,
  seen: Set<string>,
): void {
  const stack = [tip];
  while (stack.length > 0) {
    const hash = stack.pop() as string;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const commit = byHash.get(hash);
    if (commit === undefined) continue;
    for (const parent of commit.parents) {
      if (!seen.has(parent)) stack.push(parent);
    }
  }
}

/**
 * Commits NOT reachable from any remote-tracking ref, computed by walking
 * parents from every `refs/remotes/*` tip inside the loaded commit window.
 */
function computeLocalOnly(
  commits: readonly LayoutCommit[],
  refs: readonly LayoutRef[],
  known: ReadonlySet<string>,
  byHash: ReadonlyMap<string, LayoutCommit>,
): Set<string> {
  const reachable = new Set<string>();
  for (const ref of refs) {
    if (!ref.refName.startsWith('refs/remotes/')) continue;
    if (known.has(ref.objectName)) markAncestors(ref.objectName, byHash, reachable);
  }

  const localOnly = new Set<string>();
  for (const commit of commits) {
    if (!reachable.has(commit.hash)) localOnly.add(commit.hash);
  }
  return localOnly;
}
