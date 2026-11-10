/**
 * Quick actions wiring (P15).
 *
 * Three boundaries are pinned here, all source-based because the host needs
 * `vscode`: the bridge route takes no payload, the host owns the pick, and the
 * header search icon sends that request. Manifest declarations live in
 * `manifest.test.ts`, which owns `package.json`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

test('the bridge routes actions/openQuickActions through an empty-payload handler', () => {
  const src = read('src/bridge.ts');
  assert.match(src, /case 'actions\/openQuickActions':/);
  assert.match(src, /openQuickActions\?\(\): void;/);
  assert.match(src, /private handleOpenQuickActions\(\): \{ opened: boolean \}/);
});

test('the request kind is declared with an empty payload and an opened flag', () => {
  const src = read('src/messages.ts');
  assert.match(
    src,
    /'actions\/openQuickActions': \{ payload: Record<string, never>; response: \{ opened: boolean \} \};/,
  );
});

test('the host registers the command, the bridge member, and the pick', () => {
  const src = read('src/extension.ts');
  assert.match(src, /register\('gitControl\.quickActions'/, 'the command is registered');
  assert.match(src, /openQuickActions: \(\) => this\.showQuickActions\(\)/, 'the bridge member is wired');
  assert.match(src, /private async showQuickActions\(\): Promise<void>/, 'the pick lives on the controller');
  assert.match(src, /showQuickPick|createQuickPick/, 'a native QuickPick is used');
});

test('the host builds its context from the existing caches, not from a new request', () => {
  const src = read('src/extension.ts');
  const start = src.indexOf('private async showQuickActions()');
  assert.ok(start > 0);
  const body = src.slice(start, start + 4000);
  assert.match(body, /buildQuickRows\(/, 'ranking comes from the pure module');
  assert.doesNotMatch(body, /fetch\(|https?:\/\//, 'the palette makes no network call (K4)');
  assert.match(body, /escapeCodicons\(/, 'git-sourced branch names are escaped');
});

test('a row never runs a mutation: the pick only navigates or opens the explorer', () => {
  const src = read('src/extension.ts');
  const start = src.indexOf('private async showQuickActions()');
  assert.ok(start > 0);
  const body = src.slice(start, start + 4000);
  assert.doesNotMatch(body, /runAction|executeCommand\('gitControl\.(openPullRequests|openIssues|openActions|openBranches)'/);
  assert.match(body, /this\.navigate\(/, 'navigation goes through the validated route entry point');
});

test('the sidebar header search icon sends the quick actions request', () => {
  const src = read('src/webview/SidebarHeader.tsx');
  assert.match(src, /actions\/openQuickActions/);
  assert.match(src, /aria-label=\{strings\.palette\.openAria\}/);
  assert.match(src, /title=\{strings\.palette\.openTitle\}/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
});

test('the route store owns the one-shot focus target', () => {
  const src = read('src/webview/store.ts');
  assert.match(src, /pendingFocus: FocusTarget \| null;/, 'the field is typed');
  assert.match(src, /takeFocus\(\): FocusTarget \| null;/, 'consumption is explicit');
  assert.match(src, /navigate\(payload\.route/, 'the event handler forwards the route');
  assert.match(src, /pendingFocus: payload\.focus \?\? null/, 'and the focus that came with it');
});

test('the Changes view consumes a pending focus target when it arrives, not only on mount', () => {
  const src = read('src/webview/CommitForm.tsx');
  // The view is usually already open when a quick action fires, so a mount-only
  // effect would never run and the target would sit queued for a later remount.
  assert.match(
    src,
    /useRouteStore\(\(s\) => s\.pendingFocus\)/,
    'the form subscribes to the target instead of sampling it once',
  );
  assert.match(src, /takeFocus\(/, 'consumption is explicit and clears the target');
  assert.match(src, /textareaRef\.current\?\.focus\(\)/, 'the message field is one target');
  assert.match(src, /pushRef\.current\?\.focus\(\)/, 'the push and publish button is the other');
});

test('the conflict panel consumes a resolve focus target when it arrives', () => {
  const src = read('src/webview/ConflictPanel.tsx');
  assert.match(src, /useRouteStore\(\(s\) => s\.pendingFocus\)/);
  assert.match(src, /takeFocus\(/);
});

test('a view only consumes a focus target it owns, so a sibling cannot swallow it', () => {
  // The commit form and the conflict panel are mounted at the same time. If the
  // form cleared every target it saw, a `resolve` target would vanish before the
  // panel could act on it.
  const form = read('src/webview/CommitForm.tsx');
  const guard = /if \(pendingFocus !== 'commit' && pendingFocus !== 'publish' && pendingFocus !== 'push'\) return;/;
  assert.match(form, guard, 'the form ignores targets that are not its own');

  const panel = read('src/webview/ConflictPanel.tsx');
  assert.match(
    panel,
    /if \(pendingFocus !== 'resolve'\) return;/,
    'the panel ignores targets that are not its own',
  );
});

test('a zero-conflict operation focuses Continue, since the conflict panel is not mounted', () => {
  // `ConflictPanel` renders only when there is at least one conflicted file, so
  // the "can continue now" state has to be served by the banner above it.
  const src = read('src/webview/ConflictPanel.tsx');
  const banner = src.slice(0, src.indexOf('interface Props'));
  assert.match(banner, /useRouteStore\(\(s\) => s\.pendingFocus\)/, 'the banner watches the target');
  assert.match(banner, /continueRef\.current\?\.focus\(\)/, 'Continue is the target');
});

test('an unresolved operation focuses the first Resolve button, not the disabled Continue', () => {
  // The banner's Continue is `disabled` while files remain conflicted, so
  // focusing it would leave the user on a dead control. The panel owns the
  // target in that state; the banner stands aside so the two cannot race.
  const src = read('src/webview/ConflictPanel.tsx');
  const banner = src.slice(0, src.indexOf('interface Props'));
  assert.match(
    banner,
    /status\.conflicts\.length > 0\) return;/,
    'the banner declines the target while the panel is mounted',
  );

  const panel = src.slice(src.indexOf('export function ConflictPanel'));
  assert.match(panel, /useRouteStore\(\(s\) => s\.pendingFocus\)/, 'the panel watches the target');
  assert.match(panel, /resolveRef\.current\?\.focus\(\)/, 'the first Resolve button is the target');
});

test('the webview palette catalog names the button in both languages', () => {
  const en = read('src/webview/i18n.en.ts');
  const id = read('src/webview/i18n.id.ts');
  assert.match(en, /openAria: 'Open quick actions'/);
  assert.match(en, /openTitle: 'Quick actions'/);
  assert.match(id, /openAria: 'Buka aksi cepat'/);
  assert.match(id, /openTitle: 'Aksi cepat'/);
});
