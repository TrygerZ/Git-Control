/**
 * Pull requests view (P07).
 *
 * Source-level contract only: this project has no DOM harness, so the component
 * is pinned by the helpers it must route through, the requests it may and may
 * not send, and the state it may not keep to itself. Behaviour of the helpers is
 * covered by `githubGate.test.ts`, `prFilters.test.ts`, and `listNav.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PR_PAGE_SIZE, badgeCount } from '../src/webview/prFilters';

const ROOT = path.join(__dirname, '..', '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('the view exists and routes its decisions through the pure helpers', () => {
  const src = read('src/webview/PullRequestsView.tsx');
  for (const helper of ['githubGate', 'filterPullRequests', 'countByFilter', 'groupPullRequests', 'matchesText', 'nextIndex', 'isStale', 'badgeCount', 'apiQuotaLabel']) {
    assert.match(src, new RegExp(`\\b${helper}\\b`), helper);
  }
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
});

test('the view sends no request of its own beyond the store actions', () => {
  const src = read('src/webview/PullRequestsView.tsx');
  // Every GitHub read is a store action. A direct bridge call here would bypass
  // the load-time stamp the gate compares against.
  assert.doesNotMatch(src, /bridge\.request\(/);
  assert.match(src, /useGitHubStore/);
});

test('reload follows the stale rule instead of refetching on every activation', () => {
  const src = read('src/webview/PullRequestsView.tsx');
  assert.match(src, /isStale\(/);
  assert.match(src, /pullRequestsLoadedAt/);
  assert.match(src, /loadPullRequests\(\)/);
  // No timer, no interval: this phase does not poll.
  assert.doesNotMatch(src, /setInterval/);
});

test('untrusted text goes through the sanitizer', () => {
  const src = read('src/webview/PullRequestsView.tsx');
  assert.match(src, /sanitizeGitText/);
  assert.doesNotMatch(src, /href=\{pr\.url\}/, 'links open through the host, not a raw href');
  assert.match(src, /openUrl\(/);
});

test('the nav destination registers as prs with the badge from the same array', () => {
  const src = read('src/webview/NavStrip.tsx');
  assert.match(src, /id: 'prs'/);
  assert.match(src, /requiresGitHub: false/, 'the list stays readable without a token');
  assert.match(src, /badgeCount\(/, 'the badge is the capped count, not a second request');
  // Registration happens on mount, so a headless import of the registry is empty
  // by design; the source is what proves the second destination exists.
  assert.match(src, /navRegistry\.register\(/);
});

test('the badge caps at the page size', () => {
  assert.equal(badgeCount(PR_PAGE_SIZE, PR_PAGE_SIZE), `${PR_PAGE_SIZE}+`);
});

test('the sidebar shell renders the view on the prs route and keeps the Changes tree otherwise', () => {
  const src = read('src/webview/PendingChanges.tsx');
  assert.match(src, /PullRequestsView/);
  assert.match(src, /route\.id === 'prs'/, 'the route decides which view renders');
  assert.match(src, /<NavStrip \/>/, 'the strip stays above both views');
  assert.match(src, /<SidebarHeader \/>/, 'and so does the header');
});

test('the Explorer keeps its GitHub metadata load without the panel', () => {
  const explorer = read('src/webview/ExplorerApp.tsx');
  assert.doesNotMatch(explorer, /GitHubPanel/, 'the aside no longer renders the panel');
  // Precondition 3 of P07: removing the panel must not take the store load with
  // it, because commit avatars and links resolve from the same slice.
  assert.match(explorer, /useGitHubStore\.getState\(\)\.load\(\)/, 'the load moves into the mount effect');
});

test('the old panel is gone and nothing imports it', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'src/webview/GitHubPanel.tsx')), false);
  const files = fs.readdirSync(path.join(ROOT, 'src/webview')).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
  for (const file of files) {
    const src = read(`src/webview/${file}`);
    assert.doesNotMatch(src, /from '\.\/GitHubPanel'/, file);
  }
});
