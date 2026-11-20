import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommitTimestamp,
  sanitizeRefArg,
  validateBranchName,
  validateCommitMessage,
  validateDeletableBranch,
  validateFullHash,
  validateHash,
  validateLimit,
  validateMainline,
  validatePullRequestNumber,
  prBranchName,
  validateRemoteName,
  validateRepoRelativePath,
  validateStashIndex,
  validateStashMessage,
  validateEmail,
  validateMergeMethod,
  validateReviewEvent,
  validateCommitTitle,
  validateCommentBody,
  validateIssueNumber,
  validateIssueTitle,
  validateIssueBody,
  validateLabelName,
  validateLabelList,
} from '../src/validation';

test('PRD mandated self-check asserts', () => {
  assert.equal(validateHash('abc1234'), true);
  assert.equal(validateHash('not-a-hash'), false);
});

test('validateHash accepts 7-40 hex, rejects everything else', () => {
  assert.equal(validateHash('abc1234'), true);
  assert.equal(validateHash('ABC1234'), true);
  assert.equal(validateHash('a'.repeat(40)), true);
  assert.equal(validateHash('abc123'), false, '6 chars too short');
  assert.equal(validateHash('a'.repeat(41)), false, '41 chars too long');
  assert.equal(validateHash('not-a-hash'), false);
  assert.equal(validateHash('abc123g'), false, 'g is not hex');
  assert.equal(validateHash(1234567), false);
  assert.equal(validateHash(null), false);
  assert.equal(validateHash(undefined), false);
});

test('validateFullHash requires exactly 40 hex', () => {
  assert.equal(validateFullHash('a'.repeat(40)), true);
  assert.equal(validateFullHash('A'.repeat(40)), true);
  assert.equal(validateFullHash('a'.repeat(39)), false);
  assert.equal(validateFullHash('a'.repeat(41)), false);
  assert.equal(validateFullHash('abc1234'), false);
  assert.equal(validateFullHash(42), false);
});

test('validateBranchName accepts valid refs', () => {
  for (const name of ['feature/x', 'main', 'release-1.2.3', 'a/b/c', 'fix_bug']) {
    assert.equal(validateBranchName(name), true, name);
  }
});

test('validateBranchName rejects git-check-ref-format violations', () => {
  const invalid = [
    '',
    '..',
    '-x',
    'a..b',
    'a b',
    'x.lock',
    'feature/x.lock',
    '@{',
    'a@{1}',
    '@',
    '/x',
    'x/',
    'a//b',
    'a.',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    '.hidden',
    'a/.hidden',
    'a\u0001b',
    'x'.repeat(256),
  ];
  for (const name of invalid) {
    assert.equal(validateBranchName(name), false, JSON.stringify(name));
  }
  assert.equal(validateBranchName(123), false);
});

test('validateRemoteName enforces charset and length', () => {
  assert.equal(validateRemoteName('origin'), true);
  assert.equal(validateRemoteName('up-stream_2.0'), true);
  assert.equal(validateRemoteName('-origin'), false);
  assert.equal(validateRemoteName(''), false);
  assert.equal(validateRemoteName('a b'), false);
  assert.equal(validateRemoteName('a/b'), false);
  assert.equal(validateRemoteName('x'.repeat(101)), false);
  assert.equal(validateRemoteName(7), false);
});

/**
 * The pull request number reaches a refspec, so the only acceptable shape is a
 * positive integer inside git's own 32-bit ref namespace. A string `'1'`, a
 * float, and a value past the ceiling all fail: the branch name is composed from
 * the number, and a value that survives here is one that can be interpolated
 * without a second check.
 */
test('validatePullRequestNumber accepts positive integers inside the 32-bit range', () => {
  assert.equal(validatePullRequestNumber(1), true);
  assert.equal(validatePullRequestNumber(150), true);
  assert.equal(validatePullRequestNumber(2_147_483_647), true);
  for (const value of [0, -1, 1.5, '1', NaN, Infinity, 2_147_483_648]) {
    assert.equal(validatePullRequestNumber(value), false, String(value));
  }
  for (const value of [null, undefined, {}, []]) {
    assert.equal(validatePullRequestNumber(value), false, String(value));
  }
});

