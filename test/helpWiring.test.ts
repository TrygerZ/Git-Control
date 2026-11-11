/**
 * Help wiring: header button, shell mount, styles, and the command (P17).
 *
 * Source-level contract, like `getStartedCard.test.ts`: no DOM harness exists in
 * this repo, so the reachability of the panel is pinned at the source level.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { t } from '../src/webview/i18n';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the header info button is wired and keeps its catalog names', () => {
  const src = read('src/webview/SidebarHeader.tsx');
  assert.match(src, /strings\.help\.openAria/);
  assert.match(src, /strings\.help\.openTitle/);
  assert.match(src, /openHelp\(/);
  assert.match(src, /data-help-open/, 'the button is the focus return target');
  assert.match(src, /<Icon name="info" \/>/, 'the frame draws an info glyph');
  // The button lives in the title row, after the search button and before the graph.
  const search = src.indexOf('strings.palette.openAria');
  const help = src.indexOf('strings.help.openAria');
  const graph = src.indexOf('strings.pending.openGraphAria');
  assert.ok(search > 0 && help > search && graph > help, 'title row order: search, help, graph');
});

test('the shell draws the panel for the help route and no sub-tabs there', () => {
  const src = read('src/webview/PendingChanges.tsx');
  assert.match(src, /route\.id === 'help' \? \(\s*<HelpPanel \/>/, 'the panel takes the body');
  assert.match(src, /'help'/, 'the sub-tab list knows the route has none');
  // The toast region stays mounted on every route that is not Changes.
  const toast = src.indexOf("route.id === 'prs' || route.id === 'issues'");
  assert.ok(toast > 0, 'the non-Changes toast region exists');
  assert.match(src.slice(toast, toast + 260), /'help'/, 'help gets a live region too');
});

test('Help is not a nav strip destination: it opens from the header, not the strip', () => {
  const src = read('src/webview/NavStrip.tsx');
  assert.doesNotMatch(src, /id: 'help'/, 'the strip keeps its five destinations');
});

test('the help styles are token-only and size the rows from the hit-area floor', () => {
  const css = read('src/webview/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const selector of ['.gc-help {', '.gc-help__row', '.gc-help__footer', '.gc-kbd']) {
    assert.ok(css.includes(selector), `${selector} is missing`);
  }
  assert.match(css, /\.gc-help__row[^{]*\{[^}]*min-height:\s*var\(--gc-hit\)/, 'rows meet the target size');
  assert.match(css, /\.gc-kbd[^{]*\{[^}]*font-size:\s*var\(--gc-fs-2xs\)/, 'chips use the type scale');
  const block = css.slice(css.indexOf('.gc-help {'));
  assert.doesNotMatch(block.slice(0, 4000), /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no colour literal');
});

test('the help catalog namespace carries the panel copy in both languages', () => {
  const en = t('en').help as Record<string, unknown>;
  const id = t('id').help as Record<string, unknown>;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(id).sort());
  assert.equal(en.title, 'Help and shortcuts');
  assert.equal(id.title, 'Bantuan dan pintasan');
  assert.equal(en.tabFeatures, 'Features');
  assert.equal(id.tabFeatures, 'Fitur');
  assert.equal(en.tabShortcuts, 'Shortcuts');
  assert.equal(id.tabShortcuts, 'Pintasan');
  assert.equal(en.open, 'Open');
  assert.equal(id.open, 'Buka');
  assert.equal(en.groupEveryday, 'Everyday');
  assert.equal(id.groupEveryday, 'Sehari-hari');
  assert.equal(en.groupGithub, 'With GitHub');
  assert.equal(id.groupGithub, 'Dengan GitHub');
  assert.equal(en.groupOrganize, 'Organize');
  assert.equal(id.groupOrganize, 'Mengatur');
  assert.equal(en.gGraph, 'Commit graph');
  assert.equal(id.gGraph, 'Grafik commit');
  assert.equal(en.showChecklist, 'Show the Get started checklist again');
  assert.equal(id.showChecklist, 'Tampilkan lagi panduan langkah awal');
  assert.equal(en.or, 'or');
  assert.equal(id.or, 'atau');
  assert.equal(en.openAria, 'Open help and shortcuts');
  assert.equal(id.openAria, 'Buka bantuan dan pintasan');
  assert.equal(en.backAria, 'Back');
  assert.equal(id.backAria, 'Kembali');
  assert.equal(en.closeAria, 'Close help');
  assert.equal(id.closeAria, 'Tutup bantuan');
});

test('the open help command is declared and registered', () => {
  const manifest = JSON.parse(read('package.json')) as {
    contributes?: { commands?: Array<{ command?: string; title?: string }> };
  };
  const command = (manifest.contributes?.commands ?? []).find((c) => c.command === 'gitControl.openHelp');
  assert.ok(command !== undefined, 'gitControl.openHelp must be contributed');
  assert.equal(command.title, 'Git Control: Help and Shortcuts');

  const host = read('src/extension.ts');
  assert.match(host, /register\('gitControl\.openHelp'/, 'the command is registered');
  assert.match(host, /gitControl\.openHelp'[\s\S]{0,120}navigate\(\{\s*id:\s*'help'/, 'it opens the help route');
});

test('the palette offers the Help row once the route exists', () => {
  const src = read('src/quickActions.ts');
  assert.match(src, /help\.open/, 'the row id ships with the route');
  assert.match(src, /available\.has\('help'\)/, 'gated on the route, like every go row');
  const host = read('src/extension.ts');
  assert.match(host, /SHIPPED_ROUTES,[^)]*'help'/, 'the host advertises the route it now serves');
});

test('the integration suite runs the new command against a real repository', () => {
  const src = read('test/integration-suite.js');
  assert.match(src, /gitControl\.openHelp/, 'the command is exercised in the live host');
});
