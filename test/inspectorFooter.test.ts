/**
 * Inspector footer actions (frame 01, node `9:179`).
 *
 * The frame closes the panel with a 57 px bar: `Checkout` as the filled accent
 * button, `Branch here` as the quiet one, and the overflow icon. The app renders
 * both as quiet buttons, so the primary action of the panel reads as secondary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

const APP = 'src/webview/ExplorerApp.tsx';
const CSS = 'src/webview/styles.css';

test('Checkout is the filled accent button and Branch here is the quiet one', () => {
  const src = read(APP);
  const bar = src.slice(src.indexOf('gc-explorer__aside-actions'), src.indexOf('NodeContextMenu'));
  const checkoutAt = bar.indexOf('strings.inspector.actionCheckout');
  const branchAt = bar.indexOf('strings.inspector.actionBranchHere');
  assert.ok(checkoutAt > 0 && branchAt > checkoutAt, 'Checkout comes first, as the frame orders it');

  const checkoutButton = bar.slice(0, checkoutAt);
  assert.match(
    checkoutButton,
    /gc-button--primary|gc-button--accent|gc-button--solid/,
    'Checkout carries the frame accent',
  );
  const branchButton = bar.slice(checkoutAt, branchAt);
  assert.match(branchButton, /gc-button--quiet/, 'Branch here stays quiet');
});

test('the accent variant exists and is built from tokens', () => {
  const css = read(CSS);
  const rule = css.match(/\.gc-button--primary\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(rule.length > 0, 'the primary variant has a rule');
  assert.match(rule, /background:\s*var\(--/, 'a filled button from a token');
  assert.match(rule, /color:\s*var\(--/, 'and its foreground');
  assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}/, 'no literal colour');
});