test('prBranchName derives a branch git accepts, from the number alone', () => {
  assert.equal(prBranchName(150), 'pr/150');
  assert.equal(prBranchName(1), 'pr/1');
  // The derived name is a branch the rest of the stack accepts without a special case.
  assert.equal(validateBranchName(prBranchName(150)), true);
  // And it is not a name a delete rule would confuse with the current branch.
  assert.notEqual(prBranchName(150), 'main');
});

test('validateRepoRelativePath blocks traversal and absolute paths', () => {
  assert.equal(validateRepoRelativePath('src/index.ts'), true);
  assert.equal(validateRepoRelativePath('a/b/c.txt'), true);
  assert.equal(validateRepoRelativePath('..'), false);
  assert.equal(validateRepoRelativePath('../etc/passwd'), false);
  assert.equal(validateRepoRelativePath('src/../../etc/passwd'), false);
  assert.equal(validateRepoRelativePath('/abs'), false);
  assert.equal(validateRepoRelativePath('C:\\abs'), false);
  assert.equal(validateRepoRelativePath('\\\\server\\share'), false);
  assert.equal(validateRepoRelativePath('a\u0000b'), false);
  assert.equal(validateRepoRelativePath(''), false);
  assert.equal(validateRepoRelativePath('x'.repeat(4097)), false);
  assert.equal(validateRepoRelativePath(null), false);
});

// ------------------------------------------------------------------- SEC-011

test('validateRepoRelativePath rejects UNC and both drive-qualified forms (SEC-011)', () => {
  // Every platform: none of these is a repository-relative path anywhere.
  for (const windows of [true, false]) {
    const label = windows ? 'win' : 'posix';
    assert.equal(validateRepoRelativePath('\\\\server\\share\\x', { windows }), false, `UNC ${label}`);
    assert.equal(validateRepoRelativePath('//server/share/x', { windows }), false, `UNC fwd ${label}`);
    assert.equal(validateRepoRelativePath('C:\\abs\\x', { windows }), false, `drive abs ${label}`);
    assert.equal(validateRepoRelativePath('C:/abs/x', { windows }), false, `drive abs fwd ${label}`);
    // Drive-RELATIVE: resolves against the per-drive cwd, so `C:foo` is neither
    // absolute nor repo-relative.
    assert.equal(validateRepoRelativePath('C:foo\\bar', { windows }), false, `drive rel ${label}`);
    assert.equal(validateRepoRelativePath('c:foo', { windows }), false, `drive rel lower ${label}`);
    // A `.` segment makes the validated string differ from what the FS sees.
    assert.equal(validateRepoRelativePath('x/./y', { windows }), false, `dot segment ${label}`);
  }
});

test('validateRepoRelativePath rejects NTFS streams and device names on Windows only (SEC-011)', () => {
  // On Windows a colon opens an alternate data stream, and the reserved names
  // resolve to devices at any depth and with any extension.
  const windowsOnly = [
    'a.txt:stream',
    'a.txt:$DATA',
    'dir/a.txt:hidden',
    'CON',
    'con',
    'NUL.txt',
    'aux',
    'COM1',
    'lpt9.log',
    'dir/PRN',
  ];
  for (const value of windowsOnly) {
    assert.equal(validateRepoRelativePath(value, { windows: true }), false, `win ${value}`);
    // The same strings are legitimate filenames on Linux and macOS, and a user
    // there must still be able to stage and diff them.
    assert.equal(validateRepoRelativePath(value, { windows: false }), true, `posix ${value}`);
  }
});

