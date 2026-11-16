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
import {
  gutterRowHeight,
  laneRowTop,
  laneSummaries,
  mergedLanes,
  mergedNameAt,
  type LaneSummary,
} from '../src/webview/laneGutter';
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
  // x grows with time, so the largest x is the newest commit: that is the tip.
  const nodes = [
    node(A, 0, { x: 400 }),
    node(C, 0, { x: 300 }),
    node(B, 1, { x: 200 }),
    node(D, 2, { x: 100 }),
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

test('the tip of a lane is its newest commit, not its oldest', () => {
  // x grows with time in the layout (oldest first), so a lane's tip is the node
  // with the LARGEST x. Picking the smallest makes the root commit look like the
  // tip, which inverts every merged decision: `main` reported itself as merged and
  // a fully merged lane reported `remote only`. Reproduced on a real repository.
  const lanes: GraphLane[] = [
    { index: 0, ref: 'refs/heads/main', color: '#111111' },
    { index: 1, ref: 'refs/heads/topic', color: '#222222' },
  ];
  // main: root R (x=100) ... tip M (x=500). topic ends at T (x=300), which main's
  // tip M has as a parent, so topic is contained in main. Main is reached by nobody.
  //
  // The shape matters: M -> T -> R, not M -> R and T -> R. The second shape is a
  // plain fork that the earlier test already pins as unmerged, and it cannot
  // separate the bug from the fix. This one does: picking the smallest x makes
  // lane 0's "tip" the root R, and then T's walk reaches R, so lane 0 falsely
  // reports merged while lane 1 reports unmerged. Exactly the inversion seen on
  // the real repository.
  const R = 'r'.repeat(40);
  const M = 'm'.repeat(40);
  const T = 't'.repeat(40);
  const nodes = [node(R, 0, { x: 100 }), node(M, 0, { x: 500 }), node(T, 1, { x: 300 })];
  const edges = [edge(M, T, 0, 1), edge(T, R, 1, 0)];
  const summaries = laneSummaries(
    lanes,
    nodes,
    edges,
    [ref('main', 'local', 'origin/main'), ref('topic', 'local')],
    fallback,
  );
  assert.equal(summaries[0]?.status, 'upstream', 'main is not merged into anything');
  assert.equal(summaries[1]?.status, 'merged', 'topic is contained in main');
});

test('a lane lists every ref that points into it, not just the winner', () => {
  // The row used to print one name per lane, so on a repository with 41 branches
  // sharing a lane, 40 names vanished. The row now carries the whole list.
  const lanes: GraphLane[] = [{ index: 0, ref: 'refs/heads/main', color: '#111111' }];
  const nodes = [node(A, 0, { x: 100 })];
  const refs = [
    ref('main', 'local', 'origin/main'),
    ref('feat/a', 'local'),
    ref('feat/b', 'local'),
    ref('origin/feat/c', 'remote'),
  ];
  const summaries = laneSummaries(lanes, nodes, [], refs, fallback);
  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0]?.names, ['main', 'feat/a', 'feat/b', 'origin/feat/c']);
  // The first name stays the lane's headline so the frame's layout is unchanged.
  assert.equal(summaries[0]?.name, 'main');
});

test('the headline is the lane ref the layout picked, not whichever ref arrives first', () => {
  // `lane.ref` is the highest-priority ref the layout chose for that lane (current
  // branch, then remote, then local, then tag). The `refs` array arrives in git's
  // `for-each-ref` order, which is alphabetical, so taking `names[0]` from it makes
  // the headline an arbitrary branch. On a real repository the `main` row was
  // headlined `ci/fix-gate-failures`.
  const lanes: GraphLane[] = [{ index: 0, ref: 'refs/heads/main', color: '#111111' }];
  const nodes = [node(A, 0, { x: 100 })];
  // Alphabetical order, so the current branch is NOT first.
  const refs = [
    ref('ci/build', 'local'),
    ref('feat/a', 'local'),
    ref('main', 'local', 'origin/main'),
  ];
  const summaries = laneSummaries(lanes, nodes, [], refs, fallback);
  assert.equal(summaries[0]?.name, 'main', 'the layout ref is the headline');
  assert.deepEqual(summaries[0]?.names, ['main', 'ci/build', 'feat/a'], 'and it leads the list');
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
  // implementation did. The expected values are derived from the pitch rather than
  // hardcoded, so this test survives a pitch change.
  //
  // `laneY(0)` is already `RULER_HEIGHT + pitch / 2`, and `laneRowTop` adds
  // `RULER_HEIGHT` again because the gutter's origin is the top of its own ruler
  // band, so the band is counted twice in screen space. That is correct: the node
  // centre is `RULER_HEIGHT + laneY(0) * zoom` on screen.
  const pitch = LANE_HEIGHT;
  const lane0Centre = RULER_HEIGHT + pitch / 2;
  assert.equal(laneRowTop(laneY(0, pitch, RULER_HEIGHT), 1, 0, 33), RULER_HEIGHT + lane0Centre - 16.5);
  assert.equal(laneRowTop(laneY(0, pitch, RULER_HEIGHT), 2, 0, 33), RULER_HEIGHT + lane0Centre * 2 - 16.5);
  assert.equal(laneRowTop(laneY(0, pitch, RULER_HEIGHT), 1, 40, 33), RULER_HEIGHT + lane0Centre - 16.5 - 40);
});

