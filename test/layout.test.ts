import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMN_WIDTH,
  DAY_GAP,
  GUTTER_X,
  LANE_HEIGHT,
  layoutGraph,
  type LayoutInput,
  type LayoutNode,
} from '../src/layout';
import { computeStaggerMap } from '../src/webview/GraphCanvas';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

const linear: LayoutInput = {
  commits: [
    { hash: A, parents: [B] },
    { hash: B, parents: [C] },
    { hash: C, parents: [] },
  ],
  refs: [{ refName: 'refs/heads/main', objectName: A }],
  head: A,
  currentBranch: 'main',
};

/** M merges feature C back into main; both sides fork from D. */
const forked: LayoutInput = {
  commits: [
    { hash: A, parents: [B, C] },
    { hash: B, parents: [D] },
    { hash: C, parents: [D] },
    { hash: D, parents: [] },
  ],
  refs: [
    { refName: 'refs/heads/main', objectName: A },
    { refName: 'refs/heads/feature', objectName: C },
    { refName: 'refs/remotes/origin/main', objectName: B },
  ],
  head: A,
  currentBranch: 'main',
};

test('linear chain occupies a single lane in chronological order', () => {
  const result = layoutGraph(linear, { laneHeight: 50, columnWidth: 100, gutterX: 0, dayGap: 20 });
  // C is oldest (x=0, index=0), B is next (x=100, index=1), A is newest (x=200, index=2)
  assert.deepEqual(
    result.nodes.map((n) => [n.hash, n.lane, n.x, n.y, n.index]),
    [
      [C, 0, 0, 0, 0],
      [B, 0, 100, 0, 1],
      [A, 0, 200, 0, 2],
    ],
  );
  assert.equal(result.lanes.length, 1);
  assert.equal(result.lanes[0]?.ref, 'refs/heads/main');
  assert.deepEqual(
    result.edges.map((e) => [e.from, e.to, e.kind]),
    [
      [A, B, 'direct'],
      [B, C, 'direct'],
    ],
  );
});

test('default column width, lane height, gutter apply when not supplied', () => {
  const result = layoutGraph(linear);
  assert.equal(result.nodes[0]?.x, GUTTER_X);
  assert.equal(result.nodes[1]?.x, GUTTER_X + COLUMN_WIDTH);
  assert.equal(result.nodes[0]?.y, 0);
});

test('fork/merge topology assigns first-parent continuity and reuses lanes', () => {
  const result = layoutGraph(forked, { laneHeight: 50, columnWidth: 100, gutterX: 0 });

  // Chronological order: D (0), C (1), B (2), A (3)
  const laneMap = new Map(result.nodes.map((n) => [n.hash, n.lane]));
  assert.equal(laneMap.get(A), 0);
  assert.equal(laneMap.get(B), 0);
  assert.equal(laneMap.get(C), 1);
  assert.equal(laneMap.get(D), 0);

  const merge = result.nodes.find((n) => n.hash === A);
  assert.ok(merge);
  assert.equal(merge.isMerge, true);

  const nonMerge = result.nodes.find((n) => n.hash === B);
  assert.equal(nonMerge?.isMerge, false);

  assert.deepEqual(
    result.edges.map((e) => [e.from, e.to, e.fromLane, e.toLane, e.kind]),
    [
      [A, B, 0, 0, 'direct'],
      [A, C, 0, 1, 'merge'],
      [B, D, 0, 0, 'direct'],
      [C, D, 1, 0, 'direct'],
    ],
  );

  assert.equal(result.lanes.length, 2);
  assert.equal(result.lanes[0]?.ref, 'refs/heads/main');
  assert.equal(result.lanes[1]?.ref, 'refs/heads/feature');
  assert.notEqual(result.lanes[0]?.color, result.lanes[1]?.color);
});

test('local marks commits unreachable from remote-tracking refs', () => {
  const result = layoutGraph(forked);
  const localFlags = new Map(result.nodes.map((n) => [n.hash, n.local]));
  assert.equal(localFlags.get(A), true, 'merge commit not yet pushed');
  assert.equal(localFlags.get(C), true, 'feature branch not yet pushed');
  assert.equal(localFlags.get(B), false, 'origin/main tip');
  assert.equal(localFlags.get(D), false, 'ancestor of origin/main');
});

test('every commit is local when there are no remote refs', () => {
  const result = layoutGraph(linear);
  assert.ok(result.nodes.every((n) => n.local));
});

test('HEAD marker is set on exactly the HEAD commit', () => {
  const result = layoutGraph(forked);
  assert.deepEqual(
    result.nodes.filter((n) => n.isHead).map((n) => n.hash),
    [A],
  );
});

test('detached HEAD still seeds a lane', () => {
  const result = layoutGraph({
    commits: [
      { hash: B, parents: [C] },
      { hash: C, parents: [] },
    ],
    refs: [],
    head: B,
    currentBranch: null,
  });
  const nodeB = result.nodes.find((n) => n.hash === B);
  assert.equal(nodeB?.lane, 0);
  assert.equal(nodeB?.isHead, true);
  assert.equal(result.lanes[0]?.ref, undefined);
});

