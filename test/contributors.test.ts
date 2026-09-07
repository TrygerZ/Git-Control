import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contributorActionKind,
  contributorAvatarColor,
  contributorInitials,
  emailHue,
  resolveContributorAvatar,
} from '../src/webview/format';
import { useRepoStore } from '../src/webview/store';
import { bridge } from '../src/webview/bridge';
import type { RequestKind, RequestPayload, ResponseData } from '../src/messages';

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

test('resolveContributorAvatar returns avatarUrl or null on failure/absence', () => {
  assert.equal(
    resolveContributorAvatar('https://avatars.githubusercontent.com/u/1', false),
    'https://avatars.githubusercontent.com/u/1',
  );
  assert.equal(
    resolveContributorAvatar('https://avatars.githubusercontent.com/u/1', true),
    null,
  );
  assert.equal(resolveContributorAvatar(null, false), null);
  assert.equal(resolveContributorAvatar(undefined, false), null);
  assert.equal(resolveContributorAvatar('', false), null);
});

test('contributorActionKind differentiates GitHub profile open from author filter', () => {
  assert.equal(
    contributorActionKind('dev@example.com', {
      login: 'alice',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      htmlUrl: 'https://github.com/alice',
    }),
    'profile',
  );
  assert.equal(
    contributorActionKind('dev@example.com', {
      login: null,
      avatarUrl: null,
      htmlUrl: null,
    }),
    'filter',
  );
  assert.equal(contributorActionKind('dev@example.com', null), 'filter');
  assert.equal(contributorActionKind('dev@example.com', undefined), 'profile');
  assert.equal(contributorActionKind('', undefined), 'filter');
  assert.equal(contributorActionKind(undefined, undefined), 'filter');
  assert.equal(contributorActionKind('   ', undefined), 'filter');
});

test('useRepoStore handles contributor identity fetching and caching', async (t) => {
  const originalRequest = bridge.request;
  const calls: string[] = [];
  bridge.request = (async <K extends RequestKind>(kind: K, payload: RequestPayload<K>): Promise<ResponseData<K>> => {
    if (kind === 'github/contributorIdentity') {
      const email = (payload as { email: string }).email;
      calls.push(email);
      if (email === 'user@example.com') {
        return {
          login: 'octocat',
          avatarUrl: 'https://avatars.githubusercontent.com/u/1',
          htmlUrl: 'https://github.com/octocat',
        } as ResponseData<K>;
      }
      throw new Error('Not found');
    }
    return originalRequest(kind, payload);
  }) as typeof bridge.request;

  t.after(() => {
    bridge.request = originalRequest;
  });

  const store = useRepoStore.getState();

  // Empty email returns null without calling bridge
  const nullResult = await store.loadContributorIdentity('   ');
  assert.equal(nullResult, null);
  assert.equal(calls.length, 0);

  // First fetch succeeds
  const identity = await store.loadContributorIdentity('user@example.com');
  assert.deepEqual(identity, {
    login: 'octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1',
    htmlUrl: 'https://github.com/octocat',
  });
  assert.equal(calls.length, 1);

  // Second fetch hits cache without bridge call
  const cached = await store.loadContributorIdentity('user@example.com');
  assert.deepEqual(cached, identity);
  assert.equal(calls.length, 1);

  // Failed fetch records fallback and returns fallback
  const failed = await store.loadContributorIdentity('unknown@example.com');
  assert.deepEqual(failed, { login: null, avatarUrl: null, htmlUrl: null });
  assert.equal(calls.length, 2);

  // Cached fallback avoids re-fetching
  const cachedFailed = await store.loadContributorIdentity('unknown@example.com');
  assert.deepEqual(cachedFailed, { login: null, avatarUrl: null, htmlUrl: null });
  assert.equal(calls.length, 2);
});
