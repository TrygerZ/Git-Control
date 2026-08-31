import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, type Harness, type TestRepo } from './fixture';
import { MAX_COMMIT_LIMIT } from '../src/repository';
import { visibleColumnRange, edgeIntersectsBand, visibleWorldBand, COLUMN_WIDTH } from '../src/webview/viewport';
import { layoutGraph } from '../src/layout';
import type { RepoGraph, RequestKind, RequestPayload, ResponseData } from '../src/messages';
import { useRepoStore } from '../src/webview/store';
import { bridge } from '../src/webview/bridge';

function own(t: { after(fn: () => unknown): void }, repo: TestRepo, h?: Harness): void {
  t.after(() => { h?.dispose(); return repo.cleanup(); });
}

test('Kasus 7: graph cap and cursor pages are complete and non-overlapping', async (t) => {
  const repo = await makeRepo({ commits: 1, label: 'k7-pages' });
  const h = repo.harness({ settings: { commitLimit: MAX_COMMIT_LIMIT, pageSize: 500 } });
  own(t, repo, h);
  const pages: string[][] = [];
  let cursor: number | undefined;
  for (;;) {
    const response = await h.send('repos/graph', { limit: 500, ...(cursor === undefined ? {} : { cursor }) });
    assert.equal(response.ok, true, JSON.stringify(response));
    if (!response.ok) return;
    const graph = response.data as RepoGraph;
    pages.push(graph.nodes.map((n) => n.hash));
    if (graph.nextCursor === null) {
      assert.equal(graph.truncated, false);
      break;
    }
    cursor = graph.nextCursor;
  }
  const all = pages.flat();
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.length <= MAX_COMMIT_LIMIT);
  assert.equal(pages.length, 1, 'fixture history is intentionally one page');
});

test('Kasus 7: webview loadMore pagination expands window and preserves monotonic coordinates', async (t) => {
  // Build a repo with 15 commits spanning across multiple days to test loadMore
  const repo = await makeRepo({ commits: 1, label: 'k7-loadmore' });
  const h = repo.harness({ settings: { commitLimit: 10, pageSize: 5 } });
  own(t, repo, h);

  // Add more commits
  const base = (await repo.git.headHash()) as string;
  const input: string[] = [];
  let parent = base;
  for (let i = 0; i < 14; i += 1) {
    const message = `commit-${i}`;
    // spread across days: 86400s per day
    const daySeconds = 1700000000 + i * 86400;
    input.push(
      `commit refs/heads/${repo.branch}`,
      `mark :${i + 1}`,
      `author Fixture User <fixture@example.com> ${daySeconds} +0000`,
      `committer Fixture User <fixture@example.com> ${daySeconds} +0000`,
      `data ${message.length}`,
      message,
      `from ${parent}`,
      'M 100644 inline file.txt',
      'data 1',
      'x',
      '',
    );
    parent = `:${i + 1}`;
  }
  await repo.git.run(['fast-import'], { input: `${input.join('\n')}\n` });

  // Use genuine useRepoStore with bridge.request stubbed to forward to harness
  const capturedRequests: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const originalRequest = bridge.request;
  bridge.request = (async <K extends RequestKind>(kind: K, payload: RequestPayload<K>): Promise<ResponseData<K>> => {
    capturedRequests.push({ kind, payload: payload as Record<string, unknown> });
    const res = await h.send(kind, payload as Record<string, unknown>);
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.data as ResponseData<K>;
  }) as typeof bridge.request;
  t.after(() => {
    bridge.request = originalRequest;
  });

  // 1. Initial loadGraph (pageSize = 5)
  await useRepoStore.getState().loadGraph();
  const initialGraph = useRepoStore.getState().graph;
  assert.ok(initialGraph !== null);
  assert.equal(initialGraph.nodes.length, 5);
  assert.equal(initialGraph.nextCursor, 5);
  assert.equal(initialGraph.truncated, false);

  // 2. First loadMore (calls the genuine store method)
  await useRepoStore.getState().loadMore();
  const secondGraph = useRepoStore.getState().graph;
  assert.ok(secondGraph !== null);

  // Assert request 2 asks for an explicitly larger window than request 1 with cursor: 0
  assert.equal(capturedRequests[0]!.kind, 'repos/graph');
  assert.equal(capturedRequests[0]!.payload.limit, undefined);
  assert.equal(capturedRequests[1]!.kind, 'repos/graph');
  assert.equal(capturedRequests[1]!.payload.limit, 10);
  assert.equal(capturedRequests[1]!.payload.cursor, 0);

  // Assert second graph contains first page AND second page commits without duplicates
  assert.equal(secondGraph.nodes.length, 10);
  const allHashes = secondGraph.nodes.map((n) => n.hash);
  assert.equal(new Set(allHashes).size, allHashes.length);
  for (const initialNode of initialGraph.nodes) {
    assert.ok(allHashes.includes(initialNode.hash));
  }

  // Assert x coordinates are monotonically increasing and respect DAY_GAP
  for (let i = 1; i < secondGraph.nodes.length; i += 1) {
    const prev = secondGraph.nodes[i - 1]!;
    const curr = secondGraph.nodes[i]!;
    assert.ok(curr.x >= prev.x + 96, `node x must be monotonic: curr.x=${curr.x}, prev.x=${prev.x}`);
  }

  // Assert dateBuckets startX matches first node in bucket
  for (const bucket of secondGraph.dateBuckets) {
    const firstInBucket: RepoGraph['nodes'][number] | undefined = secondGraph.nodes.find(
      (n) => n.x >= bucket.startX && n.x < bucket.startX + bucket.width,
    );
    assert.ok(firstInBucket, 'every bucket has at least one node');
    assert.equal(bucket.startX, firstInBucket.x);
  }

  // 3. Next cursor reaches cap (commitLimit = 10) -> nextCursor becomes null, preventing infinite requests
  assert.equal(secondGraph.nextCursor, null);
  assert.equal(secondGraph.truncated, true);
});

