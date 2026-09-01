import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, type Harness, type TestRepo } from './fixture';
import type { ErrorCode, RequestKind } from '../src/messages';

const ERROR_CODES = new Set<ErrorCode>(['VALIDATION_ERROR','AUTH_ERROR','FORBIDDEN','NOT_FOUND','CONFLICT','RATE_LIMITED','SERVER_ERROR','UNAVAILABLE','REPOSITORY_LOCKED','DIRTY_TREE','REMOTE_AHEAD','STALE_STATUS','NON_FAST_FORWARD','HOOK_REJECTED','CONFIRMATION_REQUIRED']);
const kinds: readonly RequestKind[] = ['repos/status','repos/graph','repos/remotes','commits/detail','actions/stage','actions/commit','actions/git','actions/openDiff','actions/showLogs','actions/openExplorer','actions/openExternal','github/auth','github/connect','github/disconnect','github/repo','github/pullRequests','github/linkage','settings/get','settings/set'];

function own(t: { after(fn: () => unknown): void }, repo: TestRepo, h: Harness): void { t.after(() => { h.dispose(); return repo.cleanup(); }); }
function checkResponse(r: any): void { assert.equal(typeof r, 'object'); assert.equal(typeof r.id, 'string'); assert.equal(typeof r.ok, 'boolean'); if (!r.ok) assert.equal(ERROR_CODES.has(r.error.code), true, JSON.stringify(r)); }
function valid(kind: RequestKind, head: string): Record<string, unknown> {
  switch (kind) {
    case 'commits/detail': return { hash: head };
    case 'actions/stage': return { paths: ['c1.txt'], stage: true, statusToken: '', idempotencyKey: `valid-${kind}` };
    case 'actions/commit': return { message: 'valid message', statusToken: '', idempotencyKey: `valid-${kind}` };
    case 'actions/git': return { action: 'fetch', idempotencyKey: `valid-${kind}` };
    case 'actions/openDiff': return { path: 'c1.txt' };
    case 'actions/openExternal': return { url: 'https://github.com/owner/repo' };
    case 'github/repo': return { owner: 'owner', repo: 'repo' };
    case 'github/pullRequests': return { owner: 'owner', repo: 'repo' };
    case 'settings/set': return { key: 'zoom', value: 1 };
    case 'settings/get': return {};
    default: return {};
  }
}
function hostile(kind: RequestKind): Record<string, unknown> {
  if (kind === 'repos/status') return { includeIgnored: 7 };
  if (kind === 'repos/graph') return { limit: 'x'.repeat(1_000_000) };
  if (kind === 'repos/remotes' || kind === 'actions/showLogs' || kind === 'actions/openExplorer' || kind === 'github/auth' || kind === 'github/connect' || kind === 'github/disconnect' || kind === 'github/linkage') return { value: null };
  if (kind === 'commits/detail') return { hash: '--force' };
  if (kind === 'actions/stage') return { paths: ['../../etc/passwd'], stage: true, statusToken: '', idempotencyKey: 'hostile' };
  if (kind === 'actions/commit') return { message: 'x'.repeat(1_000_000), statusToken: '', idempotencyKey: 'hostile' };
  if (kind === 'actions/git') return { action: 'push', remote: '--upload-pack=calc', branch: '--force', idempotencyKey: 'hostile' };
  if (kind === 'actions/openDiff') return { path: '../../etc/passwd', hash: 'bad' };
  if (kind === 'actions/openExternal') return { url: 'https://github.com@evil.example/' };
  if (kind === 'github/repo' || kind === 'github/pullRequests') return { owner: '../../etc/passwd', repo: 'x'.repeat(1_000_000) };
  if (kind === 'settings/get') return { keys: [null] };
  if (kind === 'settings/set') return { key: null, value: { nested: true } };
  return { value: null };
}

test('RequestMap is exhaustively listed and every kind has hostile/error contract coverage', async (t) => {
  assert.equal(new Set(kinds).size, 19);
  const repo = await makeRepo({ label: 'contract' });
  const h = repo.harness({ host: { openDiff: async () => ({ opened: true, mode: 'worktree' }), openExternal: async () => true, githubRepo: async () => ({ defaultBranch: 'main', private: false, htmlUrl: 'https://github.com/x/y', rateLimit: { limit: null, remaining: null, resetAt: null, cached: false, offline: false } }), githubPullRequests: async () => ({ pullRequests: [], rateLimit: { limit: null, remaining: null, resetAt: null, cached: false, offline: false } }), githubLinkage: async () => ({ available: false, host: null, owner: null, repo: null, webUrl: null, commitUrlTemplate: null, apiUrl: null }) } }); own(t, repo, h);
  const head = await repo.git.headHash() as string;
  for (const kind of kinds) {
    const good = await h.send(kind, valid(kind, head));
    checkResponse(good);
    const invalid = await h.send(kind, hostile(kind));
    checkResponse(invalid);
    if (kind !== 'actions/showLogs' && kind !== 'actions/openExplorer') assert.equal(invalid.ok, false, `${kind} hostile payload accepted`);
    const absent = repo.harness({ host: { resolveRepository: async () => null, openDiff: async () => ({ opened: true, mode: 'worktree' }), githubRepo: async () => ({ defaultBranch: 'main', private: false, htmlUrl: '', rateLimit: { limit: null, remaining: null, resetAt: null, cached: false, offline: false } }), githubPullRequests: async () => ({ pullRequests: [], rateLimit: { limit: null, remaining: null, resetAt: null, cached: false, offline: false } }), githubLinkage: async () => ({ available: false, host: null, owner: null, repo: null, webUrl: null, commitUrlTemplate: null, apiUrl: null }) } });
    const missing = await absent.send(kind, valid(kind, head)); checkResponse(missing); absent.dispose();
    if (!missing.ok && ['repos/status','repos/graph','repos/remotes','commits/detail','actions/stage','actions/commit','actions/git','actions/openDiff'].includes(kind)) assert.equal(missing.error.code, 'NOT_FOUND');
  }
});

test('malformed envelopes never become unhandled exceptions; errors use valid codes', async (t) => {
  const repo = await makeRepo({ label: 'contract-envelope' }); const h = repo.harness(); own(t, repo, h);
  for (const kind of kinds) { const r = await h.send(kind, { path: 12, hash: null, owner: [], repo: {}, url: '\\\\server\\share', branch: 'C:\\abs' }); checkResponse(r); }
  for (const line of h.log.lines) { assert.equal(line.includes('--force'), false); assert.equal(line.includes('--force-with-lease'), false); assert.equal(line.split(' ').some((x) => x.startsWith('+')), false); }
});