test('the lane pitch matches the frame, which spaces lane dots 150 px apart', () => {
  // Measured on the frame 01 render at 1440x900: the four gutter dots sit at
  // y 233, 383, 533 and 683, so the pitch is exactly 150 px. The previous 88 px
  // left a 62 px gap short of the design and read as cramped.
  assert.equal(LANE_HEIGHT, 150);
  const frameDotCentres = [233, 383, 533, 683];
  for (let i = 1; i < frameDotCentres.length; i += 1) {
    assert.equal(frameDotCentres[i]! - frameDotCentres[i - 1]!, LANE_HEIGHT, 'frame pitch');
  }
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
  assert.equal(gutterRowHeight(1), LANE_HEIGHT, '100 % is one lane pitch');
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

test('a row shows the headline name plus how many others share the lane', () => {
  // 41 branches can land in one lane. Printing all of them would be a wall of
  // text, printing one hides 40. The row prints the headline and a `+N` count, and
  // the full list rides in the tooltip.
  const src = read('src/webview/LaneGutterView.tsx');
  assert.match(src, /row\.names/, 'the row reads the full list');
  assert.match(src, /names\.slice\(1\)|names\.length - 1/, 'it counts the others');
  assert.match(src, /laneMoreOthers|laneOthers/, 'the count is a catalog string, not a literal');
  // The gap is the CSS `gap` on the flex container, not a space in the string, so
  // the count has to be a flex child that the container actually spaces.
  const css = read('src/webview/styles.css');
  const nameRule = css.match(/\.gc-gutter__name\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(nameRule, /display:\s*flex/, 'the name is a flex row so the count is spaced');
  // 2 px reads as one word next to an ellipsized branch name. The count needs a
  // visible break from the name it does not belong to.
  assert.match(nameRule, /gap:\s*var\(--gc-space-2\)/, 'and the gap is one visible step');
  // The tooltip carries every name, so nothing is lost. A newline never renders in
  // a native tooltip, so the separator has to be a visible character.
  assert.match(src, /names\.join\(' · '\)|names\.join\(" · "\)|names\.join\('\\u00b7'\)/, 'the tooltip lists them all on one readable line');
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    assert.ok(catalog.includes('    laneMoreOthers:'), `${lang} catalog is missing laneMoreOthers`);
  }
});

test('the headline keeps a usable width, so the count does not eat the name', () => {
  // In a 150 px column the label was shrinking to `fix/fronten...` while `+14 more`
  // kept its full width. The name is the identity; the count is the hint. The name
  // gets a floor and the count yields its space before the name does.
  const css = read('src/webview/styles.css');
  const label = css.match(/\.gc-gutter__label\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(label.length > 0, 'the label has a rule');
  assert.match(label, /flex:\s*1 1 auto|flex-grow:\s*1/, 'the label takes the free space');
  const more = css.match(/\.gc-gutter__more\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(more.length > 0, 'the count has a rule');
  assert.match(more, /flex:\s*0 0 auto|flex:\s*none/, 'the count never grows');
  // The count may shrink to nothing before the name is squeezed out.
  assert.match(more, /min-width:\s*0/, 'the count can shrink');
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

test('the gutter is one flat column: the lane band is painted on the canvas', () => {
  // Frame 01 paints the gutter `#181818` from the ruler down, and puts the only
  // zebra on the canvas side of the seam (`LaneBand/main` `10:2`). A tinted gutter
  // row duplicated that fill on the wrong side, which reads as a misalignment even
  // when the two zebras tile. `test/canvasFrame01.test.ts` owns the canvas band.
  const src = read('src/webview/LaneGutterView.tsx');
  assert.doesNotMatch(src, /gc-gutter__row--alt/, 'no alternate row class');
  assert.doesNotMatch(src, /% 2 === 1/, 'and no alternation in the row');

  const css = read('src/webview/styles.css');
  assert.doesNotMatch(css, /\.gc-gutter__row--alt/, 'no alternate row rule survives');
  const row = css.match(/\.gc-gutter__row\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(row.length > 0, 'the row has a rule');
  assert.doesNotMatch(row, /background:/, 'the row paints nothing of its own');
});

// ------------------------------------------------- merged lane follows scroll

/**
 * Frame 01's merged row does not list one name. The branches merged into `main`
 * sit along the timeline in the order they landed, and the row names the branch
 * whose merge boundary the viewport is currently past. `mergedNameAt` is that
 * answer, kept pure so the scroll behaviour is testable without a DOM.
 */
function summary(names: string[], status: LaneSummary['status'] = 'merged'): LaneSummary {
  return { index: 2, color: '#123456', name: names[0] ?? '', names, commits: 9, status, detail: null };
}

test('the merged row names the branch whose merge the viewport is looking at', () => {
  // Three branches merged in this order, each with a merge commit at x.
  //   feat/a at x 300, docs/b at x 600, fix/c at x 900
  //
  // The rule is "the next merge at or after the left edge": the row tells you
  // which branch is coming, and advances the moment the previous one is fully
  // behind you. The user's words: show the NEXT merged branch.
  const row = summary(['feat/a', 'docs/b', 'fix/c']);
  const boundaries = [
    { name: 'feat/a', x: 300 },
    { name: 'docs/b', x: 600 },
    { name: 'fix/c', x: 900 },
  ];

  assert.equal(mergedNameAt(row, boundaries, 0), 'feat/a', 'at the far left, the first merge is ahead');
  assert.equal(mergedNameAt(row, boundaries, 299), 'feat/a', 'still approaching feat/a');
  assert.equal(mergedNameAt(row, boundaries, 300), 'feat/a', 'at the merge itself, still feat/a');
  assert.equal(mergedNameAt(row, boundaries, 301), 'docs/b', 'past feat/a, docs/b is the next one');
  assert.equal(mergedNameAt(row, boundaries, 599), 'docs/b');
  assert.equal(mergedNameAt(row, boundaries, 600), 'docs/b', 'at docs/b, still docs/b');
  assert.equal(mergedNameAt(row, boundaries, 601), 'fix/c');
  assert.equal(mergedNameAt(row, boundaries, 900), 'fix/c', 'the last merge holds while it is on screen');
  assert.equal(mergedNameAt(row, boundaries, 99999), 'fix/c', 'past the last merge, the last name holds');
});

test('a gap between merges keeps the next branch named, never a blank row', () => {
  // The real repository has 41 refs but only 14 merge commits, so there are long
  // stretches with no boundary. The row keeps naming the branch that is coming,
  // which is the whole point: it tells you what is ahead, not what is behind.
  const row = summary(['feat/a', 'docs/b']);
  const boundaries = [
    { name: 'feat/a', x: 100 },
    { name: 'docs/b', x: 9000 },
  ];
  assert.equal(mergedNameAt(row, boundaries, 50), 'feat/a', 'before the first merge');
  assert.equal(mergedNameAt(row, boundaries, 100), 'feat/a', 'at the first merge');
  assert.equal(mergedNameAt(row, boundaries, 2000), 'docs/b', 'past feat/a, docs/b is next across the gap');
  assert.equal(mergedNameAt(row, boundaries, 4500), 'docs/b');
  assert.equal(mergedNameAt(row, boundaries, 8999), 'docs/b', 'still approaching docs/b');
  assert.equal(mergedNameAt(row, boundaries, 9000), 'docs/b', 'at docs/b');
});

test('a name that is not in the row is skipped, not rendered', () => {
  // A merge can bring in a commit whose ref is no longer in the row, for example a
  // deleted branch or a ref outside the page. Naming it would print a branch the
  // row does not hold, so the search continues to the next boundary that does.
  const row = summary(['feat/a', 'fix/c']);
  const boundaries = [
    { name: 'feat/a', x: 100 },
    { name: 'deleted/branch', x: 200 },
    { name: 'fix/c', x: 300 },
  ];
  assert.equal(mergedNameAt(row, boundaries, 150), 'fix/c', 'the deleted branch is skipped entirely');
  assert.equal(mergedNameAt(row, boundaries, 300), 'fix/c');
});

test('a row with no boundaries falls back to its headline', () => {
  const row = summary(['feat/a', 'docs/b']);
  assert.equal(mergedNameAt(row, [], 0), 'feat/a');
  assert.equal(mergedNameAt(row, [], 5000), 'feat/a');
});

test('only the merged row follows the scroll; every other row keeps its headline', () => {
  const src = read('src/webview/LaneGutterView.tsx');
  // The rule is scoped by status, so an upstream or tag row cannot start changing
  // name as the user pans.
  assert.match(src, /status === 'merged'/, 'the behaviour is gated on the merged status');
  assert.match(src, /mergedNameAt\(/, 'and reads the pure helper');
});

test('the view derives the scroll position from the scroller, not from a guess', () => {
  const src = read('src/webview/LaneGutterView.tsx');
  // `scrollLeft` is what decides which merge is ahead of the viewport.
  assert.match(src, /scrollLeft/, 'the row reads the horizontal offset');
  assert.match(src, /zoom/, 'and scales it into world units');
});
