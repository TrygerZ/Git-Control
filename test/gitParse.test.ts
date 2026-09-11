import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLog,
  parseRefs,
  parseRemoteList,
  parseRemotes,
  parseRevListCounts,
  parseRevListParents,
  parseShortlog,
  parseShowStat,
  parseStashList,
  parseStatus,
} from '../src/gitParse';

const FS = '\x1f';
const RS = '\x1e';

interface Fixture {
  hash: string;
  short: string;
  parents: string;
  refs: string;
  subject: string;
  body: string;
}

/** Build one `git log -z` record exactly as LOG_FORMAT emits it. */
function record(f: Fixture): string {
  return (
    [
      f.hash,
      f.short,
      f.parents,
      'Ada Lovelace',
      'ada@example.com',
      '2026-01-01T10:00:00+00:00',
      'Ada Lovelace',
      '2026-01-01T10:05:00+00:00',
      f.refs,
      f.subject,
      f.body,
    ].join('\0') + '\0'
  );
}

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const HASH_C = 'c'.repeat(40);

test('parseLog handles multi-line bodies, merges, and decorations', () => {
  const raw =
    record({
      hash: HASH_A,
      short: 'aaaaaaa',
      parents: `${HASH_B} ${HASH_C}`,
      refs: 'HEAD -> main, origin/main, tag: v1.0',
      subject: "Merge branch 'feature/x'",
      body: 'Line one\nLine two\n\nLine four\n',
    }) +
    record({
      hash: HASH_B,
      short: 'bbbbbbb',
      parents: HASH_C,
      refs: '',
      subject: 'Plain commit',
      body: '',
    });

  const commits = parseLog(raw);
  assert.equal(commits.length, 2);

  const merge = commits[0];
  assert.ok(merge);
  assert.equal(merge.hash, HASH_A);
  assert.equal(merge.shortHash, 'aaaaaaa');
  assert.deepEqual(merge.parents, [HASH_B, HASH_C]);
  assert.equal(merge.authorName, 'Ada Lovelace');
  assert.equal(merge.authorEmail, 'ada@example.com');
  assert.equal(merge.authoredAt, '2026-01-01T10:00:00+00:00');
  assert.equal(merge.committedAt, '2026-01-01T10:05:00+00:00');
  assert.deepEqual(merge.refNames, ['main', 'origin/main', 'tag: v1.0']);
  assert.equal(merge.subject, "Merge branch 'feature/x'");
  assert.equal(merge.body, 'Line one\nLine two\n\nLine four');

  const plain = commits[1];
  assert.ok(plain);
  assert.deepEqual(plain.parents, [HASH_C]);
  assert.deepEqual(plain.refNames, []);
  assert.equal(plain.body, '');
});

test('parseLog tolerates CRLF in body and trailing whitespace', () => {
  const raw =
    record({
      hash: HASH_A,
      short: 'aaaaaaa',
      parents: '',
      refs: '',
      subject: 'Root commit',
      body: 'Body with CRLF\r\nline two\r\n',
    }) + '\r\n';
  const commits = parseLog(raw);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0]?.parents, []);
  assert.equal(commits[0]?.body, 'Body with CRLF\r\nline two');
});

test('parseLog preserves messages containing delimiter control characters (BUG4)', () => {
  const raw = record({
    hash: HASH_A,
    short: 'aaaaaaa',
    parents: '',
    refs: '',
    subject: 'Subject with \x1f and \x1e delimiters',
    body: 'Line 1\x1fstill line 1\nLine 2\x1emore line 2\x1f\x1e',
  });
  const commits = parseLog(raw);
  assert.equal(commits.length, 1);
  const c = commits[0];
  assert.ok(c);
  assert.equal(c.hash, HASH_A);
  assert.equal(c.subject, 'Subject with \x1f and \x1e delimiters');
  assert.equal(c.body, 'Line 1\x1fstill line 1\nLine 2\x1emore line 2\x1f\x1e');
});

test('parseStatus handles rename, deletion, untracked, and staged+unstaged', () => {
  const raw = [
    'R  lib/new.ts\0lib/old.ts\0',
    'D  removed.txt\0',
    ' D worktree-gone.txt\0',
    'MM both.ts\0',
    '?? scratch.log\0',
  ].join('');

  const entries = parseStatus(raw);
  assert.equal(entries.length, 5);

  const rename = entries[0];
  assert.ok(rename);
  assert.equal(rename.path, 'lib/new.ts');
  assert.equal(rename.origPath, 'lib/old.ts');
  assert.equal(rename.staged, true);
  assert.equal(rename.unstaged, false);

  const staged = entries[1];
  assert.ok(staged);
  assert.equal(staged.path, 'removed.txt');
  assert.equal(staged.indexStatus, 'D');
  assert.equal(staged.staged, true);
  assert.equal(staged.unstaged, false);

  const unstaged = entries[2];
  assert.ok(unstaged);
  assert.equal(unstaged.staged, false);
  assert.equal(unstaged.unstaged, true);

  const both = entries[3];
  assert.ok(both);
  assert.equal(both.staged, true);
  assert.equal(both.unstaged, true);

  const untracked = entries[4];
  assert.ok(untracked);
  assert.equal(untracked.path, 'scratch.log');
  assert.equal(untracked.untracked, true);
  assert.equal(untracked.staged, false);
  assert.equal(untracked.unstaged, false);
});

