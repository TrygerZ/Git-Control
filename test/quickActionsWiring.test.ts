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

test('the Changes view consumes a pending focus target once', () => {
  const src = read('src/webview/CommitForm.tsx');
  assert.match(src, /takeFocus\(/, 'the form asks the store for the target');
  assert.match(src, /textareaRef\.current\?\.focus\(\)/, 'the message field is one target');
  assert.match(src, /pushRef\.current\?\.focus\(\)/, 'the push and publish button is the other');
});

test('the conflict panel consumes a resolve focus target', () => {
  const src = read('src/webview/ConflictPanel.tsx');
  assert.match(src, /takeFocus\(/);
});

test('the webview palette catalog names the button in both languages', () => {
  const en = read('src/webview/i18n.en.ts');
  const id = read('src/webview/i18n.id.ts');
  assert.match(en, /openAria: 'Open quick actions'/);
  assert.match(en, /openTitle: 'Quick actions'/);
  assert.match(id, /openAria: 'Buka aksi cepat'/);
  assert.match(id, /openTitle: 'Aksi cepat'/);
});