test('validateRepoRelativePath keeps accepting ordinary paths on both platforms (SEC-011)', () => {
  const fine = [
    'src/index.ts',
    'a/b/c.txt',
    'CONFIG.md',
    'console.log.js',
    'auxiliary/notes.txt',
    'com10.txt',
    'lpt0.txt',
    'catatan-proyek.md',
    'dokumen/ringkasan.txt',
  ];
  for (const value of fine) {
    assert.equal(validateRepoRelativePath(value, { windows: true }), true, `win ${value}`);
    assert.equal(validateRepoRelativePath(value, { windows: false }), true, `posix ${value}`);
  }
});

test('validateCommitMessage requires 3+ trimmed chars', () => {
  assert.equal(validateCommitMessage('').ok, false);
  assert.equal(validateCommitMessage('   ').ok, false);
  assert.equal(validateCommitMessage('ab').ok, false);
  assert.equal(validateCommitMessage('abc').ok, true);
  assert.equal(validateCommitMessage('  abc  ').message, 'abc');
  assert.equal(validateCommitMessage('x'.repeat(20001)).ok, false);
  assert.equal(validateCommitMessage(5).ok, false);
});

test('validateStashMessage caps length and rejects control chars', () => {
  assert.equal(validateStashMessage(''), true);
  assert.equal(validateStashMessage('wip'), true);
  assert.equal(validateStashMessage('x'.repeat(101)), false);
  assert.equal(validateStashMessage('a\nb'), false);
  assert.equal(validateStashMessage(1), false);
});

test('validateStashIndex accepts non-negative integers up to max and rejects invalid indices', () => {
  assert.equal(validateStashIndex(0), true);
  assert.equal(validateStashIndex(1), true);
  assert.equal(validateStashIndex(999), true);
  assert.equal(validateStashIndex(1000), false);
  assert.equal(validateStashIndex(-1), false);
  assert.equal(validateStashIndex(1.5), false);
  assert.equal(validateStashIndex(NaN), false);
  assert.equal(validateStashIndex(Infinity), false);
  assert.equal(validateStashIndex('0'), false);
  assert.equal(validateStashIndex(null), false);
  assert.equal(validateStashIndex(undefined), false);
  assert.equal(validateStashIndex({}), false);
  assert.equal(validateStashIndex(10, 5), false);
  assert.equal(validateStashIndex(5, 5), true);
});

test('validateLimit accepts integers within bounds', () => {
  assert.equal(validateLimit(1), true);
  assert.equal(validateLimit(10000), true);
  assert.equal(validateLimit(0), false);
  assert.equal(validateLimit(10001), false);
  assert.equal(validateLimit(1.5), false);
  assert.equal(validateLimit(50, 10), false);
  assert.equal(validateLimit('10'), false);
});

test('sanitizeRefArg throws on option-like values', () => {
  assert.throws(() => sanitizeRefArg('--force'), /looks like an option/);
  assert.throws(() => sanitizeRefArg('-x'));
  assert.equal(sanitizeRefArg('main'), 'main');
  assert.equal(sanitizeRefArg('abc1234'), 'abc1234');
});

test('parseCommitTimestamp handles numbers, strings, and invalid inputs consistently', () => {
  assert.equal(parseCommitTimestamp(undefined), 0);
  assert.equal(parseCommitTimestamp(''), 0);
  assert.equal(parseCommitTimestamp('invalid-date'), 0);
  assert.equal(parseCommitTimestamp(0), 0);
  assert.equal(parseCommitTimestamp(-1000), 0);
  assert.equal(parseCommitTimestamp(Infinity), 0);
  assert.equal(parseCommitTimestamp(-Infinity), 0);
  assert.equal(parseCommitTimestamp(NaN), 0);
  assert.equal(parseCommitTimestamp(1700000000), 1700000000);
  const ts = new Date('2026-08-23T10:00:00.000Z').getTime();
  assert.equal(parseCommitTimestamp('2026-08-23T10:00:00.000Z'), ts);
});

