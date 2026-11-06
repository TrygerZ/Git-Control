/**
 * Roving-focus key model for the PR list (P07).
 *
 * The list is one `ul` of buttons with a single tab stop, so the arrow keys are
 * the only way to reach the other rows. Issues (P08) and Actions (P13) reuse it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextIndex } from '../src/webview/listNav';

test('ArrowDown and ArrowUp move one row and clamp at the ends', () => {
  assert.equal(nextIndex('ArrowDown', 0, 3), 1);
  assert.equal(nextIndex('ArrowDown', 2, 3), 2, 'clamped, not wrapped');
  assert.equal(nextIndex('ArrowUp', 2, 3), 1);
  assert.equal(nextIndex('ArrowUp', 0, 3), 0);
});

test('Home and End jump to the ends', () => {
  assert.equal(nextIndex('Home', 2, 5), 0);
  assert.equal(nextIndex('End', 0, 5), 4);
});

test('an empty list returns -1 for every key', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    assert.equal(nextIndex(key, 0, 0), -1, key);
  }
});

test('any other key returns -1 so the caller leaves the event alone', () => {
  for (const key of ['Tab', 'Enter', ' ', 'a', 'PageDown', '']) {
    assert.equal(nextIndex(key, 1, 3), -1, key);
  }
});
