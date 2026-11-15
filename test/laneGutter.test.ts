/**
 * Lane gutter (frame 01, node `10:127`).
 *
 * The column on the left of the canvas names each lane, counts its commits, and
 * says where it stands. That classification is the whole feature, so it is pinned
 * here as behaviour: four lane shapes plus the merged question, which is a graph
 * question and not a git one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gutterRowHeight, laneRowTop, laneSummaries, mergedLanes } from '../src/webview/laneGutter';
import { LANE_HEIGHT, MIN_ZOOM, RULER_HEIGHT, laneY } from '../src/webview/viewport';
import type { GraphEdge, GraphLane, GraphNode, RefInfo } from '../src/messages';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

function node(hash: string, lane: number, patch: Partial<GraphNode> = {}): GraphNode {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    x: 0,
    y: 0,
    lane,
    isHead: false,
    isMerge: false,
    local: false,
    subject: 'subject',
    authorName: 'author',
    authoredAt: '',
    refNames: [],
    ...patch,
  };
}

function ref(shortName: string, kind: RefInfo['kind'], upstream: string | null = null): RefInfo {
  return {
    refName:
      kind === 'local'
        ? `refs/heads/${shortName}`
        : kind === 'remote'
          ? `refs/remotes/${shortName}`
          : `refs/tags/${shortName}`,
    shortName,
    kind,
    objectName: A,
    upstream,
    ahead: 0,
    behind: 0,
    isHead: false,
    gone: false,
    committedAt: null,
  };
}

function edge(from: string, to: string, fromLane: number, toLane: number): GraphEdge {
  return { from, to, fromLane, toLane, kind: 'direct' };
}

const fallback = (index: number): string => `lane ${index + 1}`;

// ------------------------------------------------------------------ merged

test('a lane whose tip another tip can reach is merged into that lane', () => {
  // `main` (lane 0) is ahead of the feature branch: its history walks back
  // through the feat tip B, so feat is contained in main. Main itself is reached
  // by nobody, which is the whole distinction the frame draws with `merged`
  // versus `local only`.
  const edges = [edge(A, B, 0, 1), edge(B, C, 1, 0)];
  const merged = mergedLanes(
    [
      { lane: 0, hash: A },
      { lane: 1, hash: B },
    ],
    edges,
  );
  assert.deepEqual([...merged], [1], 'only the contained lane is merged');
});

test('a branch that forked off and never came back is not merged', () => {
  // The feat tip B hangs off main's history but nothing reaches it: this is the
  // frame's `local only`, not `merged`. A predicate that called any lane whose
  // ancestry leaves it "merged" would mislabel every unmerged branch.
  const edges = [edge(A, C, 0, 0), edge(B, C, 1, 0)];
  const merged = mergedLanes(
    [
      { lane: 0, hash: A },
      { lane: 1, hash: B },
    ],
    edges,
  );
  assert.deepEqual([...merged], [], 'a forked branch stays unmerged');
});

test('an unmerged branch stays unmerged, and a lane cannot merge into itself', () => {
  const edges = [edge(A, C, 0, 0), edge(B, D, 1, 1)];
  const merged = mergedLanes(
    [
      { lane: 0, hash: A },
      { lane: 1, hash: B },
    ],
    edges,
  );
  assert.deepEqual([...merged], []);
});

test('a merge cycle terminates instead of hanging', () => {
  // Two lanes reaching each other is impossible in real history but a malformed
  // payload must not spin the canvas.
  const edges = [edge(A, B, 0, 1), edge(B, A, 1, 0)];
  const merged = mergedLanes(
    [
      { lane: 0, hash: A },
      { lane: 1, hash: B },
    ],
    edges,
  );
  assert.deepEqual([...merged].sort(), [0, 1]);
});

// ---------------------------------------------------------------- summaries

test('every lane shape from the frame gets its own status word', () => {
  const lanes: GraphLane[] = [
    { index: 0, ref: 'refs/heads/main', color: '#111111' },
    { index: 1, ref: 'refs/heads/feat/stash', color: '#222222' },
    { index: 2, ref: 'refs/heads/fix/graph', color: '#333333' },
    { index: 3, ref: 'refs/remotes/origin/release/1.4', color: '#444444' },
    { index: 4, ref: 'refs/tags/v2.7.0', color: '#555555' },
    { index: 5, color: '#666666' },
  ];
  const nodes = [
    node(A, 0),
    node(C, 0),
    node(B, 1),
    node(D, 2),
  ];
  // main reaches the feat tip, so feat is merged into main.
  const edges = [edge(A, B, 0, 1), edge(B, C, 1, 0)];
  const refs = [ref('main', 'local', 'origin/main'), ref('feat/stash', 'local'), ref('fix/graph', 'local')];

  const summaries = laneSummaries(lanes, nodes, edges, refs, fallback);

  assert.deepEqual(
    summaries.map((s) => [s.index, s.name, s.status, s.commits]),
    [
      [0, 'main', 'upstream', 2],
      [1, 'feat/stash', 'merged', 1],
      [2, 'fix/graph', 'local-only', 1],
      [3, 'origin/release/1.4', 'remote-only', 0],
      [4, 'v2.7.0', 'tag', 0],
      [5, 'lane 6', 'unknown', 0],
    ],
  );
  // The upstream detail is what the frame prints after the dot.
  assert.equal(summaries[0]?.detail, 'origin/main');
});

test('the colour comes from the layout lane, never from a literal here', () => {
  const lanes: GraphLane[] = [{ index: 0, ref: 'refs/heads/main', color: '#123456' }];
  const summaries = laneSummaries(lanes, [node(A, 0)], [], [ref('main', 'local')], fallback);
  assert.equal(summaries[0]?.color, '#123456');
});

test('a lane with no rendered node reports zero commits rather than dropping out', () => {
  // The frame draws a row per lane even when the lane's commits are scrolled out;
  // a missing row would shift every lane below it out of alignment with its nodes.
  const lanes: GraphLane[] = [
    { index: 0, ref: 'refs/heads/main', color: '#111111' },
    { index: 1, ref: 'refs/heads/idle', color: '#222222' },
  ];
  const summaries = laneSummaries(lanes, [node(A, 0)], [], [ref('main', 'local')], fallback);
  assert.equal(summaries.length, 2);
  assert.equal(summaries[1]?.commits, 0);
});

test('the fallback name is used only for a lane with no ref', () => {
  const lanes: GraphLane[] = [
    { index: 0, ref: 'refs/heads/main', color: '#111111' },
    { index: 1, color: '#222222' },
  ];
  const summaries = laneSummaries(lanes, [], [], [], fallback);
  assert.equal(summaries[0]?.name, 'main');
  assert.equal(summaries[1]?.name, 'lane 2');
});

// ------------------------------------------------------------------ geometry

test('a lane row is centred on its node and follows zoom and scroll', () => {
  // The gutter's own top is the ruler band, and the canvas world starts below that
  // band, so a row's top is the world centre plus RULER_HEIGHT. Without the offset
  // every label sits 32 px above the node it names, which is what the first
  // implementation did.
  assert.equal(laneRowTop(laneY(0, LANE_HEIGHT, RULER_HEIGHT), 1, 0, 33), 91.5);
  assert.equal(laneRowTop(laneY(0, LANE_HEIGHT, RULER_HEIGHT), 2, 0, 33), 167.5);
  assert.equal(laneRowTop(laneY(0, LANE_HEIGHT, RULER_HEIGHT), 1, 40, 33), 51.5);
});

test('a row centre lands exactly on the node centre it names', () => {
  // The alignment claim, stated as behaviour instead of as an arithmetic identity
  // on one constant: whatever the zoom and scroll, centre(row) === centre(node).
  for (const zoom of [0.35, 0.5, 1, 1.75, 4]) {
    for (const scrollTop of [0, 37, 512]) {
      for (const lane of [0, 1, 7]) {
        const height = gutterRowHeight(zoom);
        const top = laneRowTop(laneY(lane, LANE_HEIGHT, RULER_HEIGHT), zoom, scrollTop, height);
        const rowCentre = top + height / 2;
        // The canvas paints its world below the sticky ruler band.
        const nodeCentre = RULER_HEIGHT + laneY(lane, LANE_HEIGHT, RULER_HEIGHT) * zoom - scrollTop;
        assert.ok(
          Math.abs(rowCentre - nodeCentre) < 1e-9,
          `lane ${lane} at zoom ${zoom}, scroll ${scrollTop}: row ${rowCentre} vs node ${nodeCentre}`,
        );
      }
    }
  }
});

test('a row is exactly one lane tall, so the bands tile with no gap and no overlap', () => {
  // The row is the lane's band, not a label floating in the middle of one. Two
  // consequences the user asked for: alternating bands read as continuous stripes,
  // and no band can ever paint over its neighbour at any zoom.
  for (const zoom of [MIN_ZOOM, 0.4, 0.5, 0.75, 1, 2, 4]) {
    assert.equal(gutterRowHeight(zoom), LANE_HEIGHT * zoom, `zoom ${zoom}`);
  }
  assert.equal(gutterRowHeight(1), LANE_HEIGHT, '100 % is one lane pitch, 88 px');
  // Consecutive lanes start exactly where the previous band ends.
  for (const lane of [0, 1, 2, 6]) {
    const zoom = 1;
    const top = laneRowTop(laneY(lane, LANE_HEIGHT, RULER_HEIGHT), zoom, 0, gutterRowHeight(zoom));
    const next = laneRowTop(laneY(lane + 1, LANE_HEIGHT, RULER_HEIGHT), zoom, 0, gutterRowHeight(zoom));
    assert.equal(next, top + gutterRowHeight(zoom), `lane ${lane} and ${lane + 1} share an edge`);
  }
});

// -------------------------------------------------------------- the surface

test('the gutter is mounted beside the canvas, not inside the scroller', () => {
  // A column inside `.gc-canvas` would scroll away with the content, so the frame
  // shows it fixed while the graph pans horizontally.
  const src = read('src/webview/GraphCanvas.tsx');
  assert.match(src, /<LaneGutterView\b/, 'the column is drawn');
  assert.match(src, /gc-graph__stage/, 'inside the stage, which is the fixed frame');
  const canvas = src.indexOf('className="gc-canvas"');
  const gutter = src.indexOf('<LaneGutterView');
  assert.ok(gutter > 0 && gutter < canvas, 'the gutter sits before the scrolling canvas');
});

test('the gutter heading is the frame word and both catalogs carry it', () => {
  const src = read('src/webview/LaneGutterView.tsx');
  assert.match(src, /strings\.graph\.laneGutterHead/);
  assert.match(src, /strings\.graph\.laneCommits\(/);
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    for (const key of ['laneGutterHead', 'laneCommits', 'laneMerged', 'laneLocalOnly', 'laneRemoteOnly', 'laneTag', 'laneUnknown']) {
      assert.ok(catalog.includes(`    ${key}:`), `${lang} catalog is missing ${key}`);
    }
  }
  // The frame's ruler cell reads BRANCHES. `Lanes` names the mechanism; the frame
  // names the thing the user is looking for.
  assert.match(read('src/webview/i18n.en.ts'), /laneGutterHead: 'Branches'/);
  assert.match(read('src/webview/i18n.id.ts'), /laneGutterHead: 'Branch'/);
});

test('a row reads like the frame: name on its own line, then commits and status', () => {
  // Frame 01 stacks two lines: `main` beside its dot, then `9 commits · origin/main`
  // underneath. Right-aligning the count on the first line, as the first pass did,
  // crowds the name and breaks the reading order the frame establishes.
  const src = read('src/webview/LaneGutterView.tsx');
  const metaAt = src.indexOf('gc-gutter__meta');
  assert.ok(metaAt > src.indexOf('gc-gutter__name'), 'the meta line follows the name');
  const meta = src.slice(metaAt, metaAt + 400);
  assert.match(meta, /laneCommits\(/, 'the count is on the meta line');
  assert.match(meta, /statusWord\(row\)/, 'and the status word shares it');
  assert.match(meta, /·/, 'the frame separates the two facts with a middle dot');
});

test('the column is decorative for assistive tech: the rows repeat the graph', () => {
  // Every fact in the column is already in the grid rows (`rowLabel`), so exposing
  // it twice would make a screen reader walk each branch before reaching a commit.
  const src = read('src/webview/LaneGutterView.tsx');
  assert.match(src, /aria-hidden="true"/);
  assert.doesNotMatch(src, /role="grid"|role="listbox"/);
});

test('the gutter styles use tokens only and the frame width', () => {
  const css = read('src/webview/styles.css');
  const gutter = css.match(/\.gc-gutter\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(gutter, /position:\s*absolute|position:\s*relative/, 'it is positioned against the stage');
  assert.match(css, /\.gc-gutter__head\s*\{/);
  assert.match(css, /\.gc-gutter__row\s*\{/);
  const literals = css.match(/\.gc-gutter[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.deepEqual(literals, [], 'no literal colour in the gutter rules');
});

test('every other lane band is tinted, so the rows read as separate lanes', () => {
  // A zebra: the eye needs a band edge to follow from a lane's label across to its
  // nodes, and one flat background gives it nothing to follow. Odd lanes take the
  // tint, even lanes stay on the column surface.
  const src = read('src/webview/LaneGutterView.tsx');
  assert.match(src, /gc-gutter__row--alt/, 'odd lanes carry the alternate class');
  assert.match(src, /index % 2 === 1|% 2 === 1/, 'the alternation is by lane index');

  const css = read('src/webview/styles.css');
  const alt = css.match(/\.gc-gutter__row--alt\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(alt.length > 0, 'the alternate band has a rule');
  assert.match(alt, /background:/, 'it is a fill');
  assert.match(alt, /var\(--gc-/, 'from a token, never a literal');
  assert.doesNotMatch(alt, /#[0-9a-fA-F]{3,8}/, 'no literal colour');
});
