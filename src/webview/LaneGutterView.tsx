/**
 * Lane gutter (frame 01, node `10:127`): the fixed left column that names each
 * lane, counts its commits, and says where it stands.
 *
 * It sits beside `.gc-canvas` in `.gc-graph__stage`, not inside it, so the column
 * stays put while the graph pans. Rows are absolutely positioned from
 * `laneRowTop`, which is the same `laneY` maths the nodes use, so a row stays
 * centred on its lane at any zoom and scroll.
 *
 * The file is named `LaneGutterView` rather than `LaneGutter` because the pure
 * model beside it is `laneGutter.ts`: two names one letter case apart collide on a
 * case-insensitive filesystem, and both resolvers then read the wrong file.
 *
 * The whole column is `aria-hidden`: every fact in it is already in the grid rows
 * (`rowLabel`), and exposing it again would make a screen reader walk each branch
 * before reaching a commit.
 */
import { useMemo, type JSX } from 'react';
import { formatCount, sanitizeGitText } from './format';
import {
  gutterRowHeight,
  laneRowTop,
  laneSummaries,
  mergedNameAt,
  type LaneSummary,
  type MergeBoundary,
} from './laneGutter';
import { useSettingsStore } from './store';
import { useT } from './useT';
import { LANE_HEIGHT, RULER_HEIGHT, laneY } from './viewport';
import type { RepoGraph } from '../messages';

interface Props {
  graph: RepoGraph;
  zoom: number;
  scrollTop: number;
  scrollLeft: number;
}

export function LaneGutterView({ graph, zoom, scrollTop, scrollLeft }: Props): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);

  const rows = useMemo(
    () =>
      laneSummaries(graph.lanes, graph.nodes, graph.edges, graph.refs, (index) =>
        strings.legend.laneDefault(index + 1),
      ),
    [graph, strings],
  );

  /**
   * The merge commits that landed a named branch, in timeline order.
   *
   * A merge node's `kind === 'merge'` edge points at the second parent, the tip
   * that was merged in, so the ref sitting on that tip names the branch. A tip
   * with no ref is a deleted branch: skip it rather than print a name the row
   * does not hold. Only the merged row uses this list, so a graph with no merged
   * lane never pays for it.
   */
  const boundaries = useMemo<MergeBoundary[]>(() => {
    if (!rows.some((row) => row.status === 'merged')) return [];
    const nameOfHash = new Map<string, string>();
    // First ref on a tip wins, matching the order the row's `names` lists them.
    for (const ref of graph.refs) {
      if (!nameOfHash.has(ref.objectName)) nameOfHash.set(ref.objectName, ref.shortName);
    }
    const list: MergeBoundary[] = [];
    for (const node of graph.nodes) {
      if (!node.isMerge) continue;
      const edge = graph.edges.find((e) => e.kind === 'merge' && e.from === node.hash);
      if (edge === undefined) continue;
      const name = nameOfHash.get(edge.to);
      if (name === undefined) continue;
      list.push({ name, x: node.x });
    }
    // The array is ours, so sorting it in place is fine and gives the helper the
    // ascending order it expects.
    return list.sort((a, b) => a.x - b.x);
  }, [graph, rows]);

  /** Left edge of the viewport in world units, which is the anchor the row follows. */
  const scrollX = zoom > 0 ? scrollLeft / zoom : 0;

  /** The frame prints one word per lane; an upstream lane prints its target instead. */
  const statusWord = (row: LaneSummary): string => {
    switch (row.status) {
      case 'merged':
        return strings.graph.laneMerged;
      case 'local-only':
        return strings.graph.laneLocalOnly;
      case 'remote-only':
        return strings.graph.laneRemoteOnly;
      case 'tag':
        return strings.graph.laneTag;
      case 'upstream':
        return row.detail ?? strings.graph.laneLocalOnly;
      default:
        return strings.graph.laneUnknown;
    }
  };

  return (
    <div className="gc-gutter" aria-hidden="true">
      <div className="gc-gutter__head">{strings.graph.laneGutterHead}</div>
      {rows.map((row) => {
        const height = gutterRowHeight(zoom);
        return (
          <div
            key={row.index}
            className="gc-gutter__row"
            style={{
              top: `${laneRowTop(laneY(row.index, LANE_HEIGHT, RULER_HEIGHT), zoom, scrollTop, height)}px`,
              height: `${height}px`,
            }}
          >
            <span className="gc-gutter__dot" style={{ background: row.color }} />
            <span
              className="gc-gutter__name"
              title={sanitizeGitText(row.names.join(' · '))}
            >
              <span className="gc-gutter__label">
                {sanitizeGitText(
                  row.status === 'merged' ? mergedNameAt(row, boundaries, scrollX) : row.name,
                )}
              </span>
              {row.names.length - 1 > 0 ? (
                <span className="gc-gutter__more">
                  {strings.graph.laneMoreOthers(row.names.length - 1)}
                </span>
              ) : null}
            </span>
            <span className="gc-gutter__meta">
              {strings.graph.laneCommits(formatCount(row.commits, language))} · {statusWord(row)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
