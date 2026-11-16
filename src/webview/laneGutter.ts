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
  /** Headline name: the highest-priority ref whose tip lands in this lane. */
  name: string;
  /** Every ref whose tip lands in this lane, headline first. Never empty. */
  names: string[];
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
 * The tip of every lane: the node with the largest `x`, first wins a tie.
 *
 * The single implementation of the tip rule, shared by `laneSummaries` and the
 * canvas so a dashed edge and a merged gutter row can never disagree about which
 * commit a lane ends at.
 */
export function laneTips(nodes: readonly GraphNode[]): Array<{ lane: number; hash: string }> {
  const tipOf = new Map<number, GraphNode>();
  for (const node of nodes) {
    const current = tipOf.get(node.lane);
    if (current === undefined || node.x > current.x) tipOf.set(node.lane, node);
  }
  return [...tipOf].map(([lane, node]) => ({ lane, hash: node.hash }));
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
  const laneOfHash = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.lane, (counts.get(node.lane) ?? 0) + 1);
    laneOfHash.set(node.hash, node.lane);
  }
  const merged = mergedLanes(laneTips(nodes), edges);

  /** Ref names per lane, in the order `refs` arrives, so the row is deterministic. */
  const namesOf = new Map<number, string[]>();
  for (const ref of refs) {
    const lane = laneOfHash.get(ref.objectName);
    if (lane === undefined) continue;
    const list = namesOf.get(lane);
    if (list === undefined) namesOf.set(lane, [stripRefPrefix(ref.refName)]);
    else list.push(stripRefPrefix(ref.refName));
  }

  return lanes.map((lane) => {
    const ref = lane.ref;
    const kind = ref === undefined ? null : kindOfRef(ref);
    const short = ref === undefined ? null : stripRefPrefix(ref);
    const names = namesOf.get(lane.index) ?? [short ?? fallbackName(lane.index)];

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
        detail = stripRemotePrefix(upstream);
      }
    } else {
      status = 'unknown';
    }

    // The layout picked this lane's highest-priority ref (current branch, then
    // remote, then local, then tag). Git hands `refs` over alphabetically, so the
    // row would otherwise headline `ci/...` instead of `main`. Move that entry to
    // the front and keep the rest in arrival order, so the result stays stable.
    if (short !== null && names[0] !== short) {
      const at = names.indexOf(short);
      if (at > 0) {
        names.splice(at, 1);
        names.unshift(short);
      }
    }

    const [headline = fallbackName(lane.index)] = names;
    return {
      index: lane.index,
      color: lane.color,
      name: headline,
      names,
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

/**
 * One merge boundary: the x of a merge commit that brought a named branch in.
 *
 * `x` is world units, so the caller scales it by the zoom before comparing with a
 * scroll offset. `name` is the short branch name, already stripped of its prefix.
 */
export interface MergeBoundary {
  name: string;
  x: number;
}

/**
 * The name the merged row shows for a given horizontal scroll position.
 *
 * Frame 01's merged row is not a list. The branches merged into the base sit along
 * the timeline in landing order, and the row names the NEXT branch: the first merge
 * at or after the viewport's left edge, so the row tells you what is coming rather
 * than what is behind. It advances the moment the previous merge falls behind the
 * edge.
 *
 * `scrollX` is the LEFT edge of the viewport in world units.
 *
 * Two deliberate rules:
 *  - A gap between merges keeps the next name rather than blanking the row. The
 *    real repository has 41 refs and 14 merges, so long gaps are normal.
 *  - A boundary whose name is not in `row.names` is skipped. A merge can reference
 *    a branch that has since been deleted or was never paged in, and printing it
 *    would name a branch the row does not hold.
 *
 * Past the last merge the row holds that last name instead of blanking, and it
 * falls back to `row.name` when there are no boundaries at all.
 */
/**
 * `refs/remotes/origin/main` -> `origin/main`, the name frame 01 prints on a lane
 * row's meta line. Anything else is returned unchanged, so the helper is safe to
 * call on a value that is already short.
 */
export function stripRemotePrefix(ref: string): string {
  return ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref;
}

/**
 * Whether an edge that lands on `toLane` is drawn dashed.
 *
 * Frame 01 dashes an edge into a branch that has not landed on the current line
 * yet (`12:19` into `feat/graph-ribbons`, `12:20` into `origin/release/1.4`) and
 * keeps it solid once the branch is merged (`12:17`, `12:18`). An unknown lane is
 * unmerged, so it stays dashed rather than claiming a merge nobody proved.
 */
export function edgeDashed(toLane: number, merged: ReadonlySet<number>): boolean {
  return !merged.has(toLane);
}

export function mergedNameAt(
  row: LaneSummary,
  boundaries: readonly MergeBoundary[],
  scrollX: number,
): string {
  // Read in arrival order, never sorted: the caller's array is read-only. The
  // first qualifying boundary ahead of the edge wins; the last qualifying one is
  // the fallback once every merge has scrolled behind.
  let ahead: string | null = null;
  let last: string | null = null;
  for (const boundary of boundaries) {
    if (!row.names.includes(boundary.name)) continue;
    last = boundary.name;
    if (ahead === null && boundary.x >= scrollX) ahead = boundary.name;
  }
  return ahead ?? last ?? row.name;
}
