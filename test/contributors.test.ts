import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contributorAvatarColor,
  contributorInitials,
  emailHue,
} from '../src/webview/format';
import { useRepoStore } from '../src/webview/store';

test('contributorInitials extracts up to two uppercase characters', () => {
  assert.equal(contributorInitials('Alice'), 'AL');
  assert.equal(contributorInitials('bob'), 'BO');
  assert.equal(contributorInitials('John Doe'), 'JO');
  assert.equal(contributorInitials('X'), 'X');
  assert.equal(contributorInitials('  charlie  '), 'CH');
});

test('contributorInitials handles punctuation and fallback to ?', () => {
  assert.equal(contributorInitials(''), '?');
  assert.equal(contributorInitials('   '), '?');
  assert.equal(contributorInitials('...'), '?');
  assert.equal(contributorInitials('!@#$'), '?');
  assert.equal(contributorInitials('\u202e'), '?');
  assert.equal(contributorInitials('-a-'), 'A');
});

test('emailHue produces deterministic hue in range [0, 359]', () => {
  const h1 = emailHue('dev@example.com');
  const h2 = emailHue('DEV@EXAMPLE.COM');
  const h3 = emailHue('  dev@example.com  ');
  assert.equal(h1, h2);
  assert.equal(h1, h3);
  assert.ok(h1 >= 0 && h1 < 360);

  const emptyHue = emailHue('');
  assert.ok(emptyHue >= 0 && emptyHue < 360);

  const hues = ['alice@git.test', 'bob@git.test', 'carol@git.test'].map(emailHue);
  for (const h of hues) {
    assert.ok(h >= 0 && h < 360);
  }
});

test('contributorAvatarColor returns valid HSL color string', () => {
  const color = contributorAvatarColor('user@example.com');
  const match = /^hsl\((\d+),\s*45%,\s*38%\)$/.exec(color);
  assert.ok(match !== null, `invalid hsl: ${color}`);
  const hue = Number(match[1]);
  assert.ok(hue >= 0 && hue < 360);
});

test('useRepoStore manages contributors state, expansion toggle, and authorFilter', () => {
  const store = useRepoStore.getState();
  assert.equal(store.contributorsExpanded, true);
  assert.equal(store.authorFilter, null);

  store.toggleContributorsExpanded();
  assert.equal(useRepoStore.getState().contributorsExpanded, false);

  store.toggleContributorsExpanded();
  assert.equal(useRepoStore.getState().contributorsExpanded, true);

  store.setAuthorFilter('dev@example.com');
  assert.equal(useRepoStore.getState().authorFilter, 'dev@example.com');

  store.setAuthorFilter(null);
  assert.equal(useRepoStore.getState().authorFilter, null);
});
