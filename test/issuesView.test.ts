/**
 * Issues view (P08).
 *
 * Source-level contract only: this project has no DOM harness, so the component
 * is pinned by the helpers it must route through, the requests it may and may
 * not send, and the state it may not keep to itself. Behaviour of the helpers is
 * covered by `githubGate.test.ts`, `issues.test.ts`, and `listNav.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('the issues view exists and routes its decisions through the pure helpers', () => {
  const src = read('src/webview/IssuesView.tsx');
  for (const helper of [
    'githubGate',
    'filterIssues',
    'labelOptions',
    'matchesText',
    'issueExcerpt',
    'nextIndex',
    'isStale',
    'apiQuotaLabel',
    'sanitizeGitText',
  ]) {
    assert.match(src, new RegExp(`\\b${helper}\\b`), helper);
  }
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
});

test('the issues view sends no request of its own beyond the store actions', () => {
  const src = read('src/webview/IssuesView.tsx');
  assert.doesNotMatch(src, /bridge\.request\(/);
  assert.match(src, /useIssuesStore/);
  assert.match(src, /useGitHubStore/);
});

test('reload follows the stale rule instead of refetching on every activation', () => {
  const src = read('src/webview/IssuesView.tsx');
  assert.match(src, /isStale\(/);
  assert.match(src, /loadedAt/);
  assert.match(src, /load\(/);
  assert.doesNotMatch(src, /setInterval/);
});

test('untrusted issue text goes through the sanitizer and external links go through host', () => {
  const src = read('src/webview/IssuesView.tsx');
  assert.match(src, /sanitizeGitText/);
  assert.doesNotMatch(src, /href=\{issue\.url\}/, 'links open through the host, not a raw href');
  assert.match(src, /openUrl\(/);
});

test('row preview expands with accessible aria attributes', () => {
  const src = read('src/webview/IssuesView.tsx');
  assert.match(src, /aria-expanded=/);
  assert.match(src, /aria-controls=/);
});
