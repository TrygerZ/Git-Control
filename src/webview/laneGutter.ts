/**
 * Lane gutter model (frame 01, node `10:127`). Pure: no react, no DOM, no vscode.
 *
 * The gutter answers three questions per lane, and each one is a different kind of
 * fact: where the lane's tip sits in the graph (`mergedLanes`, a reachability
 * question over `edges`), what the lane is called and how much it holds
 * (`laneSummaries`), and where its row lands on screen (`laneRowTop`). All three
 * stay here so the component draws and nothing else.
 */
import type { GraphEdge, GraphLane, GraphNode, RefInfo } from '../messages';
import { LANE_HEIGHT, RULER_HEIGHT } from './viewport';

export type LaneStatusKind = 'merged' | 'upstream' | 'local-only' | 'remote-only' | 'tag' | 'unknown';

export interface LaneSummary {
  index: number;
  color: string;
  name: string;
  commits: number;
  status: LaneStatusKind;
  detail: string | null;
}

/** Ref namespace prefixes, longest first so `refs/remotes/` never eats a tag. */
const REF_PREFIXES: ReadonlyArray<readonly [string, 'local' | 'remote' | 'tag']> = [
  ['refs/remotes/', 'remote'],
  ['refs/heads/', 'local'],
  ['refs/tags/', 'tag'],
];

/**
 * Lane indices whose tip another lane's tip can reach.
 *
 * `edge.from` is the child and `edge.to` the parent, so walking forward from a tip
 * follows its ancestry. A lane is merged when some OTHER tip's walk arrives at this
 * lane's tip: that lane's commits are already in the other branch. A branch that
 * forked off and never came back is reached by nobody, which is the frame's
 * `local only`, not `merged`. A lane is never merged into itself.
 *
 * The walk keeps a visited set: a malformed payload with a cycle would otherwise
 * spin forever, and the canvas must never hang on bad data.
 */
export function mergedLanes(
  tips: ReadonlyArray<{ lane: number; hash: string }>,
  edges: readonly GraphEdge[],
): Set<number> {
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    const list = parents.get(edge.from);
    if (list === undefined) parents.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }

  /** Every commit reachable from `start`, the start included. */
  const reachable = (start: string): Set<string> => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const hash = queue.pop() as string;
      for (const parent of parents.get(hash) ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        queue.push(parent);
      }
    }
    return seen;
  };

  const merged = new Set<number>();
  for (const tip of tips) {
    for (const other of tips) {
      if (other.lane === tip.lane) continue;
      if (reachable(other.hash).has(tip.hash)) {
        merged.add(tip.lane);
        break;
      }
    }
  }
  return merged;
}

/** `refs/heads/main` → `main`; anything outside the three namespaces is kept as is. */
function stripRefPrefix(ref: string): string {
  for (const [prefix] of REF_PREFIXES) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

function kindOfRef(ref: string): 'local' | 'remote' | 'tag' | null {
  for (const [prefix, kind] of REF_PREFIXES) {
    if (ref.startsWith(prefix)) return kind;
  }
  return null;
}

/**
 * One row per lane, in lane order.
 *
 * A lane with no rendered node still gets a row with `commits: 0`: the frame draws
 * the full column, and dropping a row would shift every lane below it out of
 * alignment with its own nodes.
 */
export function laneSummaries(
  lanes: readonly GraphLane[],
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  refs: readonly RefInfo[],
  fallbackName: (index: number) => string,
): LaneSummary[] {
  const counts = new Map<number, number>();
  /** Newest node per lane, which is the lane's tip: smallest `x`, first wins a tie. */
  const tipOf = new Map<number, GraphNode>();
  for (const node of nodes) {
    counts.set(node.lane, (counts.get(node.lane) ?? 0) + 1);
    const current = tipOf.get(node.lane);
    if (current === undefined || node.x < current.x) tipOf.set(node.lane, node);
  }
  const merged = mergedLanes(
    [...tipOf].map(([lane, node]) => ({ lane, hash: node.hash })),
    edges,
  );

  return lanes.map((lane) => {
    const ref = lane.ref;
    const kind = ref === undefined ? null : kindOfRef(ref);
    const short = ref === undefined ? null : stripRefPrefix(ref);

    let status: LaneStatusKind;
    let detail: string | null = null;
    if (kind === 'tag') {
      status = 'tag';
      detail = short;
    } else if (merged.has(lane.index)) {
      status = 'merged';
    } else if (kind === 'remote') {
      status = 'remote-only';
    } else if (kind === 'local') {
      // `upstream` is stored as the short tracking name, e.g. `origin/main`.
      const upstream = refs.find((r) => r.refName === ref)?.upstream ?? null;
      if (upstream === null) {
        status = 'local-only';
      } else {
        status = 'upstream';
        detail = upstream;
      }
    } else {
      status = 'unknown';
    }

    return {
      index: lane.index,
      color: lane.color,
      name: short ?? fallbackName(lane.index),
      commits: counts.get(lane.index) ?? 0,
      status,
      detail,
    };
  });
}

/**
 * Screen `top` for a lane row, so its box is centred on the lane's node.
 *
 * `worldCenterY` is `laneY(lane)`: world units inside the canvas world. The gutter's
 * own coordinate space starts at the top of its ruler band, and the canvas paints
 * its world below the same band, so the band height is added here. Without it every
 * label sits exactly `RULER_HEIGHT` above the node it names.
 *
 * Zoom scales the world, the scroller's offset is subtracted, and half the row
 * height centres the box.
 */
export function laneRowTop(
  worldCenterY: number,
  zoom: number,
  scrollTop: number,
  rowHeight: number,
): number {
  return RULER_HEIGHT + worldCenterY * zoom - scrollTop - rowHeight / 2;
}

/**
 * Height of one gutter row at a zoom level.
 *
 * A row IS a lane band, not a label floating inside one, so it is exactly one lane
 * pitch tall. That is what makes the alternating bands tile into continuous stripes
 * and what guarantees no band ever paints over its neighbour, at any zoom.
 */
export function gutterRowHeight(zoom: number): number {
  return LANE_HEIGHT * zoom;
}
