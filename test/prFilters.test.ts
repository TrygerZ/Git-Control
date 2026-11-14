/**
 * Pull request filters and grouping (P07).
 *
 * The chips, the text filter, and the three groups all read the same array the
 * list renders, so a filter that disagreed with the badge would be visible.
 * These cases pin the partition and the count source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PR_PAGE_SIZE,
  badgeCount,
  countByFilter,
  filterPullRequests,
  groupPullRequests,
  matchesText,
} from '../src/webview/prFilters';
import type { PullRequestInfo } from '../src/messages';

function pr(over: Partial<PullRequestInfo> & { number: number }): PullRequestInfo {
  return {
    title: `PR ${over.number}`,
    state: 'open',
    url: `https://github.com/o/r/pull/${over.number}`,
    headRef: 'feat/a',
    baseRef: 'main',
    draft: false,
    author: 'someone',
    updatedAt: '2026-11-01T00:00:00Z',
    requestedReviewers: [],
    headRepo: 'o/r',
    isFork: false,
    maintainerCanModify: true,
    ...over,
  };
}

const MINE = pr({ number: 1, author: 'me', title: 'Rebalance row inset' });
const REVIEW = pr({
  number: 2,
  author: 'other',
  requestedReviewers: ['Me'],
  title: 'Cull graph nodes',
  headRef: 'fix/graph-edges',
});
const DRAFT = pr({ number: 3, author: 'me', draft: true, title: 'WIP lane reuse' });
const CLOSED = pr({ number: 4, author: 'other', state: 'closed', title: 'Dispose menus' });

const ALL = [MINE, REVIEW, DRAFT, CLOSED] as const;
const CTX = { viewerLogin: 'me' };

test('each chip selects what its label promises', () => {
  assert.deepEqual(
    filterPullRequests(ALL, 'open', CTX).map((p) => p.number),
    [1, 2, 3],
    'merged and closed rows are not open',
  );
  assert.deepEqual(
    filterPullRequests(ALL, 'review-requested', CTX).map((p) => p.number),
    [2],
  );
  assert.deepEqual(
    filterPullRequests(ALL, 'mine', CTX).map((p) => p.number),
    [1, 3],
  );
  assert.deepEqual(
    filterPullRequests(ALL, 'draft', CTX).map((p) => p.number),
    [3],
  );
});

test('review matching is case-insensitive on the login', () => {
  assert.deepEqual(
    filterPullRequests([REVIEW], 'review-requested', { viewerLogin: 'ME' }).map((p) => p.number),
    [2],
  );
});

test('a viewer who is not signed in matches nothing personal', () => {
  const anon = { viewerLogin: null };
  assert.deepEqual(filterPullRequests(ALL, 'mine', anon), []);
  assert.deepEqual(filterPullRequests(ALL, 'review-requested', anon), []);
});

test('countByFilter reads the same array the list renders', () => {
  assert.deepEqual(countByFilter(ALL, CTX), { open: 3, 'review-requested': 1, mine: 2, draft: 1 });
  assert.deepEqual(countByFilter(ALL, { viewerLogin: null }), {
    open: 3,
    'review-requested': 0,
    mine: 0,
    draft: 1,
  });
});

test('groups partition the input and a draft never lands in needs-review', () => {
  const groups = groupPullRequests(ALL, CTX);
  assert.deepEqual(groups.needsReview.map((p: PullRequestInfo) => p.number), [2]);
  assert.deepEqual(groups.mine.map((p: PullRequestInfo) => p.number), [1, 3]);
  assert.deepEqual(groups.other.map((p: PullRequestInfo) => p.number), [4]);
  const total = groups.needsReview.length + groups.mine.length + groups.other.length;
  assert.equal(total, ALL.length);
  assert.deepEqual(
    groupPullRequests([DRAFT], { viewerLogin: 'me' }).needsReview,
    [],
    'a draft never needs your review',
  );
});

test('matchesText searches title, number with or without a hash, author, and branch', () => {
  assert.equal(matchesText(REVIEW, 'cull'), true);
  assert.equal(matchesText(REVIEW, 'CULL'), true, 'case-insensitive');
  assert.equal(matchesText(REVIEW, '#2'), true);
  assert.equal(matchesText(REVIEW, '2'), true);
  assert.equal(matchesText(REVIEW, 'other'), true);
  assert.equal(matchesText(REVIEW, 'graph-edges'), true);
  assert.equal(matchesText(REVIEW, 'main'), true);
  assert.equal(matchesText(REVIEW, 'nothing here'), false);
  assert.equal(matchesText(REVIEW, '   '), true, 'a blank needle matches everything');
});

test('the nav badge caps at the page size and hides zero', () => {
  assert.equal(PR_PAGE_SIZE, 50);
  assert.equal(badgeCount(0, PR_PAGE_SIZE), null);
  assert.equal(badgeCount(12, PR_PAGE_SIZE), '12');
  assert.equal(badgeCount(49, PR_PAGE_SIZE), '49');
  assert.equal(badgeCount(50, PR_PAGE_SIZE), '50+', 'a full page may hide more');
  assert.equal(badgeCount(120, PR_PAGE_SIZE), '50+');
});