test('parseStatus flags every porcelain conflict code', () => {
  for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
    const entries = parseStatus(`${code} conflicted.ts\0`);
    const entry = entries[0];
    assert.ok(entry, code);
    assert.equal(entry.conflicted, true, code);
    assert.equal(entry.staged, false, code);
    assert.equal(entry.unstaged, false, code);
    assert.equal(entry.path, 'conflicted.ts', code);
  }
});

test('parseShowStat reports counts, binaries, and renames', () => {
  const raw = ['12\t3\tsrc/index.ts', '-\t-\tassets/logo.png', '4\t0\tsrc/old.ts\tsrc/new.ts', '2\t1\tdocs/{a => b}/x.md'].join('\n');
  const entries = parseShowStat(raw);
  assert.equal(entries.length, 4);

  assert.deepEqual(entries[0], {
    path: 'src/index.ts',
    additions: 12,
    deletions: 3,
    binary: false,
  });

  const binary = entries[1];
  assert.ok(binary);
  assert.equal(binary.path, 'assets/logo.png');
  assert.equal(binary.binary, true);
  assert.equal(binary.additions, null);
  assert.equal(binary.deletions, null);

  const renamed = entries[2];
  assert.ok(renamed);
  assert.equal(renamed.path, 'src/new.ts');
  assert.equal(renamed.origPath, 'src/old.ts');

  const arrow = entries[3];
  assert.ok(arrow);
  assert.equal(arrow.origPath, 'docs/{a');
  assert.equal(arrow.path, 'b}/x.md');
});

test('parseShowStat tolerates CRLF and ignores non-numstat lines', () => {
  const entries = parseShowStat('commit abc\r\n5\t2\ta.ts\r\n');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.path, 'a.ts');
});

test('parseRevListCounts reads behind then ahead', () => {
  assert.deepEqual(parseRevListCounts('3\t5\n'), { behind: 3, ahead: 5 });
  assert.deepEqual(parseRevListCounts('0\t0\r\n'), { behind: 0, ahead: 0 });
  assert.deepEqual(parseRevListCounts(''), { behind: 0, ahead: 0 });
});

test('parseRevListParents extracts parent hashes omitting commit hash itself', () => {
  // Empty or whitespace
  assert.deepEqual(parseRevListParents(''), []);
  assert.deepEqual(parseRevListParents('   \r\n'), []);

  // Root commit (zero parents)
  assert.deepEqual(parseRevListParents('c0\n'), []);

  // Single parent commit
  assert.deepEqual(parseRevListParents('c1 p1\n'), ['p1']);

  // Merge commit (two parents)
  assert.deepEqual(parseRevListParents('c2 p1 p2\r\n'), ['p1', 'p2']);

  // Octopus merge commit (three parents)
  assert.deepEqual(parseRevListParents('c3 p1 p2 p3\n'), ['p1', 'p2', 'p3']);
});

test('parseRefs splits for-each-ref fields', () => {
  const raw = [
    ['refs/heads/main', HASH_A, 'refs/remotes/origin/main', '[ahead 2]', '*'].join(FS),
    ['refs/remotes/origin/main', HASH_B, '', '', ''].join(FS),
  ].join('\n');
  const refs = parseRefs(raw);
  assert.equal(refs.length, 2);
  assert.equal(refs[0]?.isHead, true);
  assert.equal(refs[0]?.upstream, 'refs/remotes/origin/main');
  assert.equal(refs[1]?.isHead, false);
  assert.equal(refs[1]?.upstream, null);
});

test('parseRemotes dedupes fetch and push URLs', () => {
  const raw = [
    'origin\thttps://example.com/a.git\t(fetch)',
    'origin\thttps://example.com/a.git\t(push)',
    'upstream\thttps://example.com/b.git\t(fetch)',
  ].join('\r\n');
  assert.deepEqual(parseRemotes(raw), [
    { name: 'origin', url: 'https://example.com/a.git' },
    { name: 'upstream', url: 'https://example.com/b.git' },
  ]);
});

