/**
 * Contract tests for the icon-theme PULL path (`iconTheme/get`).
 *
 * The webview previously depended on a mount-time PUSH
 * (`event/iconThemeChanged` fired from `resolveWebviewView`) that could arrive
 * before the webview's listeners were wired, silently dropping the snapshot
 * until the next theme switch. The pull closes that race: the webview asks for
 * the snapshot after `wireHostEvents()`, so delivery no longer depends on the
 * order in which host and webview finish mounting.
 *
 * These tests pin, at runtime, the three facts that keep the race closed:
 *   1. the host handler answers with a snapshot, and `null` when none is active
 *   2. both webview roots pull on mount, after `wireHostEvents`
 *   3. the mount-time push calls are gone (they were the race's source)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { makeRepo, type Harness, type TestRepo } from './fixture';
import type { IconThemeSnapshot } from '../src/messages';

// Tests are bundled to `out/test`, so the repo's `src` sits two levels up
// (same convention as `a11y.test.ts`).
const SRC = path.join(__dirname, '..', '..', 'src');

function own(t: { after(fn: () => unknown): void }, repo: TestRepo, h: Harness): void {
  t.after(() => {
    h.dispose();
    return repo.cleanup();
  });
}

function snapshotOf(themeId: string): IconThemeSnapshot {
  return {
    themeId,
    definitions: { file: { iconUri: 'https://x/icons/file.svg' } },
    file: 'file',
    fileExtensions: { js: 'file' },
    fileNames: {},
    folderNames: {},
    folderNamesExpanded: {},
    languageIds: {},
    languageByExtension: {},
    languageByFilename: {},
    fonts: [],
    hidesExplorerArrows: false,
  };
}

test('iconTheme/get returns the snapshot when a theme is active', async (t) => {
  const repo = await makeRepo({ label: 'icontheme-pull' });
  const h = repo.harness({
    host: { iconThemeSnapshot: () => Promise.resolve(snapshotOf('material')) },
  });
  own(t, repo, h);
  const response = await h.send('iconTheme/get', {});
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const snapshot = response.data as IconThemeSnapshot;
  assert.equal(snapshot.themeId, 'material');
  assert.equal(snapshot.definitions['file']?.iconUri, 'https://x/icons/file.svg');
});

test('iconTheme/get returns null when no icon theme is active', async (t) => {
  const repo = await makeRepo({ label: 'icontheme-pull' });
  const h = repo.harness({ host: { iconThemeSnapshot: () => Promise.resolve(null) } });
  own(t, repo, h);
  const response = await h.send('iconTheme/get', {});
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(response.data, null);
});

test('iconTheme/get rejects a non-empty payload', async (t) => {
  const repo = await makeRepo({ label: 'icontheme-pull' });
  const h = repo.harness({
    host: { iconThemeSnapshot: () => Promise.resolve(null) },
  });
  own(t, repo, h);
  const response = await h.send('iconTheme/get', { value: null } as object);
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'VALIDATION_ERROR');
  assert.equal(response.error.status, 400);
});

test('iconTheme/get without a host callback degrades to 503 UNAVAILABLE', async (t) => {
  const repo = await makeRepo({ label: 'icontheme-pull' });
  const h = repo.harness();
  own(t, repo, h);
  const response = await h.send('iconTheme/get', {});
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'UNAVAILABLE');
  assert.equal(response.error.status, 503);
});

// --------------------------------------------------------------- mount wiring

/**
 * Source-level contract: the pull must be issued from both roots AFTER the
 * host-event listeners are wired. This is the load-bearing ordering — the
 * whole point of the fix. Parsed with the TypeScript AST (same style as
 * `a11y.test.ts` / `pendingSections.test.ts`), so comments or refactors that
 * reorder the calls fail loudly instead of reopening the race silently.
 */
function findCallOrder(
  source: string,
  names: readonly string[],
): Array<{ name: string; pos: number }> {
  const sf = ts.createSourceFile('root.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Array<{ name: string; pos: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text)) {
      found.push({ name: node.expression.text, pos: node.getStart(sf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found.sort((a, b) => a.pos - b.pos);
}

for (const [file, mode] of [
  ['PendingChanges.tsx', 'pending'],
  ['ExplorerApp.tsx', 'explorer'],
] as const) {
  test(`${file} pulls the icon theme on mount, after wireHostEvents('${mode}')`, () => {
    const source = fs.readFileSync(path.join(SRC, 'webview', file), 'utf8');
    const order = findCallOrder(source, ['wireHostEvents', 'loadIconTheme']);
    const wire = order.find((c) => c.name === 'wireHostEvents');
    const pull = order.find((c) => c.name === 'loadIconTheme');
    assert.notEqual(wire, undefined, `${file} must call wireHostEvents`);
    assert.notEqual(pull, undefined, `${file} must call loadIconTheme`);
    if (wire === undefined || pull === undefined) return;
    assert.ok(
      pull.pos > wire.pos,
      `${file}: loadIconTheme must follow wireHostEvents so the pull cannot race the listener wiring`,
    );
  });

  test(`${file} useEffect deps include the pull action`, () => {
    const source = fs.readFileSync(path.join(SRC, 'webview', file), 'utf8');
    assert.match(
      source,
      /useIconThemeStore\(\(s\) => s\.load\)/,
      `${file} must subscribe to the pull action`,
    );
  });
}

// ------------------------------------------------------- regression: the race

/**
 * The removed mount-time pushes were the race. If someone reintroduces them in
 * `extension.ts` alongside the pull, the snapshot is again delivered twice at
 * mount time with the timing-dependent one first — exactly the bug. This pins
 * their absence.
 */
test('extension no longer broadcasts the icon theme at webview mount (race source removed)', () => {
  const source = fs.readFileSync(path.join(SRC, 'extension.ts'), 'utf8');
  // Pull out the two webview-mount functions and assert neither pushes.
  const resolve = source.slice(source.indexOf('resolveWebviewView:'), source.indexOf('private async openDiff'));
  assert.equal(
    resolve.includes('broadcastIconThemeChanged()'),
    false,
    'resolveWebviewView must not push the icon theme: the webview pulls it after its listeners are wired',
  );
  const explorer = source.slice(
    source.indexOf('private openExplorer():'),
    source.indexOf('private webviewOptions():'),
  );
  assert.equal(
    explorer.includes('broadcastIconThemeChanged()'),
    false,
    'openExplorer must not push the icon theme at mount either',
  );
  // The three runtime watchers remain — they are the push path that must stay.
  assert.ok(
    source.includes('event.affectsConfiguration(\'workbench.iconTheme\')'),
    'workbench.iconTheme watcher must remain',
  );
  assert.ok(source.includes('onDidChangeActiveColorTheme'), 'color theme watcher must remain');
  assert.ok(source.includes('onDidChange'), 'extensions watcher must remain');
});

test('attachBridge binds a per-webview iconThemeSnapshot callback (pull serves the requesting webview)', () => {
  const source = fs.readFileSync(path.join(SRC, 'extension.ts'), 'utf8');
  assert.match(
    source,
    /iconThemeSnapshot:\s*\(\) => this\.buildIconThemeSnapshotOrNull\(webview\)/,
    'the pull must resolve against the webview that requested it (asWebviewUri is per-webview)',
  );
});