test('validateBranchName rejects fully qualified refs unless opted in (Bug 2)', () => {
  // `git for-each-ref` lists these next to branches; git rejects them where a
  // branch is expected (`fatal: a branch is expected, got refs/stash`).
  for (const name of ['refs/stash', 'refs/heads/main', 'refs/notes/commits', 'refs/tags/v1']) {
    assert.equal(validateBranchName(name), false, name);
  }
  // The fast-forward probe needs the qualified remote-tracking form.
  assert.equal(validateBranchName('refs/remotes/origin/main', { allowQualified: true }), true);
  assert.equal(validateBranchName('refs/remotes/origin/main'), false);
  // Non-remote qualified refs must be rejected even with allowQualified: true
  assert.equal(validateBranchName('refs/stash', { allowQualified: true }), false);
  assert.equal(validateBranchName('refs/heads/main', { allowQualified: true }), false);
  assert.equal(validateBranchName('refs/notes/commits', { allowQualified: true }), false);
  assert.equal(validateBranchName('refs/tags/v1', { allowQualified: true }), false);
  assert.equal(validateBranchName('refs/remotes/origin', { allowQualified: true }), false);
  // Opting in never weakens the other rules.
  assert.equal(validateBranchName('refs/heads/a..b', { allowQualified: true }), false);
  assert.equal(validateBranchName('refs/heads/x.lock', { allowQualified: true }), false);
  assert.equal(validateBranchName('refs/remotes/origin/a..b', { allowQualified: true }), false);
  assert.equal(validateBranchName('refs/remotes/origin/x.lock', { allowQualified: true }), false);
  // A branch whose own name merely starts with `ref` is unaffected.
  assert.equal(validateBranchName('refactor/refs'), true);
});

test('validateEmail accepts valid email strings and rejects invalid ones', () => {
  assert.equal(validateEmail('author@example.com'), true);
  assert.equal(validateEmail('dev.lead+git@company.co.uk'), true);
  assert.equal(validateEmail('user@localhost'), true);
  assert.equal(validateEmail('  trimmed@example.com  '), true);
  assert.equal(validateEmail('a'.repeat(240) + '@example.com'), true);

  // Rejections
  assert.equal(validateEmail(''), false, 'empty string');
  assert.equal(validateEmail('   '), false, 'whitespace only');
  assert.equal(validateEmail('a'.repeat(250) + '@example.com'), false, '> 254 characters');
  assert.equal(validateEmail('user\n@example.com'), false, 'control character newline');
  assert.equal(validateEmail('user\u0000@example.com'), false, 'null byte');
  assert.equal(validateEmail(null), false, 'null');
  assert.equal(validateEmail(undefined), false, 'undefined');
  assert.equal(validateEmail(12345), false, 'number');
  assert.equal(validateEmail({ email: 'test@example.com' }), false, 'object');
});

test('validateMainline accepts positive integers and rejects everything else', () => {
  assert.equal(validateMainline(1), true);
  assert.equal(validateMainline(2), true);
  assert.equal(validateMainline(100), true);

  // Rejections
  assert.equal(validateMainline(0), false, 'zero is not 1-based');
  assert.equal(validateMainline(-1), false, 'negative integer');
  assert.equal(validateMainline(1.5), false, 'float');
  assert.equal(validateMainline(Number.NaN), false, 'NaN');
  assert.equal(validateMainline(Number.POSITIVE_INFINITY), false, 'Infinity');
  assert.equal(validateMainline('1'), false, 'string representation');
  assert.equal(validateMainline(null), false, 'null');
  assert.equal(validateMainline(undefined), false, 'undefined');
  assert.equal(validateMainline({}), false, 'object');
  assert.equal(validateMainline([]), false, 'array');
});

/**
 * The branch a user is on is the one branch a delete may never name, so the
 * refusal has to live in the shared validator rather than in one caller: the
 * guard and the bridge both reach it, and neither may disagree.
 */
