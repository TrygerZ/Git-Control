import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FOCUSABLE_SELECTOR, trapTabTarget } from '../src/webview/focusTrap';

test('trapTabTarget: Shift+Tab on the first item wraps to the last', () => {
  assert.equal(trapTabTarget(3, 0, true), 2);
});

test('trapTabTarget: Tab on the last item wraps to the first', () => {
  assert.equal(trapTabTarget(3, 2, false), 0);
});

test('trapTabTarget: middle and non-edge moves stay native', () => {
  assert.equal(trapTabTarget(3, 1, false), null);
  assert.equal(trapTabTarget(3, 1, true), null);
  assert.equal(trapTabTarget(3, 0, false), null);
  assert.equal(trapTabTarget(3, 2, true), null);
});

test('trapTabTarget: single item wraps onto itself both ways', () => {
  assert.equal(trapTabTarget(1, 0, true), 0);
  assert.equal(trapTabTarget(1, 0, false), 0);
});

test('trapTabTarget: empty list and focus outside the list return null', () => {
  assert.equal(trapTabTarget(0, -1, false), null);
  assert.equal(trapTabTarget(3, -1, false), null);
  assert.equal(trapTabTarget(3, -1, true), null);
});

test('FOCUSABLE_SELECTOR skips disabled controls and keeps tabindex opt-outs out', () => {
  assert.ok(FOCUSABLE_SELECTOR.includes('select:not([disabled])'));
  assert.ok(FOCUSABLE_SELECTOR.includes('button:not([disabled])'));
  assert.ok(FOCUSABLE_SELECTOR.includes('textarea'));
  assert.ok(FOCUSABLE_SELECTOR.includes('[tabindex]:not([tabindex="-1"])'));
});

test('dialogs use the shared hook and keep no inline trap or local selector', () => {
  for (const file of ['GuardDialog.tsx', 'MergeDialog.tsx', 'PromptDialog.tsx']) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'webview', file), 'utf8');
    assert.match(source, /useDialogFocusTrap\(/, `${file} must call useDialogFocusTrap`);
    assert.doesNotMatch(source, /const FOCUSABLE\b/, `${file} must not define a local FOCUSABLE`);
    assert.doesNotMatch(source, /querySelectorAll<HTMLElement>\(FOCUSABLE\)/, `${file} must not hand-roll the trap`);
  }
});
