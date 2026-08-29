import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, type LayoutInput } from '../src/layout';

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

test('linear chain occupies a single lane', () => {
  const result = layoutGraph(linear, { rowHeight: 20, laneWidth: 10 });
  assert.deepEqual(
    result.nodes.map((n) => [n.hash, n.lane, n.x, n.y]),
    [
      [A, 0, 0, 0],
      [B, 0, 0, 20],
      [C, 0, 0, 40],
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

test('default row height and lane width apply when not supplied', () => {
  const result = layoutGraph(linear);
  assert.equal(result.nodes[1]?.y, 24);
  assert.equal(result.nodes[0]?.x, 0);
});

test('fork/merge topology assigns first-parent continuity and reuses lanes', () => {
  const result = layoutGraph(forked, { rowHeight: 20, laneWidth: 10 });

  assert.deepEqual(
    result.nodes.map((n) => [n.hash, n.lane]),
    [
      [A, 0],
      [B, 0],
      [C, 1],
      [D, 0],
    ],
  );

  const merge = result.nodes[0];
  assert.ok(merge);
  assert.equal(merge.isMerge, true);
  assert.equal(result.nodes[1]?.isMerge, false);

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
  assert.equal(result.nodes[0]?.lane, 0);
  assert.equal(result.nodes[0]?.isHead, true);
  assert.equal(result.lanes[0]?.ref, undefined);
});

test('layout is deterministic across repeated runs', () => {
  const first = layoutGraph(forked, { rowHeight: 20, laneWidth: 10 });
  const second = layoutGraph(forked, { rowHeight: 20, laneWidth: 10 });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('layout is independent of ref input ordering', () => {
  const reversed: LayoutInput = { ...forked, refs: [...forked.refs].reverse() };
  assert.deepEqual(layoutGraph(forked), layoutGraph(reversed));
});

test('empty repository yields an empty layout', () => {
  const result = layoutGraph({ commits: [], refs: [], head: null });
  assert.deepEqual(result, { nodes: [], edges: [], lanes: [] });
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