test('validateDeletableBranch accepts a branch that is not the current one', () => {
  assert.equal(validateDeletableBranch('feat/a', 'main'), true);
  assert.equal(validateDeletableBranch('main', null), true, 'detached HEAD has no branch to protect');
  assert.equal(validateDeletableBranch('fix/b', 'main'), true);
  assert.equal(validateDeletableBranch('feat/a', 'feat/a'), false, 'current branch');
  assert.equal(validateDeletableBranch('feat/a', 'main '), true, 'comparison is exact, not trimmed');
});

test('validateDeletableBranch keeps every branch-name rule', () => {
  for (const [value, current] of [
    ['-x', 'main'],
    ['refs/heads/x', 'main'],
    ['', 'main'],
    ['a..b', 'main'],
    ['a b', 'main'],
    ['@', 'main'],
  ] as const) {
    assert.equal(validateDeletableBranch(value, current), false, value);
  }
  for (const value of [null, undefined, 1, {}, []]) {
    assert.equal(validateDeletableBranch(value, 'main'), false, String(value));
  }
});



/**
 * P25: the pull request merge and review inputs.
 *
 * `validateMergeMethod` is the allowlist that keeps `rebase` out of the request
 * entirely (D-08): a UI that never draws the option is not the guarantee, the
 * validator is. `validateCommentBody` is a length and NUL bound, not a content
 * policy: GitHub renders the body as Markdown, and this extension never renders
 * it at all.
 */
test('validateMergeMethod admits exactly merge and squash', () => {
  assert.equal(validateMergeMethod('merge'), true);
  assert.equal(validateMergeMethod('squash'), true);
  for (const value of ['rebase', 'MERGE', 'Squash', '', ' merge', null, undefined, 1, {}, []]) {
    assert.equal(validateMergeMethod(value), false, String(value));
  }
});

test('validateReviewEvent admits exactly the three review events', () => {
  for (const value of ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']) {
    assert.equal(validateReviewEvent(value), true, value);
  }
  for (const value of ['approve', 'request_changes', 'DISMISS', 'PENDING', '', null, undefined, 3, {}]) {
    assert.equal(validateReviewEvent(value), false, String(value));
  }
});

test('validateCommitTitle bounds a squash title and refuses NUL', () => {
  assert.equal(validateCommitTitle('fix(webview): rebalance inset (#150)'), true);
  assert.equal(validateCommitTitle('a'.repeat(256)), true, 'a long title is still a title');
  assert.equal(validateCommitTitle(''), false, 'empty');
  assert.equal(validateCommitTitle('   '), false, 'whitespace only');
  assert.equal(validateCommitTitle('a'.repeat(257)), false, 'past the bound');
  assert.equal(validateCommitTitle('has\u0000nul'), false, 'NUL');
  assert.equal(validateCommitTitle('has\nnewline'), false, 'a title is one line');
  for (const value of [null, undefined, 7, {}]) assert.equal(validateCommitTitle(value), false, String(value));
});

test('validateCommentBody requires text and bounds it', () => {
  assert.equal(validateCommentBody('Looks good.'), true);
  assert.equal(validateCommentBody('a'.repeat(65_536)), true, 'the max is inclusive');
  assert.equal(validateCommentBody('a'.repeat(65_537)), false, 'past the max');
  assert.equal(validateCommentBody(''), false, 'empty');
  assert.equal(validateCommentBody('\n\t  '), false, 'whitespace only');
  assert.equal(validateCommentBody('has\u0000nul'), false, 'NUL');
  assert.equal(validateCommentBody('line\nbreak is fine'), true, 'multi-line bodies are comment text');
  for (const value of [null, undefined, 7, {}]) assert.equal(validateCommentBody(value), false, String(value));

  // A caller with a tighter budget passes it in rather than re-implementing the rule.
  assert.equal(validateCommentBody('a'.repeat(11), 10), false);
  assert.equal(validateCommentBody('a'.repeat(10), 10), true);
});

