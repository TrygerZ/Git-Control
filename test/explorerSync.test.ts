/**
 * Explorer sync buttons (P18b), frame 01.
 *
 * Source-level contract, like `explorerHeader.test.ts`: no DOM harness exists, so
 * the component is pinned by the pure model it must route through, the ARIA it
 * must carry, and the store actions it must call. What cannot be asserted here
 * (300 px layout, Dark and Light) is a manual check in the phase file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const COMPONENT = 'src/webview/ExplorerSyncActions.tsx';

test('the group renders inside the Explorer top container, before Help and More', () => {
  const explorer = read('src/webview/ExplorerApp.tsx');
  const sync = explorer.indexOf('<ExplorerSyncActions');
  const header = explorer.indexOf('<ExplorerHeaderActions');
  const top = explorer.indexOf('gc-explorer__top');
  assert.ok(sync > 0, 'the sync group is mounted');
  assert.ok(top > 0 && sync > top, 'inside the P18 top container');
  assert.ok(header > sync, 'left of Help and More, as frame 01 draws it');
});

test('the group is a named group and every button is a real named button', () => {
  const src = read(COMPONENT);
  assert.match(src, /role="group"/, 'a group, not a bare row');
  assert.match(src, /aria-label=\{strings\.groupAria\}/, 'the group is named');
  assert.match(src, /<button\b/, 'real buttons');
  assert.match(src, /aria-label=\{/, 'every button keeps a name');
  assert.match(src, /title=\{/, 'and a reason on hover');
  assert.match(src, /disabled=\{button\.disabled\}/, 'disabled is native, not a class');
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/, 'no raw HTML');
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no colour literal');
});

test('the buttons come from the pure model and send its payloads', () => {
  const src = read(COMPONENT);
  assert.match(src, /deriveSyncActions\(/, 'the rules live in the pure module');
  assert.match(src, /syncActionRequest\(/, 'so does the payload shape');
  assert.match(src, /runAction\(/, 'the existing operation store runs it');
  assert.match(src, /useOperationStore/, 'guard, progress, and toasts behave as in the sidebar');
  assert.doesNotMatch(src, /bridge\.request/, 'no new host request');
});

test('the busy state is announced without stealing the click', () => {
  const src = read(COMPONENT);
  assert.match(src, /aria-busy=\{/, 'the group reports its state');
  assert.match(src, /aria-busy=\{busy\}/, 'bound to the busy flag');
});

test('the remote derivation matches the sidebar rule', () => {
  const src = read(COMPONENT);
  assert.match(src, /status\?\.upstream/, 'upstream prefix first');
  assert.match(src, /firstRemoteName\(/, 'then the first remote-tracking ref');
});

test('no group renders until the first status arrives', () => {
  // D-P18b-2: hidden while `status` is null. The graph refs fallback below must
  // not resurrect the group during the first load, or a Fetch button would draw
  // beside a breadcrumb bar that has not decided what repository it is showing.
  const src = read(COMPONENT);
  const body = src.slice(src.indexOf('export function ExplorerSyncActions'));
  const guard = body.indexOf('status === null');
  const derive = body.indexOf('deriveSyncActions(');
  assert.ok(guard > 0, 'the status guard exists');
  assert.ok(guard < derive, 'and runs before the model is derived');
  assert.match(body.slice(guard, guard + 200), /return null/, 'and it renders nothing');
});

test('the CSS sizes the group from tokens and collapses it at narrow width', () => {
  const css = read('src/webview/styles.css');
  const group = /\.gc-explorer__sync\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(group, /display:\s*flex/, 'a row');
  assert.match(group, /gap:\s*var\(--gc-space-/, 'token spacing');
  const button = /\.gc-explorer__sync__button\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(button, /min-height:\s*var\(--gc-hit\)/, 'honours the hit floor');
  assert.match(button, /font-size:\s*var\(--gc-fs-2xs\)/, 'frame: 12 px label');
  const media = /@media \(max-width: 420px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(media, /\.gc-explorer__sync__label\s*\{[^}]*display:\s*none/, 'label hides at 420 px');
  assert.doesNotMatch(css, /\.gc-explorer__sync[^{]*\{[^}]*#[0-9a-fA-F]{3}/, 'no colour literal');
});

test('the accent button is the Publish state only', () => {
  const css = read('src/webview/styles.css');
  const accent = /\.gc-explorer__sync__button--accent\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(accent, /background:\s*var\(--gc-accent-subtle\)/, 'frame: Publish carries the accent wash');
  assert.match(accent, /color:\s*var\(--gc-accent-primary\)/, 'and the accent text');
});
