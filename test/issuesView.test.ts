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

test('clearFilters resets chip, state, text, and label', () => {
  const src = read('src/webview/IssuesView.tsx');
  const body = src.slice(src.indexOf('const clearFilters'), src.indexOf('const setConnectButton'));
  assert.match(body, /select\(\s*['"]assigned['"]\s*,\s*['"]open['"]\s*\)/, 'the selection returns to Assigned, Open');
  assert.match(body, /setQuery\(/);
  assert.match(body, /setLabelFilter\(/);
});

test('view does not load issues when signed out', () => {
  const src = read('src/webview/IssuesView.tsx');
  assert.match(src, /auth\?\.connected === true/);
});

test('the filter menu implements the shared menu keyboard model', () => {
  const src = read('src/webview/IssuesView.tsx');
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape']) {
    assert.match(src, new RegExp(`['"]${key}['"]`), `${key} is handled`);
  }
  assert.match(src, /role="menu"/);
  // The first item takes focus on open, or a keyboard user never reaches the items.
  assert.match(src, /\.focus\(\)/);
});

test('the State filter renders Open and Closed from the catalog', () => {
  const src = read('src/webview/IssuesView.tsx');
  assert.match(src, /strings\.issues\.filterOpen/);
  assert.match(src, /strings\.issues\.filterClosed/);
  assert.match(src, /strings\.issues\.filterState/);
});

test('the external link button is decorative for assistive tech', () => {
  const src = read('src/webview/IssuesView.tsx');
  const link = src.slice(src.indexOf('gc-issues__link'), src.indexOf('gc-issues__link') + 400);
  assert.match(link, /aria-hidden="true"/, 'the row already names Open on GitHub');
  assert.match(link, /tabIndex=\{-1\}/);
});