test('parseRemoteList keeps fetch and push URLs apart', () => {
  const raw = [
    'origin\thttps://example.com/a.git\t(fetch)',
    'origin\tgit@example.com:a.git\t(push)',
    'upstream\thttps://example.com/b.git\t(fetch)',
  ].join('\n');
  assert.deepEqual(parseRemoteList(raw), [
    { name: 'origin', fetchUrl: 'https://example.com/a.git', pushUrl: 'git@example.com:a.git' },
    // A remote listed once uses that URL for both directions.
    { name: 'upstream', fetchUrl: 'https://example.com/b.git', pushUrl: 'https://example.com/b.git' },
  ]);
});

test('parseShortlog parses standard shortlog output sorted by count', () => {
  const raw = [
    '   150\tAda Lovelace <ada@example.com>',
    '    42\tCharles Babbage <charles@example.com>',
    '     3\tGrace Hopper <grace@navy.mil>',
  ].join('\n');
  assert.deepEqual(parseShortlog(raw), [
    { name: 'Ada Lovelace', email: 'ada@example.com', count: 150 },
    { name: 'Charles Babbage', email: 'charles@example.com', count: 42 },
    { name: 'Grace Hopper', email: 'grace@navy.mil', count: 3 },
  ]);
});

test('parseShortlog tolerates CRLF, blank lines, and whitespace', () => {
  const raw = '\r\n\r\n   10\tAda <ada@example.com>\r\n\r\n   2\tBob <bob@example.com>\r\n   \r\n';
  assert.deepEqual(parseShortlog(raw), [
    { name: 'Ada', email: 'ada@example.com', count: 10 },
    { name: 'Bob', email: 'bob@example.com', count: 2 },
  ]);
});

test('parseShortlog handles special characters in names and emails', () => {
  const raw = [
    '     5\tBudi Utomo (Joko) čšć <budi.utomo+review@sub-domain.example.co.id>',
    '     2\t"Coder" O\'Connor <oconnor@example.org>',
  ].join('\n');
  assert.deepEqual(parseShortlog(raw), [
    { name: 'Budi Utomo (Joko) čšć', email: 'budi.utomo+review@sub-domain.example.co.id', count: 5 },
    { name: '"Coder" O\'Connor', email: 'oconnor@example.org', count: 2 },
  ]);
});

test('parseShortlog ignores empty or malformed lines', () => {
  const raw = [
    '',
    '   ',
    'fatal: ambiguous argument HEAD',
    '     \tMissing count <user@example.com>',
    '    10\tMissing angle brackets user@example.com',
    '     0\tZero count <zero@example.com>',
    '    -5\tNegative count <neg@example.com>',
    '     1\t <>',
  ].join('\n');
  assert.deepEqual(parseShortlog(raw), []);
  assert.deepEqual(parseShortlog(''), []);
});

test('parseStashList parses multi-entry stash output', () => {
  const raw = [
    `stash@{0}\0${HASH_A}\0WIP on main: initial commit`,
    `stash@{1}\0${HASH_B}\0On feature: save work before rebase`,
  ].join('\n');
  assert.deepEqual(parseStashList(raw), [
    { ref: 'stash@{0}', hash: HASH_A, subject: 'WIP on main: initial commit' },
    { ref: 'stash@{1}', hash: HASH_B, subject: 'On feature: save work before rebase' },
  ]);
});

test('parseStashList preserves special characters and extra delimiters in subject', () => {
  const subjectWithSpecials = 'WIP: fix(core): handle "quotes", tabs\tand unicode (čšć)\0extra:delims';
  const raw = `stash@{0}\0${HASH_A}\0${subjectWithSpecials}\n`;
  const result = parseStashList(raw);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.ref, 'stash@{0}');
  assert.equal(result[0]?.hash, HASH_A);
  assert.equal(result[0]?.subject, subjectWithSpecials);
});

test('parseStashList tolerates CRLF, blank lines, and empty raw output', () => {
  const raw = `\r\nstash@{0}\0${HASH_A}\0first stash\r\n\r\nstash@{1}\0${HASH_B}\0second stash\r\n`;
  assert.deepEqual(parseStashList(raw), [
    { ref: 'stash@{0}', hash: HASH_A, subject: 'first stash' },
    { ref: 'stash@{1}', hash: HASH_B, subject: 'second stash' },
  ]);
  assert.deepEqual(parseStashList(''), []);
  assert.deepEqual(parseStashList('\r\n\n  \n'), []);
});

test('parseStashList ignores malformed lines with missing delimiters', () => {
  const raw = [
    'malformed line without null delimiters',
    `stash@{0}\0missing-subject-and-hash`,
    `stash@{0}\0${HASH_A}\0valid subject`,
  ].join('\n');
  assert.deepEqual(parseStashList(raw), [
    { ref: 'stash@{0}', hash: HASH_A, subject: 'valid subject' },
  ]);
});
