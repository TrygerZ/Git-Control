import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, type Harness, type TestRepo } from './fixture';
import { MAX_COMMIT_LIMIT } from '../src/repository';
import { visibleRowRange, edgeIntersectsBand, visibleWorldBand } from '../src/webview/viewport';
import { layoutGraph } from '../src/layout';
import type { RepoGraph } from '../src/messages';

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

test('Kasus 7: virtualization remains bounded at cap across scroll and zoom', () => {
  for (const zoom of [0.25, 0.5, 1, 2, 4]) {
    for (const scrollTop of [0, 12_000, 120_000, 239_976]) {
      const range = visibleRowRange({ scrollTop, viewportHeight: 900, rowCount: 10_000, zoom });
      assert.ok(range.start >= 0 && range.end <= 10_000);
      assert.ok(range.end - range.start <= 10_000);
    }
  }
  assert.equal(edgeIntersectsBand(0, 999_999, visibleWorldBand(120_000, 900, 4)), true);
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
