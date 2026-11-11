/**
 * Help panel component and wiring (P17).
 *
 * Source-level contract, like `getStartedCard.test.ts`: there is no DOM harness
 * in this repo, so the panel is pinned by the pure models it must route through,
 * the ARIA it must carry, and the places it must be reachable from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { t } from '../src/webview/i18n';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the panel is a section named by its heading, with a real h2', () => {
  const src = read('src/webview/HelpPanel.tsx');
  assert.match(src, /<section\b/, 'the panel is a landmark');
  assert.match(src, /aria-labelledby=\{/, 'named by the heading, not a duplicate string');
  assert.match(src, /<h2\b/);
  assert.match(src, /className="gc-help__title"/);
});

test('the panel routes every row through the pure model and the shortcut data', () => {
  const src = read('src/webview/HelpPanel.tsx');
  assert.match(src, /helpFeatureRows\(/, 'feature rows come from the pure model');
  assert.match(src, /shortcutGroups\(/, 'shortcut groups come from the pure model');
  assert.match(src, /SHIPPED_ROUTES/, 'the capability set is the shipped one');
  assert.match(src, /FEATURES/, 'the checklist gate is the compile-time feature set');
});

test('the tabs are the shared Tablist, driven by the route', () => {
  const src = read('src/webview/HelpPanel.tsx');
  assert.match(src, /<Tablist\b/);
  assert.match(src, /strings\.help\.tabFeatures/);
  assert.match(src, /strings\.help\.tabShortcuts/);
  assert.match(src, /openHelp\(/, 'switching tabs goes through the store action');
  assert.match(src, /route\.tab/, 'the active tab comes from the route, not local state');
  assert.doesNotMatch(src, /useState/, 'the tab is route state, so no local copy can drift');
});

test('feature rows are buttons that open the target view', () => {
  const src = read('src/webview/HelpPanel.tsx');
  assert.match(src, /<button\b/, 'a row is a real button');
  assert.match(src, /strings\.help\.open/, 'the Open word is visible text');
  assert.match(src, /navigateWithFocus\(/, 'Publish carries its focus target');
  assert.match(src, /openExplorer/, 'the graph row opens the Explorer');
  assert.match(src, /navigate\(/, 'every other row navigates');
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no colour literal');
});

test('shortcuts render as a description list of key chips, never as an image', () => {
  const src = read('src/webview/HelpPanel.tsx');
  assert.match(src, /<dl\b/);
  assert.match(src, /<dt\b/);
  assert.match(src, /<dd\b/);
  assert.match(src, /<kbd\b/);
  assert.match(src, /joiner/, 'the joiner is drawn between chips');
});

test('the footer button reopens the checklist and is gated on the capability', () => {
  const src = read('src/webview/HelpPanel.tsx');
  assert.match(src, /reopenChecklist\(/, 'the store action that clears the dismissal');
  assert.match(src, /strings\.help\.showChecklist/);
  assert.match(
    src,
    /available\.has\('checklist'\)|AVAILABLE\.has\('checklist'\)/,
    'the button is gated, not always drawn',
  );
  // It returns the user to the card, which lives in the Changes view.
  assert.match(src, /id: 'changes'/, 'the footer navigates to Changes');
});

test('the help route swaps the repo header for its own and keeps the strip below (frames 105 and 106)', () => {
  // Frame 105 stacks Header (back, title, close), Nav/Wrap, SubTabs, list. The
  // repo header must not survive on help or the strip moves down a whole header.
  const src = read('src/webview/PendingChanges.tsx');
  const shell = src.slice(src.indexOf('return ('));
  assert.match(
    shell,
    /route\.id === 'help' \? \(\s*<HelpHeader \/>\s*\) : \(\s*<SidebarHeader \/>\s*\)/,
    'one header slot, chosen by the route',
  );
  const header = shell.indexOf('<HelpHeader />');
  const strip = shell.indexOf('<NavStrip />');
  const panel = shell.indexOf('<HelpPanel />');
  assert.ok(header > 0 && strip > header && panel > strip, 'header, then strip, then the panel body');
});

test('the panel splits into a header and a body so the strip can sit between them', () => {
  const src = read('src/webview/HelpPanel.tsx');
  assert.match(src, /export function HelpHeader\(\)/, 'the header is its own component');
  assert.match(src, /export function HelpPanel\(\)/, 'the body keeps the panel name');
  const header = src.slice(src.indexOf('export function HelpHeader'), src.indexOf('export function HelpPanel'));
  assert.match(header, /strings\.help\.backAria/, 'back lives in the header');
  assert.match(header, /strings\.help\.closeAria/, 'close lives in the header');
  assert.match(header, /<h2\b/, 'the title is the header heading');
  assert.match(header, /\.focus\(\)/, 'opening still lands on the heading');
  assert.doesNotMatch(header, /<Tablist\b/, 'the tabs belong to the body, below the strip');
  const body = src.slice(src.indexOf('export function HelpPanel'));
  assert.match(body, /<Tablist\b/, 'the body owns the tabs');
});

test('opening moves focus to the heading', () => {
  const src = read('src/webview/HelpPanel.tsx');
  assert.match(src, /\.focus\(\)/, 'focus is moved explicitly');
  assert.match(src, /tabIndex=\{-1\}/, 'the heading is focusable for that move');
  assert.match(src, /closeHelp\(/, 'back and close share one action');
});

test('closing returns focus to the opener only after the repo header is back', () => {
  // Frame 105 swaps the header: while help is open the shell draws `HelpHeader`
  // instead of `SidebarHeader`, so the `[data-help-open]` button is not in the
  // document. A synchronous query from the close handler finds nothing, the
  // optional chain swallows it, and focus falls to `<body>`. The return has to
  // run after the shell re-renders, which is an effect keyed on the route.
  const panel = read('src/webview/HelpPanel.tsx');
  assert.doesNotMatch(
    panel,
    /querySelector<HTMLElement>\('\[data-help-open\]'\)/,
    'the panel cannot reach a button that is unmounted while it is open',
  );
  const shell = read('src/webview/PendingChanges.tsx');
  assert.match(shell, /useEffect\(/, 'the return runs from an effect, after the commit');
  assert.match(
    shell,
    /querySelector<HTMLElement>\('\[data-help-open\]'\)\?\.focus\(\)/,
    'the shell focuses the header button once it is mounted again',
  );
  assert.match(shell, /route\.id !== 'help'/, 'and only on the way out of help');
});
