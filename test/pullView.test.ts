/**
 * P24 pure view model.
 *
 * These functions decide what the PR detail panel says before any component
 * renders it: the merge box status lines, the tab counts, the file summary, and
 * the exact `actions/openDiff` payload a file row sends. Everything here is
 * data-in/data-out, so a wrong answer is a wrong panel with no DOM in the way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampText,
  diffRequest,
  fileTotals,
  groupChecks,
  statusLines,
  tabCounts,
} from '../src/webview/pullView';
import type { CheckRunInfo, CheckSummary, PullDetail, PullFile, TimelineItem } from '../src/messages';

function detail(overrides: Partial<PullDetail> = {}): PullDetail {
  return {
    number: 150,
    title: 'Rebalance change row content inset to 8px',
    state: 'open',
    draft: false,
    author: 'TrygerZ',
    authorAvatarUrl: null,
    headRef: 'fix/ui-review-polish',
    baseRef: 'main',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    commits: 2,
    additions: 84,
    deletions: 15,
    changedFiles: 3,
    mergeableState: 'clean',
    htmlUrl: 'https://github.com/o/r/pull/150',
    body: 'Change rows used a 12px inset.',
    createdAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T03:00:00Z',
    mergedAt: null,
    reviewers: [],
    approvedBy: [],
    changesRequestedBy: [],
    labels: [{ name: 'ui' }, { name: 'polish' }],
    ...overrides,
  };
}

function checks(overrides: Partial<CheckSummary> = {}): CheckSummary {
  return {
    state: 'passing',
    total: 14,
    passed: 14,
    failing: 0,
    pending: 0,
    failingNames: [],
    ...overrides,
  };
}

function run(
  id: number,
  app: string,
  name: string,
  status: CheckRunInfo['status'],
  conclusion: CheckRunInfo['conclusion'],
): CheckRunInfo {
  return { id, app, name, status, conclusion, url: '', startedAt: null, completedAt: null };
}

// -------------------------------------------------------------- statusLines

test('statusLines: a clean PR with passing checks is green on every row', () => {
  const lines = statusLines(detail(), checks());
  assert.deepEqual(
    lines.map((line) => [line.id, line.tone]),
    [
      ['checks', 'success'],
      ['review', 'neutral'],
      ['conflicts', 'success'],
    ],
  );
});

test('statusLines: running checks report counts, not a verdict', () => {
  const lines = statusLines(detail(), checks({ state: 'pending', passed: 12, pending: 2 }));
  assert.equal(lines[0]?.tone, 'pending');
  assert.equal(lines[0]?.detail, '12/14');
});

test('statusLines: failing checks carry the first failing names', () => {
  const lines = statusLines(
    detail(),
    checks({ state: 'failing', passed: 12, failing: 2, failingNames: ['lint', 'test / windows'] }),
  );
  assert.equal(lines[0]?.tone, 'failure');
  assert.equal(lines[0]?.detail, 'lint, test / windows');
});

test('statusLines: every mergeableState maps to one honest tone', () => {
  const tone = (state: PullDetail['mergeableState']): string =>
    statusLines(detail({ mergeableState: state }), checks())[2]?.tone ?? '';
  assert.equal(tone('clean'), 'success');
  assert.equal(tone('dirty'), 'failure');
  assert.equal(tone('blocked'), 'pending');
  assert.equal(tone('behind'), 'pending');
  assert.equal(tone('unstable'), 'pending');
  assert.equal(tone('unknown'), 'neutral');
});

test('statusLines: a change request outranks everything, a pending request outranks an approval', () => {
  const approved = statusLines(detail({ approvedBy: ['connorp'], reviewers: ['meganr'] }), checks());
  assert.equal(approved[1]?.tone, 'pending', 'one approval still leaves a requested review open');

  const onlyApproved = statusLines(detail({ approvedBy: ['connorp'] }), checks());
  assert.equal(onlyApproved[1]?.tone, 'success');

  const changes = statusLines(detail({ approvedBy: ['connorp'], changesRequestedBy: ['meganr'] }), checks());
  assert.equal(changes[1]?.tone, 'failure');

  const requested = statusLines(detail({ reviewers: ['connorp'] }), checks());
  assert.equal(requested[1]?.tone, 'pending');
});

// --------------------------------------------------------------- tabCounts

test('tabCounts: an unknown value is null, never zero', () => {
  const counts = tabCounts(detail(), null);
  assert.equal(counts.commits, 2);
  assert.equal(counts.files, 3);
  assert.equal(counts.checks, null, 'without a check summary there is no count to show');
  assert.equal(counts.conversation, null);
});

test('tabCounts: a loaded check list reports its length', () => {
  assert.equal(tabCounts(detail(), checks({ total: 14 })).checks, 14);
});

// -------------------------------------------------------------- groupChecks

test('groupChecks: groups by app in first-appearance order', () => {
  const groups = groupChecks([
    run(1, 'GitHub Actions', 'build / ubuntu', 'completed', 'success'),
    run(2, 'CodeQL', 'analyze (javascript)', 'completed', 'success'),
    run(3, 'GitHub Actions', 'lint', 'completed', 'success'),
  ]);
  assert.deepEqual(groups.map((g) => g.app), ['GitHub Actions', 'CodeQL']);
  assert.deepEqual(groups[0]?.runs.map((r) => r.id), [1, 3], 'run order inside a group is preserved');
  assert.deepEqual(groups[1]?.runs.map((r) => r.id), [2]);
});

test('groupChecks: a run without an app lands in the empty group, not a dropped one', () => {
  const groups = groupChecks([run(1, '', 'mystery', 'queued', null)]);
  assert.deepEqual(groups.map((g) => g.app), ['']);
});

test('groupChecks: an empty list yields no groups', () => {
  assert.deepEqual(groupChecks([]), []);
});

// --------------------------------------------------------------- fileTotals

test('fileTotals: an empty list totals zero', () => {
  assert.deepEqual(fileTotals([]), { files: 0, additions: 0, deletions: 0 });
});

test('fileTotals: sums each file row', () => {
  const files: PullFile[] = [
    { path: 'a.ts', status: 'modified', additions: 4, deletions: 1 },
    { path: 'b.ts', status: 'added', additions: 7, deletions: 0 },
  ];
  assert.deepEqual(fileTotals(files), { files: 2, additions: 11, deletions: 1 });
});

// ---------------------------------------------------------------- clampText

test('clampText leaves short text alone and cuts long text with an ellipsis', () => {
  assert.equal(clampText('short', 10), 'short');
  assert.equal(clampText('abcdefghij', 10), 'abcdefghij');
  const cut = clampText('a'.repeat(20), 10);
  assert.equal(cut.length, 10);
  assert.ok(cut.endsWith('…'));
});

test('clampText keeps the ellipsis inside the limit', () => {
  assert.equal(clampText('abcdefghij', 0), '');
  assert.equal(clampText('abcdefghij', 1), '…');
});

// --------------------------------------------------------------- diffRequest

test('diffRequest returns null without a merge base', () => {
  const file: PullFile = { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 };
  assert.equal(diffRequest(file, detail(), null), null);
});

test('diffRequest sends the head as hash and the merge base as parent', () => {
  const file: PullFile = { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1 };
  const payload = diffRequest(file, detail({ headSha: 'c'.repeat(40) }), 'd'.repeat(40));
  assert.deepEqual(payload, { path: 'src/a.ts', hash: 'c'.repeat(40), parent: 'd'.repeat(40) });
});

test('diffRequest refuses a path that is not repository relative', () => {
  const file: PullFile = { path: 'C:/x.ts', status: 'modified', additions: 1, deletions: 1 };
  assert.equal(diffRequest(file, detail(), 'd'.repeat(40)), null);
});

// ---------------------------------------------------------------- timeline

test('TimelineItem bodies are data, not markup', () => {
  const item: TimelineItem = {
    kind: 'comment',
    id: 1,
    author: 'mallory',
    at: '2026-11-18T00:00:00Z',
    body: '<script>alert(1)</script>',
  };
  assert.equal(typeof item.body, 'string');
});