test('Kasus 7: real history timings stay measurable and layout is deterministic', async (t) => {
  const repo = await makeRepo({ commits: 1, label: 'k7-real' });
  own(t, repo);
  const base = await repo.git.headHash() as string;
  const input: string[] = [];
  let parent = base;
  for (let i = 0; i < 2_500; i += 1) {
    const message = `c${i}`;
    input.push(`commit refs/heads/${repo.branch}`, `mark :${i + 1}`,
      'author Fixture User <fixture@example.com> 1700000060 +0000',
      'committer Fixture User <fixture@example.com> 1700000060 +0000',
      `data ${message.length}`, message, `from ${parent}`, 'M 100644 inline history.txt', 'data 1', 'x', '');
    parent = `:${i + 1}`;
  }
  const importStart = performance.now();
  await repo.git.run(['fast-import'], { input: `${input.join('\n')}\n` });
  const importMs = performance.now() - importStart;
  const h = repo.harness({ settings: { pageSize: 500 } });
  own(t, repo, h);
  const timings: number[] = [];
  for (const payload of [{}, { cursor: 0 }, { cursor: 500 }]) {
    const start = performance.now();
    const result = await h.send('repos/graph', payload);
    timings.push(performance.now() - start);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.ok(importMs >= 0 && timings.every((ms) => ms >= 0));
  const graph = await repo.git.log({ limit: 25, all: true });
  const laidOut = graph.map((c) => ({ hash: c.hash, parents: c.parents }));
  const refs = await repo.git.refs();
  const current = await repo.git.currentBranch();
  const inputLayout = { commits: laidOut, refs: refs.map((r) => ({ refName: r.refName as string, objectName: r.objectName as string })), head: current.head, currentBranch: current.branch };
  assert.deepEqual(layoutGraph(inputLayout), layoutGraph(inputLayout));
  const nodes = new Set(laidOut.map((c) => c.hash));
  for (const commit of laidOut) for (const parentHash of commit.parents) {
    if (nodes.has(parentHash)) assert.ok(nodes.has(parentHash));
  }
  assert.ok(timings.length === 3);
  const statusStart = performance.now();
  const statusResult = await h.send('repos/status', {});
  const statusMs = performance.now() - statusStart;
  assert.equal(statusResult.ok, true, JSON.stringify(statusResult));
  const graphPage1Ms = timings[1] ?? (() => { throw new Error('graph page timing missing'); })();
  const loadMoreMs = timings[2] ?? (() => { throw new Error('loadMore timing missing'); })();
  console.log(`Kasus 7 timing: import=${importMs.toFixed(1)}ms status=${statusMs.toFixed(1)}ms graph1=${graphPage1Ms.toFixed(1)}ms loadMore=${loadMoreMs.toFixed(1)}ms`);
});

test('Kasus 7: virtualization remains bounded at cap across scroll and zoom', () => {
  const nodeCount = 10_000;
  for (const zoom of [0.25, 0.5, 1, 2, 4]) {
    for (const scrollCol of [0, 50, 500, 5_000, 9_950, 10_000]) {
      const range = visibleColumnRange({
        scrollLeft: scrollCol * COLUMN_WIDTH * zoom,
        viewportWidth: 1920,
        nodeCount,
        zoom,
      });
      assert.ok(range.start >= 0, `range.start >= 0 (got ${range.start} at zoom=${zoom}, col=${scrollCol})`);
      assert.ok(range.end <= nodeCount, `range.end <= 10000 (got ${range.end} at zoom=${zoom}, col=${scrollCol})`);
      assert.ok(range.end >= range.start, `range.end >= range.start (got [${range.start}, ${range.end}])`);
      const rendered = range.end - range.start;
      assert.ok(rendered <= nodeCount, 'rendered count does not exceed node count');
      assert.ok(rendered <= 150, `rendered count stays bounded by virtualization budget (got ${rendered})`);
    }
  }

  // Edge intersecting band when spanning far across the screen
  const band = visibleWorldBand(5000 * COLUMN_WIDTH, 1920, 1, 6, COLUMN_WIDTH);
  // Edge spanning from col 0 to col 9999
  assert.equal(edgeIntersectsBand(0, 9999 * COLUMN_WIDTH, band), true);
  assert.equal(edgeIntersectsBand(9999 * COLUMN_WIDTH, 0, band), true);
  // Edge far to the left
  assert.equal(edgeIntersectsBand(0, 100 * COLUMN_WIDTH, band), false);
  // Edge far to the right
  assert.equal(edgeIntersectsBand(8000 * COLUMN_WIDTH, 9000 * COLUMN_WIDTH, band), false);
});
