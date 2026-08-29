import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeRefArg,
  validateBranchName,
  validateCommitMessage,
  validateFullHash,
  validateHash,
  validateLimit,
  validateRemoteName,
  validateRepoRelativePath,
  validateStashMessage,
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
