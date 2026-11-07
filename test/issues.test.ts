/**
 * Issue list helpers (P08).
 *
 * Pure only: the host narrows by assignee/creator/mentioned and caps the payload,
 * so what is left to pin is the client-side label and text narrowing plus the
 * excerpt rule that keeps an untrusted body readable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterIssues, labelOptions, matchesText } from '../src/webview/issueFilters';
import { EXCERPT_MAX, issueExcerpt } from '../src/webview/issueText';
import type { IssueInfo, IssueLabel } from '../src/messages';

function label(name: string): IssueLabel {
  return { name, colorKey: 'gray' };
}

function issue(over: Partial<IssueInfo> & { number: number }): IssueInfo {
  return {
    title: `Issue ${over.number}`,
    state: 'open',
    stateReason: null,
    url: `https://github.com/o/r/issues/${over.number}`,
    author: 'someone',
    assignees: [],
    labels: [],
    comments: 0,
    bodyExcerpt: '',
    updatedAt: '2026-11-01T00:00:00Z',
    closedAt: null,
    ...over,
  };
}

// ------------------------------------------------------------------- filters

test('filterIssues narrows by exact label name and by text at once', () => {
  const rows = [
    issue({ number: 1, title: 'Crash on start', labels: [label('bug')] }),
    issue({ number: 2, title: 'Crash on save', labels: [label('bug'), label('auth')] }),
    issue({ number: 3, title: 'Docs typo', labels: [label('docs')] }),
  ];
  assert.deepEqual(
    filterIssues(rows, { label: 'bug', query: '' }).map((i) => i.number),
    [1, 2],
  );
  assert.deepEqual(
    filterIssues(rows, { label: 'bug', query: 'save' }).map((i) => i.number),
    [2],
  );
  assert.deepEqual(
    filterIssues(rows, { label: null, query: 'crash' }).map((i) => i.number),
    [1, 2],
  );
  assert.deepEqual(filterIssues(rows, { label: 'missing', query: '' }), []);
});

test('filterIssues treats an empty query as "no text filter"', () => {
  const rows = [issue({ number: 7 })];
  assert.deepEqual(filterIssues(rows, { label: null, query: '   ' }).map((i) => i.number), [7]);
});

test('labelOptions counts, orders by count then name, and caps', () => {
  const rows = [
    issue({ number: 1, labels: [label('bug'), label('auth')] }),
    issue({ number: 2, labels: [label('bug')] }),
    issue({ number: 3, labels: [label('auth'), label('docs')] }),
  ];
  assert.deepEqual(labelOptions(rows), [
    { name: 'auth', count: 2 },
    { name: 'bug', count: 2 },
    { name: 'docs', count: 1 },
  ]);
  assert.equal(labelOptions(rows, 2).length, 2, 'the cap is honoured');
  assert.deepEqual(labelOptions([]), []);
  // A name appearing twice on one issue still counts once for that issue.
  assert.deepEqual(labelOptions([issue({ number: 9, labels: [label('x'), label('x')] })]), [
    { name: 'x', count: 1 },
  ]);
});

test('matchesText covers title, number, label name, and author', () => {
  const row = issue({ number: 97, title: 'Login fails', author: 'octocat', labels: [label('auth')] });
  for (const query of ['login', 'LOGIN', '#97', '97', 'auth', 'octocat']) {
    assert.equal(matchesText(row, query), true, query);
  }
  assert.equal(matchesText(row, 'nothing'), false);
  assert.equal(matchesText(row, ''), true);
});

// ------------------------------------------------------------------- excerpt

test('issueExcerpt collapses whitespace and keeps markup as visible text', () => {
  assert.equal(issueExcerpt('  a\n\n\tb   c  '), 'a b c');
  // The tags are data, not markup: React escapes them at the render site and the
  // reader must see them, because a body that claims to be HTML is still a body.
  assert.equal(issueExcerpt('<script>alert(1)</script> hi'), '<script>alert(1)</script> hi');
});

test('issueExcerpt strips control, zero-width, and bidi characters', () => {
  assert.equal(issueExcerpt('a\u0000b​c‮d'), 'a�b�c�d');
  assert.equal(issueExcerpt('safe'), 'safe');
});

test('issueExcerpt handles null, empty, and the length cap', () => {
  assert.equal(issueExcerpt(null), '');
  assert.equal(issueExcerpt(''), '');
  assert.equal(issueExcerpt('   '), '');
  const long = 'x'.repeat(EXCERPT_MAX + 50);
  const cut = issueExcerpt(long);
  assert.equal(cut.length, EXCERPT_MAX);
  assert.ok(cut.endsWith('…'), 'a truncation says so');
  const exact = 'y'.repeat(EXCERPT_MAX);
  assert.equal(issueExcerpt(exact), exact, 'no ellipsis when nothing was cut');
  assert.equal(issueExcerpt('abcdef', 4), 'abc…', 'a custom cap is honoured');
});
