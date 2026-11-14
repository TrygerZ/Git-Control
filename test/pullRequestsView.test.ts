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
import { navRegistry } from '../src/webview/navRegistry';
import { restoreTarget } from '../src/webview/focusTrap';
import '../src/webview/NavStrip';

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
  // Registration is at module scope, so importing the strip is enough to observe
  // what the shipped bundle registers. Asserting the registry directly is stronger
  // than matching source text, which would pass even if the call were removed.
  const dests = navRegistry.list();
  const prs = dests.find((d) => d.id === 'prs');
  assert.ok(prs !== undefined, 'prs must be registered');
  assert.equal(prs.requiresGitHub, false, 'the list stays readable without a token');
  assert.deepEqual(
    dests.map((d) => d.id),
    ['changes', 'prs', 'issues', 'actions', 'branches'],
    'order is the strip order',
  );

  const src = read('src/webview/NavStrip.tsx');
  assert.match(src, /badgeCount\(/, 'the badge is the capped count, not a second request');
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

test('the sidebar shell loads GitHub metadata on mount, so the badge is filled before the view opens', () => {
  const src = read('src/webview/PendingChanges.tsx');
  // The badge lives in the strip, which renders on every route. Without this call
  // the count stays empty until the user happens to open Pull requests, which is
  // the acceptance criterion "the PR badge equals the Open chip count".
  assert.match(src, /useGitHubStore\.getState\(\)\.load\(\)/);
});

test('focus returns to the control that started a connect attempt', () => {
  // The spec asks for focus to return to the Connect button after a cancelled
  // connect. A cancelled host input box resolves normally, so the only thing that
  // decides this is whether the element still exists when the await returns.
  assert.equal(restoreTarget(true), 'connect');
  assert.equal(restoreTarget(false), 'none', 'a button that is gone must not take focus');
});

test('the view wires the connect focus restore into both Connect buttons', () => {
  const src = read('src/webview/PullRequestsView.tsx');
  assert.match(src, /restoreTarget\(/);
  assert.match(src, /connectRef/, 'the button is reached through a ref, not a re-render');
});

// ------------------------------------------------- P12: Reload revalidates

test('Reload revalidates the pull request list instead of replaying the host cache', () => {
  // P07 deferred the "..." menu, so the header refresh button is the Reload
  // affordance the user actually has. On the prs route it must ask for a
  // conditional request; on every other route it must not touch GitHub at all.
  const src = read('src/webview/SidebarHeader.tsx');
  assert.match(src, /loadPullRequests\(\s*\{\s*refresh:\s*true\s*\}\s*\)/, 'the reload asks for a refresh');
  assert.match(src, /route\.id === 'prs'/, 'and only while the list is on screen');
});

// ------------------------------------------------ P23: checkout a pull request

/**
 * The row action is the same request every other git action sends, so the view
 * must not grow its own store state or its own bridge call for it. The branch
 * name is never built here: the payload carries the number and the host derives
 * `pr/<n>`, which is what makes a crafted branch name impossible.
 */
test('the checkout action sends the number, not a branch name', () => {
  const view = read('src/webview/PullRequestsView.tsx');
  assert.match(view, /action: 'checkout-pr'/, 'the row action is the checkout request');
  assert.match(view, /number: pr\.number/);
  assert.doesNotMatch(view, /pr\/\$\{/, 'the view never composes the branch name');
  assert.match(view, /runAction\(/);

  const store = read('src/webview/store.ts');
  assert.doesNotMatch(store, /checkoutPullRequest/, 'no new store state for a one-shot action');
});

test('a fork row is marked read only and passes the flag to the host', () => {
  const view = read('src/webview/PullRequestsView.tsx');
  assert.match(view, /pr\.isFork/, 'the row reads the fork flag');
  assert.match(view, /readOnly: true/, 'and tells the host, so a push can be refused');
  assert.match(view, /readOnlyChip/, 'the chip text comes from the catalog');
});

test('a row whose branch is checked out says so, and the row still opens the pull request', () => {
  const view = read('src/webview/PullRequestsView.tsx');
  assert.match(view, /checkedOut/);
  // The row's own click stays the URL opener: checkout is a separate button, so a
  // reader never loses the ability to open the pull request on GitHub.
  assert.match(view, /openUrl\(pr\.url\)/);
  // The checkout button is a real tab stop with an accessible name carrying the
  // number, not a hover-only decoration, and the name states the checked-out case
  // rather than promising an action that would be a no-op.
  // Both names come from the catalog, and the checked-out case wins when the row
  // is already on its branch.
  assert.match(view, /checkoutAria/);
  assert.match(view, /aria-label=\{checkoutName\}/);
  assert.match(view, /isCheckedOut\s*\?\s*strings\.prs\.checkedOut/);
});

/**
 * A row whose number is not a positive integer must not reach `prBranchName`,
 * which throws. `toPullRequests` defaults a missing number to 0, and the view
 * mounts inside the app-level error boundary, so one malformed API row would
 * replace the whole sidebar with the crash screen. The guard is the row's own
 * `isCheckedOut`, which must be false rather than a throw.
 */
test('a malformed row number cannot throw during render', () => {
  const view = read('src/webview/PullRequestsView.tsx');
  const line = view
    .split('\n')
    .find((l) => l.includes('prBranchName(pr.number)'));
  assert.ok(line !== undefined, 'the checked-out test still derives the name');
  // The guard must be the same predicate `prBranchName` enforces, not a looser
  // `> 0`: a non-integer row number passes `> 0` and still throws.
  assert.match(line, /validatePullRequestNumber/, 'the call is guarded by the shared validator');
});
