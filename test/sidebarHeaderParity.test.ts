/**
 * Sidebar header design parity (frames 02, 05, 08, 09, 11, 20, 42).
 *
 * Source-level contract, same shape as `pendingSections.test.ts`: this project has
 * no DOM harness, so the header is pinned by the branches it must take, the
 * controls it must render in frame order, and the catalog keys that name them.
 *
 * Three rules, one per frame row:
 *  - Changes keeps the 3-row header (title, branch, upstream), frame 20.
 *  - Every other destination renders one 44 px row: name, repository slug, then
 *    the quick-create button for that destination, frames 05, 08, 09, 11.
 *  - The title row carries the frame 20 button order and a More menu, frame 42.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

function read(relative: string): string {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
}

const HEADER = 'src/webview/SidebarHeader.tsx';

test('the header takes its shape from the active route, not from a fixed three-row stack', () => {
  const src = read(HEADER);
  assert.match(src, /useRouteStore\(\(s\) => s\.route\)/, 'it reads the active route');
  assert.match(src, /route\.id !== 'changes'/, 'Changes is the only three-row destination');
  assert.match(src, /gc-sidebar-header--compact/, 'the compact variant is a class, not a second component');
  // The two rows the frames drop on every other destination.
  assert.match(src, /\{!compact && \(/, 'branch and upstream rows are conditional');
});

test('the compact row carries the repository slug beside the repository name', () => {
  const src = read(HEADER);
  assert.match(src, /linkage\?\.owner/, 'the slug comes from the parsed remote');
  assert.match(src, /linkage\?\.repo/);
  assert.match(src, /gc-sidebar-header__slug/, 'the slug has its own slot');
  assert.match(src, /\{compact && slug !== null &&/, 'the slug is compact-only');
});

test('the compact row carries one quick-create button per destination', () => {
  const src = read(HEADER);
  // Pull requests: the view already owns the create dialog and consumes the
  // `create-pr` focus target, so the header only raises the target.
  assert.match(src, /navigateWithFocus\(\{ id: 'prs' \}, 'create-pr'\)/);
  // Branches: the view owns the prompt, and consumes `new-branch` the same way.
  assert.match(src, /navigateWithFocus\(\{ id: 'branches', sub: 'local' \}, 'new-branch'\)/);
  // Issues: P26 ships the in-extension NewIssueDialog, so the header raises `new-issue`
  // when signed in and issues are enabled.
  assert.match(src, /navigateWithFocus\(\{ id: 'issues' \}, 'new-issue'\)/, 'New issue opens the in-extension dialog');
  assert.match(src, /route\.id === 'issues'[\s\S]*?auth\?\.connected === true[\s\S]*?!issuesDisabled/, 'header New issue button requires signed-in state and enabled issues');
  // Actions: P27 ships the in-extension RunWorkflowDialog, so the header raises `run-workflow`
  // when signed in.
  assert.match(src, /navigateWithFocus\(\{ id: 'actions' \}, 'run-workflow'\)/, 'Run workflow opens the in-extension dialog');
  assert.match(src, /route\.id === 'actions'[\s\S]*?auth\?\.connected === true/, 'header Run workflow button requires signed-in state');
  assert.match(src, /route\.id === 'actions'[\s\S]*?useActionsStore\.getState\(\)\.load\(\{ force: true \}\)/, 'header reload refreshes Actions list on Actions route');
  assert.match(src, /strings\.shell\.addPr/, 'the button is named in the catalog');
  assert.match(src, /strings\.shell\.addIssue/);
  assert.match(src, /strings\.shell\.addWorkflow/);
  assert.match(src, /strings\.shell\.addBranch/);
});

test('the Changes title row follows the frame 20 button order', () => {
  const src = read(HEADER);
  const order = [
    'strings.pending.reloadAria',
    'strings.pending.openGraphAria',
    'strings.palette.openAria',
    'strings.help.openAria',
    'strings.shell.moreAria',
  ].map((key) => src.indexOf(`aria-label={${key}}`));
  for (const index of order) assert.ok(index > 0, 'every title-row button is present');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'refresh, graph, quick actions, help, more');
});

test('the More menu is the frame 42 menu: reload, repository links, account', () => {
  const src = read(HEADER);
  assert.match(src, /role="menu"/);
  assert.match(src, /strings\.shell\.menuReload/, 'Reload');
  assert.match(src, /strings\.shell\.menuOpenRepo/, 'Open repository on GitHub');
  assert.match(src, /strings\.shell\.menuCopyUrl/, 'Copy repository URL');
  assert.match(src, /strings\.explorerMenu\.connectGithub/, 'Connect GitHub');
  assert.match(src, /strings\.explorerMenu\.disconnectGithub/, 'Disconnect GitHub');
  // A menu row navigates, copies, or reuses a store action. It never invents a
  // request kind of its own, and it cannot run git.
  const calls = src.match(/bridge\.request\('([^']+)'/g) ?? [];
  for (const call of calls) {
    assert.match(call, /actions\/openExplorer|actions\/openQuickActions/, `unexpected request ${call}`);
  }
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
});

test('the compact header keeps every control named for a screen reader', () => {
  const src = read(HEADER);
  // A `+` with no name reads as "plus" or as nothing at all.
  const adds = src.match(/aria-label=\{strings\.shell\.add\w+\}/g) ?? [];
  assert.equal(adds.length, 4, 'each quick-create button carries its own name');
  assert.match(src, /aria-haspopup="menu"/, 'the More trigger announces the popup');
  assert.match(src, /aria-expanded=\{menuOpen\}/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
});

test('the stylesheet carries the compact variant and the slug slot', () => {
  const css = read('src/webview/styles.css');
  assert.match(css, /\.gc-sidebar-header--compact\s*\{/);
  assert.match(css, /\.gc-sidebar-header__slug\s*\{/);
  // The three-row geometry of frame 20 stays untouched for the Changes route.
  const header = css.match(/\.gc-sidebar-header\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(header, /padding:\s*var\(--gc-space-4\)\s+var\(--gc-space-4\)\s+var\(--gc-space-3\);/);
});

test('the new-branch focus target has a consumer, so the header may raise it', () => {
  // Same rule as `create-pr`: a target no view honors sits in `pendingFocus` until
  // an unrelated view claims it, which is worse than not offering the button.
  const messages = read('src/messages.ts');
  const union = /export type FocusTarget = ([^;]+);/.exec(messages)?.[1] ?? '';
  assert.match(union, /new-branch/, 'the type ships with the view that consumes it');

  const guards = read('src/webview/hostGuards.ts');
  assert.match(guards, /'new-branch'/, 'the host boundary validates it');

  const branches = read('src/webview/BranchesView.tsx');
  assert.match(branches, /pendingFocus !== 'new-branch'/, 'the Branches view ignores other targets');
  assert.match(branches, /setCreateOpen\(true\)/, 'and opens its own prompt');

  assert.match(union, /new-issue/, 'new-issue ships with the Issues dialog that consumes it');
  assert.match(guards, /'new-issue'/, 'the host boundary validates new-issue');
  const issues = read('src/webview/IssuesView.tsx');
  assert.match(issues, /pendingFocus !== 'new-issue'/, 'the Issues view consumes new-issue');

  assert.match(union, /run-workflow/, 'run-workflow ships with the Actions dialog that consumes it');
  assert.match(guards, /'run-workflow'/, 'the host boundary validates run-workflow');
  const actions = read('src/webview/ActionsView.tsx');
  assert.match(actions, /pendingFocus !== 'run-workflow'/, 'the Actions view consumes run-workflow');
});

test('both catalogs name every new shell string', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    for (const key of ['addPr', 'addIssue', 'addWorkflow', 'addBranch', 'moreAria', 'moreTitle', 'menuReload', 'menuOpenRepo', 'menuCopyUrl']) {
      assert.ok(catalog.includes(`    ${key}:`), `${lang} catalog is missing ${key}`);
    }
  }
});
