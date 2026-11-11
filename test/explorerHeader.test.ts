/**
 * Explorer header entry points (P18), frames 01 and 17.
 *
 * Source-level contract, like `helpWiring.test.ts`: no DOM harness exists here, so
 * the header is pinned by the pure model it must route through and the ARIA it
 * must carry. The behaviour that matters (a view opens even when the sidebar was
 * never revealed) is a manual check in the phase file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the header actions render outside ContextBar, which disappears while status is null', () => {
  const src = read('src/webview/ExplorerApp.tsx');
  assert.match(src, /<ExplorerHeaderActions\b/, 'the actions are their own component');
  const actions = src.indexOf('<ExplorerHeaderActions');
  const context = src.indexOf('<ContextBar');
  assert.ok(actions > 0, 'the actions are mounted');
  assert.ok(context > 0, 'the context bar is still drawn');
  // They share one top container so the actions cannot be lost with the crumbs.
  const top = src.indexOf('gc-explorer__top');
  assert.ok(top > 0 && top < context, 'the top container wraps both');
  assert.match(
    src.slice(top, context + 200),
    /<ContextBar[\s\S]{0,400}<ExplorerHeaderActions|<ExplorerHeaderActions[\s\S]{0,400}<ContextBar/,
    'both live inside the top container',
  );
});

test('the help button and the more button are real named buttons', () => {
  const src = read('src/webview/ExplorerHeaderActions.tsx');
  assert.match(src, /<button\b/, 'real buttons, not divs');
  assert.match(src, /aria-label=\{strings\.explorerMenu\.moreAria\}/, 'the more button is named');
  assert.match(src, /aria-haspopup="menu"/);
  assert.match(src, /aria-expanded=\{/, 'the trigger reports its state');
  assert.match(src, /aria-label=\{strings\.help\.openAria\}/, 'the help button reuses the P17 name');
  assert.match(src, /<Icon name="info" \/>/, 'frame 01 draws an info glyph');
  assert.match(src, /<Icon name="ellipsis" \/>/, 'and an ellipsis');
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
});

test('the menu is the shared gc-menu pattern with menuitem rows and a group label', () => {
  const src = read('src/webview/ExplorerHeaderActions.tsx');
  assert.match(src, /className="gc-menu"/, 'same look as the commit menu');
  assert.match(src, /role="menu"/);
  assert.match(src, /role="menuitem"/);
  assert.match(src, /role="group"/);
  // Esc closes and returns focus to the trigger, exactly as the commit menu does.
  for (const key of ['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab']) {
    assert.match(src, new RegExp(`case '${key}'`), `${key} is handled`);
  }
  assert.match(src, /querySelector<HTMLElement>\(|\.focus\(\)/, 'focus moves back to the trigger');
});

test('every menu row routes through the pure model and the store actions', () => {
  const src = read('src/webview/ExplorerHeaderActions.tsx');
  assert.match(src, /buildMoreMenu\(/, 'the rows come from the pure model');
  assert.match(src, /SHIPPED_ROUTES/, 'the capability set is the shipped one');
  assert.match(src, /actions\/openSidebarView/, 'view rows reveal the sidebar');
  assert.match(src, /actions\/pickRepository/, 'Pick repository goes through the host');
  assert.match(src, /actions\/openQuickActions/, 'Quick actions opens the palette');
  assert.match(src, /useRepoStore\.getState\(\)\.refresh\(\)/, 'Refresh graph reloads');
  assert.match(src, /showLogs\(\)/, 'Show Git output reveals the channel');
  assert.match(src, /\.connect\(\)/, 'Connect GitHub uses the existing request');
  assert.match(src, /\.disconnect\(\)/, 'Disconnect GitHub uses the existing request');
});

test('the first open loads GitHub, guarded by the open edge and the auth state', () => {
  // The guard is the whole contract: an unguarded `load()` would fire on mount
  // (the Explorer already loads this slice there) and again on every re-render.
  // So the effect must (a) depend on the open flag, (b) compare against the
  // previous value, and (c) test `auth === null` before requesting.
  const src = read('src/webview/ExplorerHeaderActions.tsx');
  const start = src.indexOf('const wasOpen');
  assert.ok(start > 0, 'the guard ref exists');
  const effect = src.slice(start, src.indexOf('useLayoutEffect', start));
  assert.match(effect, /useEffect\(/, 'it runs from an effect');
  assert.match(effect, /\[open\]/, 'keyed on the open flag, not on mount');
  assert.match(effect, /!wasOpen\.current/, 'only on the closed-to-open edge');
  assert.match(effect, /auth === null/, 'and only while the slice is unknown');
  assert.match(effect, /\.load\(\)/, 'the menu pulls the GitHub slice');
  assert.match(effect, /wasOpen\.current = open/, 'the previous value is recorded every run');
});

test('the Changes count comes from a slice the Explorer actually loads', () => {
  // The sidebar badge reads `useChangesStore`, which the Pending Changes document
  // fills. The Explorer never mounts that document and never calls its `load`, so
  // reading it here would always report 0 while the badge showed the real number.
  // The Explorer already holds the same `repos/status` payload in `useRepoStore`.
  const src = read('src/webview/ExplorerHeaderActions.tsx');
  assert.doesNotMatch(src, /useChangesStore/, 'the Explorer document never loads that store');
  assert.match(src, /status\?\.changes\.length/, 'the count comes from the status payload');
  const explorer = read('src/webview/ExplorerApp.tsx');
  assert.match(explorer, /refresh\(\)/, 'and that payload is refreshed on mount and on repo change');
});

test('the menu count is formatted by the same helper the nav badge uses', () => {
  // Acceptance criterion 5: the menu number equals the badge for the same state.
  // The badge hides zero and caps at 99+, so a raw `String(count)` would show "0"
  // where the strip shows nothing, and "128" where it shows "99+".
  const src = read('src/webview/ExplorerHeaderActions.tsx');
  assert.match(src, /formatBadge/, 'Changes reuses the nav badge formatter');
  assert.match(src, /badgeCount/, 'Pull requests reuses the PR page-cap formatter');
});

test('the explorer menu strings exist in both languages with the same keys', () => {
  const en = read('src/webview/i18n.en.ts');
  const id = read('src/webview/i18n.id.ts');
  const ns = /explorerMenu: \{([\s\S]*?)\n  \},/;
  const enBlock = en.match(ns)?.[1] ?? '';
  const idBlock = id.match(ns)?.[1] ?? '';
  assert.ok(enBlock.length > 0, 'en has the namespace');
  assert.ok(idBlock.length > 0, 'id has the namespace');
  const keys = (block: string): string[] =>
    [...block.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1] ?? '').sort();
  assert.deepEqual(keys(enBlock), keys(idBlock), 'same keys in both catalogs');
});

test('the Explorer still imports no GitHubPanel', () => {
  const src = read('src/webview/ExplorerApp.tsx');
  assert.doesNotMatch(src, /GitHubPanel/);
  assert.equal(fs.existsSync(path.join(ROOT, 'src/webview/GitHubPanel.tsx')), false);
});

test('no Ctrl K hint exists anywhere in src, as before', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /Ctrl\s*\+?\s*K\b(?!\s*G)/i, `${file} mentions Ctrl K`);
  }
});
