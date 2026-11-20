/**
 * Issue list helpers (P08).
 *
 * Pure only: the host narrows by assignee/creator/mentioned and caps the payload,
 * so what is left to pin is the client-side label and text narrowing plus the
 * excerpt rule that keeps an untrusted body readable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyIssueMutation,
  canCreateIssue,
  canSubmitComment,
  filterIssues,
  issueCommand,
  labelChipTone,
  labelOptions,
  matchesText,
  sanitizeLabelColor,
} from '../src/webview/issueFilters';
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

// ------------------------------------------------------------ write model (P26)

test('canSubmitComment accepts 1..65536 trimmed characters without NUL', () => {
  assert.equal(canSubmitComment('Looks good.'), true);
  assert.equal(canSubmitComment('  trimmed  '), true);
  assert.equal(canSubmitComment('a'.repeat(65_536)), true);
  assert.equal(canSubmitComment(''), false);
  assert.equal(canSubmitComment('   \n\t  '), false);
  assert.equal(canSubmitComment('a'.repeat(65_537)), false);
  assert.equal(canSubmitComment('has\u0000nul'), false);
});

test('canCreateIssue checks title, description body, and label list bounds', () => {
  assert.equal(
    canCreateIssue({ title: 'Lane gutter push state', body: 'Details here', labels: ['bug', 'ui'] }),
    true,
  );
  assert.equal(canCreateIssue({ title: 'Minimal', body: '', labels: [] }), true);
  assert.equal(canCreateIssue({ title: '   ', body: 'Details', labels: [] }), false, 'empty title');
  assert.equal(canCreateIssue({ title: 'a'.repeat(257), body: '', labels: [] }), false, 'oversized title');
  assert.equal(canCreateIssue({ title: 'line\nbreak', body: '', labels: [] }), false, 'control char in title');
  assert.equal(canCreateIssue({ title: 'Valid', body: 'a'.repeat(65_537), labels: [] }), false, 'oversized body');
  assert.equal(canCreateIssue({ title: 'Valid', body: 'a\u0000b', labels: [] }), false, 'NUL in body');
  assert.equal(
    canCreateIssue({
      title: 'Valid',
      body: '',
      labels: Array.from({ length: 11 }, (_, i) => `l${i}`),
    }),
    false,
    'more than 10 labels',
  );
  assert.equal(
    canCreateIssue({ title: 'Valid', body: '', labels: ['bug', 'bug'] }),
    false,
    'duplicate labels',
  );
});

test('issueCommand formats and sanitizes POST /repos/{owner}/{repo}/issues', () => {
  assert.equal(issueCommand('TrygerZ', 'git-control'), 'POST /repos/TrygerZ/git-control/issues');
  assert.equal(issueCommand('o\u202e', 'r\u0000'), 'POST /repos/o\ufffd/r\ufffd/issues');
});

test('applyIssueMutation moves the item between open and closed partitions and updates counts', () => {
  const initial = [
    issue({ number: 97, state: 'open' }),
    issue({ number: 98, state: 'open' }),
    issue({ number: 90, state: 'closed', stateReason: 'completed' }),
  ];

  const afterClose = applyIssueMutation(initial, { number: 97, state: 'closed' });
  const openAfterClose = afterClose.filter((i) => i.state === 'open');
  const closedAfterClose = afterClose.filter((i) => i.state === 'closed');
  assert.deepEqual(openAfterClose.map((i) => i.number), [98], 'open count drops from 2 to 1');
  assert.deepEqual(closedAfterClose.map((i) => i.number), [97, 90], '#97 moves to the top of closed');
  assert.equal(closedAfterClose[0]?.stateReason, 'completed');

  const afterReopen = applyIssueMutation(afterClose, { number: 97, state: 'open' });
  const openAfterReopen = afterReopen.filter((i) => i.state === 'open');
  const closedAfterReopen = afterReopen.filter((i) => i.state === 'closed');
  assert.deepEqual(openAfterReopen.map((i) => i.number), [97, 98], '#97 returns to the top of open');
  assert.deepEqual(closedAfterReopen.map((i) => i.number), [90], 'closed count returns to 1');
  assert.equal(openAfterReopen[0]?.stateReason, 'reopened');
  assert.equal(openAfterReopen[0]?.closedAt, null);

  // Unknown issue number leaves the list unchanged.
  const untouched = applyIssueMutation(initial, { number: 999, state: 'closed' });
  assert.deepEqual(untouched.map((i) => i.number), [97, 98, 90]);
});

test('sanitizeLabelColor and labelChipTone fall back to neutral on hostile label colors', () => {
  assert.equal(sanitizeLabelColor('d73a4a'), '#d73a4a');
  assert.equal(sanitizeLabelColor('#0E8A16'), '#0e8a16');
  for (const hostile of [
    '',
    'red',
    '#fff',
    'd73a4a; background:url(javascript:alert(1))',
    'expression(alert(1))',
    '</style><script>alert(1)</script>',
    null,
    undefined,
    123,
  ]) {
    assert.equal(sanitizeLabelColor(hostile), null, String(hostile));
  }

  assert.equal(labelChipTone({ colorKey: 'red' }), 'red');
  assert.equal(labelChipTone({ colorKey: 'purple' }), 'purple');
  assert.equal(labelChipTone({ colorKey: 'red; color: yellow' as never }), 'gray');
  assert.equal(labelChipTone({}), 'gray');
});