test('layout is deterministic across repeated runs', () => {
  const first = layoutGraph(forked, { laneHeight: 50, columnWidth: 100 });
  const second = layoutGraph(forked, { laneHeight: 50, columnWidth: 100 });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('layout is independent of ref input ordering', () => {
  const reversed: LayoutInput = { ...forked, refs: [...forked.refs].reverse() };
  assert.deepEqual(layoutGraph(forked), layoutGraph(reversed));
});

test('empty repository yields an empty layout', () => {
  const result = layoutGraph({ commits: [], refs: [], head: null });
  assert.deepEqual(result, { nodes: [], edges: [], lanes: [], dateBuckets: [] });
});

test('parents outside the loaded window produce no dangling edges', () => {
  const result = layoutGraph({
    commits: [{ hash: A, parents: [B] }],
    refs: [{ refName: 'refs/heads/main', objectName: A }],
    head: A,
    currentBranch: 'main',
  });
  assert.equal(result.edges.length, 0);
  assert.equal(result.nodes.length, 1);
});

test('date bucket grouping, DAY_GAP spacing, and ruler metadata', () => {
  const day1 = '2026-08-01T10:00:00Z';
  const day1_b = '2026-08-01T14:00:00Z';
  const day2 = '2026-08-02T09:00:00Z';

  const multiDay: LayoutInput = {
    commits: [
      { hash: A, parents: [B], committedAt: day2 },
      { hash: B, parents: [C], committedAt: day1_b },
      { hash: C, parents: [], committedAt: day1 },
    ],
    refs: [{ refName: 'refs/heads/main', objectName: A }],
    head: A,
    currentBranch: 'main',
  };

  const gutter = 30;
  const colW = 80;
  const gap = 40;
  const result = layoutGraph(multiDay, { gutterX: gutter, columnWidth: colW, dayGap: gap });

  // 2 buckets: Day 1 has C and B, Day 2 has A
  assert.equal(result.dateBuckets.length, 2);

  const bucket1 = result.dateBuckets[0]!;
  assert.equal(bucket1.commitCount, 2);
  assert.equal(bucket1.startX, gutter);
  assert.equal(bucket1.width, 2 * colW);

  const bucket2 = result.dateBuckets[1]!;
  assert.equal(bucket2.commitCount, 1);
  assert.equal(bucket2.startX, gutter + 2 * colW + gap);
  assert.equal(bucket2.width, 1 * colW);

  // Nodes: C at gutter, B at gutter + colW, A at gutter + 2*colW + gap
  const nodeC = result.nodes.find((n) => n.hash === C)!;
  const nodeB = result.nodes.find((n) => n.hash === B)!;
  const nodeA = result.nodes.find((n) => n.hash === A)!;

  assert.equal(nodeC.x, gutter);
  assert.equal(nodeB.x, gutter + colW);
  assert.equal(nodeA.x, gutter + 2 * colW + gap);
  assert.equal(nodeC.index, 0);
  assert.equal(nodeB.index, 1);
  assert.equal(nodeA.index, 2);

  // Assert startX of each dateBucket strictly equals the x of the first node in that bucket
  assert.equal(bucket1.startX, nodeC.x);
  assert.equal(bucket2.startX, nodeA.x);
});

test('pagination consistency: expanded window layout preserves coordinates and respects DAY_GAP without overlap', () => {
  const day1 = '2026-08-01T10:00:00Z';
  const day2 = '2026-08-02T10:00:00Z';

  // Page 1: only commit A (newest, day2)
  const page1Input: LayoutInput = {
    commits: [{ hash: A, parents: [B], committedAt: day2 }],
    refs: [{ refName: 'refs/heads/main', objectName: A }],
    head: A,
    currentBranch: 'main',
  };

  // Page 2 expanded window: commits A (day2) and B (day1)
  const expandedInput: LayoutInput = {
    commits: [
      { hash: A, parents: [B], committedAt: day2 },
      { hash: B, parents: [], committedAt: day1 },
    ],
    refs: [{ refName: 'refs/heads/main', objectName: A }],
    head: A,
    currentBranch: 'main',
  };

  const options = { gutterX: GUTTER_X, columnWidth: COLUMN_WIDTH, dayGap: DAY_GAP };
  const expanded = layoutGraph(expandedInput, options);

  assert.equal(expanded.nodes.length, 2);
  assert.equal(expanded.dateBuckets.length, 2);

  const nodeB = expanded.nodes.find((n) => n.hash === B)!; // oldest: day 1
  const nodeA = expanded.nodes.find((n) => n.hash === A)!; // newest: day 2

  // Oldest commit B sits at GUTTER_X
  assert.equal(nodeB.x, GUTTER_X);
  assert.equal(expanded.dateBuckets[0]!.startX, nodeB.x);

  // Day 2 commit A sits after bucket1 width (COLUMN_WIDTH) + DAY_GAP
  const expectedDay2X = GUTTER_X + COLUMN_WIDTH + DAY_GAP;
  assert.equal(nodeA.x, expectedDay2X);
  assert.equal(expanded.dateBuckets[1]!.startX, nodeA.x);

  // Nodes do not overlap and have at least COLUMN_WIDTH spacing
  assert.ok(nodeA.x >= nodeB.x + COLUMN_WIDTH + DAY_GAP);
});

test('boundary test: single commit per day, multiple commits per day, multi-day gap, and invalid/empty timestamp', () => {
  const day1 = '2026-08-01T10:00:00Z';
  const day1_second = '2026-08-01T15:30:00Z';
  const day5 = '2026-08-05T10:00:00Z'; // 4-day gap

  const boundaryInput: LayoutInput = {
    commits: [
      { hash: A, parents: [B], committedAt: 'invalid-date' }, // invalid timestamp
      { hash: B, parents: [C], committedAt: day5 },           // single commit in day 5
      { hash: C, parents: [D], committedAt: day1_second },    // multiple commits in day 1 (second)
      { hash: D, parents: [], committedAt: day1 },            // multiple commits in day 1 (first)
    ],
    refs: [{ refName: 'refs/heads/main', objectName: A }],
    head: A,
    currentBranch: 'main',
  };

  const options = { gutterX: GUTTER_X, columnWidth: COLUMN_WIDTH, dayGap: DAY_GAP };
  const res = layoutGraph(boundaryInput, options);

  assert.equal(res.nodes.length, 4);
  assert.equal(res.dateBuckets.length, 3); // unknown-date, day 1, day 5

  const bucketUnknown = res.dateBuckets.find((b) => b.label === 'Tanggal tidak diketahui')!;
  assert.ok(bucketUnknown, 'bucket for invalid timestamp exists with proper label');
  assert.equal(bucketUnknown.commitCount, 1);
  assert.equal(bucketUnknown.startX, GUTTER_X);
  assert.equal(bucketUnknown.width, COLUMN_WIDTH);

  const nodeA = res.nodes.find((n) => n.hash === A)!;
  assert.equal(nodeA.x, bucketUnknown.startX);

  const bucketDay1 = res.dateBuckets[1]!;
  assert.equal(bucketDay1.commitCount, 2);
  assert.equal(bucketDay1.startX, GUTTER_X + COLUMN_WIDTH + DAY_GAP);
  assert.equal(bucketDay1.width, 2 * COLUMN_WIDTH);

  const nodeD = res.nodes.find((n) => n.hash === D)!;
  const nodeC = res.nodes.find((n) => n.hash === C)!;
  assert.equal(nodeD.x, bucketDay1.startX);
  assert.equal(nodeC.x, bucketDay1.startX + COLUMN_WIDTH);

  const bucketDay5 = res.dateBuckets[2]!;
  assert.equal(bucketDay5.commitCount, 1);
  assert.equal(bucketDay5.startX, bucketDay1.startX + bucketDay1.width + DAY_GAP);
  assert.equal(bucketDay5.width, COLUMN_WIDTH);

  const nodeB = res.nodes.find((n) => n.hash === B)!;
  assert.equal(nodeB.x, bucketDay5.startX);
});

test('layoutGraph and formatDateLabel agree on invalid dates (undefined, empty string, invalid-date, 0, negative, Infinity, NaN)', () => {
  const invalidValues = [undefined, '', 'invalid-date', 0, -1000, Infinity, -Infinity, NaN];
  for (const inv of invalidValues) {
    const layout = layoutGraph({
      commits: [{ hash: '1111111', parents: [], committedAt: inv as unknown as string }],
      refs: [{ refName: 'refs/heads/main', objectName: '1111111' }],
      head: '1111111',
      currentBranch: 'main',
    });
    assert.equal(layout.dateBuckets[0]!.label, 'Tanggal tidak diketahui');
    assert.equal(layout.dateBuckets[0]!.timestamp, 0);
  }
});

test('computeStaggerMap assigns alternating placement to same-lane x-neighbours', () => {
  const node = (hash: string, x: number, lane: number) => ({
    hash,
    shortHash: hash.slice(0, 7),
    x,
    y: lane * 88,
    lane,
    index: 0,
    isHead: false,
    isMerge: false,
    local: false,
    subject: 'test',
    authorName: 'Author',
    authorEmail: 'a@example.com',
    authoredAt: '2026-08-31T00:00:00Z',
    committedAt: '2026-08-31T00:00:00Z',
    parents: [],
    refNames: [],
  });

  const testNodes = [
    node('c1', 0, 0),
    node('c2', 96, 0),
    node('c3', 192, 0),
    node('c4', 0, 1),
    node('c5', 96, 1),
  ];

  const map = computeStaggerMap(testNodes);

  // Lane 0: c1 (below), c2 (above), c3 (below)
  assert.equal(map.get('c1'), 'below');
  assert.equal(map.get('c2'), 'above');
  assert.equal(map.get('c3'), 'below');

  // Lane 1: c4 (below), c5 (above)
  assert.equal(map.get('c4'), 'below');
  assert.equal(map.get('c5'), 'above');
});