// ------------------------------------------------------- issue writes (P26)

test('validateIssueNumber accepts positive 32-bit integers and rejects non-positive or non-integer values', () => {
  assert.equal(validateIssueNumber(1), true);
  assert.equal(validateIssueNumber(97), true);
  assert.equal(validateIssueNumber(2_147_483_647), true);
  for (const value of [0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY, '97', null, undefined, {}, []]) {
    assert.equal(validateIssueNumber(value), false, String(value));
  }
});

test('validateIssueTitle accepts 1..256 trimmed characters without control chars', () => {
  assert.equal(validateIssueTitle('Crash on startup'), true);
  assert.equal(validateIssueTitle('  trimmed title  '), true);
  assert.equal(validateIssueTitle('a'.repeat(256)), true, '256 chars');
  assert.equal(validateIssueTitle(`  ${'a'.repeat(256)}  `), true, '256 chars after trim');

  assert.equal(validateIssueTitle(''), false, 'empty');
  assert.equal(validateIssueTitle('   '), false, 'whitespace');
  assert.equal(validateIssueTitle('a'.repeat(257)), false, '257 chars');
  assert.equal(validateIssueTitle('bad\nnewline'), false, 'newline control char');
  assert.equal(validateIssueTitle('bad\u0000nul'), false, 'NUL control char');
  assert.equal(validateIssueTitle('bad\u0007bell'), false, 'BEL control char');
  assert.equal(validateIssueTitle('bad\u007fdel'), false, 'DEL control char');
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(validateIssueTitle(value), false, String(value));
  }
});

test('validateIssueBody accepts 0..65536 characters without NUL', () => {
  assert.equal(validateIssueBody(''), true, 'empty description is allowed');
  assert.equal(validateIssueBody('Multi-line\ndescription\twith tabs'), true);
  assert.equal(validateIssueBody('a'.repeat(65_536)), true, '65536 chars');
  assert.equal(validateIssueBody('a'.repeat(65_537)), false, '65537 chars');
  assert.equal(validateIssueBody('has\u0000nul'), false, 'NUL');
  for (const value of [null, undefined, 42, {}, []]) {
    assert.equal(validateIssueBody(value), false, String(value));
  }
});

test('validateLabelName accepts 1..50 non-control characters and validateLabelList caps unique items at 10', () => {
  assert.equal(validateLabelName('bug'), true);
  assert.equal(validateLabelName('good first issue'), true);
  assert.equal(validateLabelName('a'.repeat(50)), true, '50 chars');
  assert.equal(validateLabelName(''), false, 'empty');
  assert.equal(validateLabelName('   '), false, 'whitespace only');
  assert.equal(validateLabelName('a'.repeat(51)), false, '51 chars');
  assert.equal(validateLabelName('bug\n'), false, 'control char');
  assert.equal(validateLabelName('bug\u0000'), false, 'NUL');
  for (const value of [null, undefined, 1, {}, []]) {
    assert.equal(validateLabelName(value), false, String(value));
  }

  assert.equal(validateLabelList([]), true, 'empty list');
  assert.equal(validateLabelList(['bug', 'enhancement']), true);
  assert.equal(
    validateLabelList(Array.from({ length: 10 }, (_, i) => `label-${i}`)),
    true,
    '10 unique items',
  );
  assert.equal(
    validateLabelList(Array.from({ length: 11 }, (_, i) => `label-${i}`)),
    false,
    '11 items exceeds cap',
  );
  assert.equal(validateLabelList(['bug', 'bug']), false, 'duplicates rejected');
  assert.equal(validateLabelList(['bug', '']), false, 'invalid entry rejected');
  assert.equal(validateLabelList(['bug', 'a'.repeat(51)]), false, 'oversized entry rejected');
  for (const value of [null, undefined, 'bug', 1, {}]) {
    assert.equal(validateLabelList(value), false, String(value));
  }
});
