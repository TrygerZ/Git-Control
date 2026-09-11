import test from 'node:test';
import assert from 'node:assert/strict';
import { chipsFor, matchesSearch, lanesForFilter } from '../src/webview/graphQuery';
import type { GraphNode, RepoGraph } from '../src/messages';

test('chipsFor maps and sorts ref names into ordered chips', () => {
  // Empty or ignored refs
  assert.deepEqual(chipsFor([], 'main'), []);
  assert.deepEqual(chipsFor(['', '  ', 'HEAD'], 'main'), []);

  // Tag, remote, local, and current branch ordering
  const refs = [
    'tag: v2.0.0',
    'origin/feature',
    'refs/remotes/upstream/bugfix',
    'refs/heads/main',
    'develop',
  ];
  const chips = chipsFor(refs, 'main');

  // Sorted order: current -> local -> remote -> tag
  assert.equal(chips.length, 5);
  assert.deepEqual(chips[0], {
    kind: 'current',
    icon: 'git-branch',
    prefix: '',
    name: 'main',
  });
  assert.deepEqual(chips[1], {
    kind: 'local',
    icon: 'circle-filled',
    prefix: '',
    name: 'develop',
  });
  assert.deepEqual(chips[2], {
    kind: 'remote',
    icon: 'cloud',
    prefix: 'remote ',
    name: 'origin/feature',
  });
  assert.deepEqual(chips[3], {
    kind: 'remote',
    icon: 'cloud',
    prefix: 'remote ',
    name: 'upstream/bugfix',
  });
  assert.deepEqual(chips[4], {
    kind: 'tag',
    icon: 'tag',
    prefix: 'tag ',
    name: 'v2.0.0',
  });
});

test('chipsFor handles null currentBranch and sanitizes ref names', () => {
  const chips = chipsFor(['refs/heads/main', 'tag: release\x00alpha'], null);
  assert.equal(chips[0]?.kind, 'local');
  assert.equal(chips[0]?.name, 'main');
  assert.equal(chips[1]?.kind, 'tag');
  assert.equal(chips[1]?.name, 'release\uFFFDalpha');
});

test('matchesSearch matches node against needle on hash, subject, and author', () => {
  const node: GraphNode = {
    hash: 'a1b2c3d4e5f6',
    shortHash: 'a1b2c3d',
    x: 100,
    y: 84,
    lane: 0,
    isHead: true,
    isMerge: false,
    local: true,
    subject: 'feat(core): implement turbo engine',
    authorName: 'Alice Dev',
    authoredAt: '2023-01-01',
    refNames: [],
  };

  // Empty needle matches everything
  assert.equal(matchesSearch(node, ''), true);

  // Substring and case-insensitive matching
  assert.equal(matchesSearch(node, 'A1B2'), true);
  assert.equal(matchesSearch(node, 'c3d4e5'), true);
  assert.equal(matchesSearch(node, 'turbo'), true);
  assert.equal(matchesSearch(node, 'TURBO ENGINE'), true);
  assert.equal(matchesSearch(node, 'alice'), true);
  assert.equal(matchesSearch(node, 'ALICE DEV'), true);

  // Non-matching query
  assert.equal(matchesSearch(node, 'bob'), false);
  assert.equal(matchesSearch(node, 'fix:'), false);
  assert.equal(matchesSearch(node, '999999'), false);
});

test('lanesForFilter matches lane refs and handles empty inputs', () => {
  const emptyGraph: RepoGraph = {
    nodes: [],
    edges: [],
    lanes: [],
    dateBuckets: [],
    refs: [],
    head: null,
    truncated: false,
    nextCursor: null,
    stale: false,
  };
  assert.equal(lanesForFilter(emptyGraph, 'main'), null);
  assert.equal(lanesForFilter(emptyGraph, ''), null);
  assert.equal(lanesForFilter(emptyGraph, '   '), null);

  const graph: RepoGraph = {
    nodes: [],
    edges: [],
    lanes: [
      { index: 0, color: '#ff0000', ref: 'main' },
      { index: 1, color: '#00ff00', ref: 'feature/login' },
      { index: 2, color: '#0000ff', ref: 'feature/payment' },
      { index: 3, color: '#ffff00' }, // ref undefined (e.g. anonymous/stash)
    ],
    dateBuckets: [],
    refs: [],
    head: 'a1b2c3d',
    truncated: false,
    nextCursor: null,
    stale: false,
  };

  // Match single lane
  assert.deepEqual(lanesForFilter(graph, 'main'), new Set([0]));

  // Match multiple lanes with case-insensitivity
  assert.deepEqual(lanesForFilter(graph, 'FEATURE'), new Set([1, 2]));

  // Undefined ref is safely excluded and non-match returns null
  assert.deepEqual(lanesForFilter(graph, 'stash'), null);
  assert.deepEqual(lanesForFilter(graph, 'unknown-branch'), null);
});
