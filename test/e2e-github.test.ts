import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError, type FetchResponseLike } from '../src/github';
import { makeRepo, type Harness, type TestRepo } from './fixture';

const TOKEN = 'ghp_e2e_secret_0123456789abcdef';
function headers(map: Record<string, string>) { const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v])); return { get: (n: string) => lower.get(n.toLowerCase()) ?? null }; }
function response(status: number, body: unknown, h: Record<string, string> = {}): FetchResponseLike { return { status, ok: status >= 200 && status < 300, headers: headers(h), text: () => Promise.resolve(JSON.stringify(body)) }; }
function fake(queue: Array<FetchResponseLike | Error>) {
  const calls: string[] = []; let i = 0;
  return { calls, fetchImpl: (url: string) => { calls.push(url); const x = queue[Math.min(i++, queue.length - 1)]; if (x === undefined) return Promise.reject(new Error('empty test queue')); return x instanceof Error ? Promise.reject(x) : Promise.resolve(x); } };
}
function client(queue: Array<FetchResponseLike | Error>) {
  const f = fake(queue); let now = 1_700_000_000_000; const sleeps: number[] = [];
  const gh = new GitHubClient({ apiUrl: 'https://api.github.com', token: TOKEN, fetchImpl: f.fetchImpl, now: () => now, sleep: async (ms) => { sleeps.push(ms); } });
  return { gh, ...f, sleeps, advance: (ms: number) => { now += ms; } };
}
function own(t: { after(fn: () => unknown): void }, repo: TestRepo, h?: Harness): void { t.after(() => { h?.dispose(); return repo.cleanup(); }); }

test('Kasus 8: bridge exposes rate-limit badge and serves cached data after 403 quota exhaustion', async (t) => {
  const repo = await makeRepo({ label: 'k8-bridge' });
  const h = client([
    response(200, { default_branch: 'main', private: false, html_url: 'https://github.com/o/r' }, { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '9', 'x-ratelimit-reset': '1700000600' }),
    response(403, { message: 'quota' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000601' }),
  ]);
  const bridge = repo.harness({ host: { githubRepo: async () => { const result = await h.gh.repo('o', 'r'); return { ...result.data, rateLimit: result.rateLimit }; } } });
  own(t, repo, bridge);
  const first = await bridge.send('github/repo', { owner: 'o', repo: 'r' });
  assert.equal(first.ok, true);
  assert.deepEqual(h.gh.rateLimit(), { limit: 5000, remaining: 9, resetAt: 1_700_000_600_000, cached: false, offline: false });
  const limited = await h.gh.repo('other', 'r').catch((e: unknown) => e);
  assert.ok(limited instanceof GitHubError);
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.equal(limited.resetAt, 1_700_000_601_000);
  const cached = await h.gh.repo('o', 'r');
  assert.equal(cached.cached, true);
  assert.equal(cached.data.defaultBranch, 'main');
  const local = await bridge.send('repos/status', {});
  assert.equal(local.ok, true);
});

test('Kasus 8: retry policy, breaker probe, TTL, cap, mappings, and redaction', async () => {
  const h = client([new Error(`network ${TOKEN}`)]);
  await assert.rejects(() => h.gh.repo('o', 'r'));
  assert.deepEqual(h.sleeps, [500, 1000, 2000]);
  assert.equal(h.calls.length, 4);
  for (const status of [401, 404, 400]) {
    const x = client([response(status, { message: TOKEN })]);
    await assert.rejects(() => x.gh.repo('o', 'r'), (e: unknown) => { assert.ok(e instanceof GitHubError); assert.ok(!JSON.stringify(e).includes(TOKEN)); return true; });
    assert.equal(x.calls.length, 1);
    assert.deepEqual(x.sleeps, []);
  }
  const b = client([response(500, {})]);
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => b.gh.repo(`x${i}`, 'r'));
  assert.equal(b.gh.circuitOpen, true);
  const before = b.calls.length; await assert.rejects(() => b.gh.repo('fresh', 'r')); assert.equal(b.calls.length, before);
  const opened = b.gh.probe(); assert.equal(await opened, false);
  const cached = client([response(200, { default_branch: 'main', private: false, html_url: 'u' })]);
  await cached.gh.repo('o', 'r'); cached.advance(299_999); assert.equal((await cached.gh.repo('o', 'r')).cached, true); cached.advance(2); assert.equal((await cached.gh.repo('o', 'r')).cached, false);
  assert.equal(cached.gh.cacheSize, 1);
});
