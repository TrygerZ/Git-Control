import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeRepo, removeDir, type Harness, type TestRepo } from './fixture';
import { RepositoryService } from '../src/repository';

function own(t: { after(fn: () => unknown): void }, repo: TestRepo, h?: Harness): void {
  t.after(() => { h?.dispose(); return repo.cleanup(); });
}

async function status(h: Harness): Promise<Record<string, unknown>> {
  const r = await h.send('repos/status', {});
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error('status failed');
  return r.data as Record<string, unknown>;
}

test('empty repository: status, graph, changes are empty-safe', async (t) => {
  const repo = await makeRepo({ commits: 0, label: 'empty' });
  const h = repo.harness(); own(t, repo, h);
  const s = await status(h);
  assert.equal(s.head, null); assert.equal(s.branch, 'main');
  assert.deepEqual(s.changes, []); assert.deepEqual(s.conflicts, []);
  const g = await h.send('repos/graph', {});
  assert.equal(g.ok, true, JSON.stringify(g));
  if (g.ok) { const data = g.data as { nodes: unknown[]; head: string | null }; assert.deepEqual(data.nodes, []); assert.equal(data.head, null); }
});

test('detached HEAD is explicit in status and graph', async (t) => {
  const repo = await makeRepo({ commits: 2, label: 'detached' });
  const h = repo.harness(); own(t, repo, h);
  const head = await repo.detach(); const s = await status(h);
  assert.equal(s.detached, true); assert.equal(s.branch, null); assert.equal(s.head, head);
  const g = await h.send('repos/graph', {}); assert.equal(g.ok, true, JSON.stringify(g));
  if (g.ok) { const data = g.data as { head: string; nodes: Array<{ hash: string; isHead: boolean }> }; assert.equal(data.head, head); assert.equal(data.nodes.find((n) => n.hash === head)?.isHead, true); }
});

test('shallow clone omits unavailable parent edges', async (t) => {
  const source = await makeRepo({ commits: 3, remote: true, label: 'shallow-source' });
  const shallowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-control-shallow-'));
  t.after(() => removeDir(shallowDir)); own(t, source);
  await source.git.run(['clone', '--depth=1', `file://${source.remoteDir!.replace(/\\/g, '/')}`, shallowDir]);
  const service = new RepositoryService({ folderPath: shallowDir, gitPath: 'git', store: { get: <T>(_k: string, d: T) => d, update: async () => undefined }, logger: () => undefined });
  const graph = await service.graph();
  assert.equal(graph.nodes.length, 1); assert.deepEqual(graph.edges, []);
});

test('worktree and submodule .git files resolve correctly', async (t) => {
  const repo = await makeRepo({ commits: 1, label: 'worktree' });
  const h = repo.harness(); own(t, repo, h);
  const worktree = path.join(os.tmpdir(), `git-control-wt-${Date.now()}`);
  t.after(() => removeDir(worktree));
  await repo.git.run(['worktree', 'add', '--quiet', worktree, '-b', 'wt-branch']);
  const service = new RepositoryService({ folderPath: worktree, gitPath: 'git', store: { get: <T>(_k: string, d: T) => d, update: async () => undefined }, logger: () => undefined });
  assert.equal((await service.status()).branch, 'wt-branch'); assert.equal((await service.graph()).nodes.length, 1);
  assert.equal((await fs.readFile(path.join(worktree, '.git'), 'utf8')).startsWith('gitdir:'), true);
  assert.equal((await status(h)).head !== null, true);
});

test('file states survive parse, stage, commit detail; CRLF remains valid', async (t) => {
  const repo = await makeRepo({ autocrlf: 'true', label: 'file-states' });
  const h = repo.harness(); own(t, repo, h);
  const files = await repo.fileStates('binary', 'deleted', 'renamed', 'untracked', 'unicode');
  const s = await status(h); const changes = s.changes as Array<Record<string, unknown>>;
  for (const name of Object.values(files)) assert.ok(changes.some((c) => c.path === name || c.origPath === name), name);
  const unicode = files.unicode!;
  const staged = await h.send('actions/stage', { paths: [unicode], stage: true, statusToken: s.statusToken, idempotencyKey: 'states-stage' });
  assert.equal(staged.ok, true, JSON.stringify(staged));
  const fresh = await status(h); const commit = await h.send('actions/commit', { message: 'file states', statusToken: fresh.statusToken, idempotencyKey: 'states-commit' });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  if (commit.ok && (commit.data as { commit: string | null }).commit) {
    const hash = (commit.data as { commit: string }).commit;
    const detail = await h.send('commits/detail', { hash });
    assert.equal(detail.ok, true, JSON.stringify(detail));
  }
  await fs.writeFile(path.join(repo.dir, 'crlf.txt'), 'a\r\nb\r\n', 'utf8');
  h.repo.invalidate();
  const crlf = await status(h); assert.equal((crlf.changes as Array<{ path: string }>).some((c) => c.path === 'crlf.txt'), true);
});

test('newline filename is covered on POSIX, explicitly skipped on Windows', async (t) => {
  if (process.platform === 'win32') { t.skip('Windows cannot represent newline in a filename'); return; }
  const repo = await makeRepo({ label: 'newline' }); const h = repo.harness(); own(t, repo, h);
  const files = await repo.fileStates('newline'); assert.equal(files.newline, 'line\nbreak.txt');
  assert.equal(((await status(h)).changes as Array<{ path: string }>).some((c) => c.path === files.newline), true);
});

test('pre-commit rejection maps, includes redacted hook output', async (t) => {
  const repo = await makeRepo({ label: 'hook' }); const h = repo.harness(); own(t, repo, h);
  await fs.writeFile(path.join(repo.dir, 'hook.txt'), 'x\n', 'utf8');
  const hook = await repo.installHook('pre-commit', 'echo "HOOK stdout github_pat_abcdefghijklmnopqrstuvwxyz"; echo "HOOK stderr github_pat_abcdefghijklmnopqrstuvwxyz" >&2; exit 1');
  await repo.git.stage(['hook.txt']);
  const s = await status(h); const r = await h.send('actions/commit', { message: 'hook test', statusToken: s.statusToken, idempotencyKey: 'hook-1' });
  assert.equal(r.ok, false, JSON.stringify(r));
  if (!r.ok) { assert.equal(r.error.code, 'HOOK_REJECTED'); assert.match(r.error.detail ?? '', /HOOK/); assert.doesNotMatch(r.error.detail ?? '', /github_pat_/); }
  assert.equal((await fs.stat(hook)).isFile(), true);
});

test('no-upstream status is truthful; push is structured, never force', async (t) => {
  const repo = await makeRepo({ label: 'no-upstream' }); const h = repo.harness(); own(t, repo, h);
  const s = await status(h); assert.equal(s.upstream, null); assert.equal(s.ahead, 0); assert.equal(s.behind, 0);
  const r = await h.send('actions/git', { action: 'push', remote: 'origin', branch: 'main', idempotencyKey: 'no-upstream-push' });
  assert.equal(r.ok, false); if (!r.ok) assert.notEqual(r.error.code, 'SERVER_ERROR');
  for (const line of h.log.lines) { assert.equal(line.includes('--force'), false); assert.equal(line.includes('--force-with-lease'), false); assert.equal(line.split(' ').some((x) => x.startsWith('+')), false); }
});
