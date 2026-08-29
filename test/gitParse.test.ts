import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLog,
  parseRefs,
  parseRemoteList,
  parseRemotes,
  parseRevListCounts,
  parseShowStat,
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

/** Build one `git log` record exactly as LOG_FORMAT emits it. */
function record(f: Fixture): string {
  return [
    '',
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
  ].join(FS) + RS;
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
    '\n' +
    record({
      hash: HASH_B,
      short: 'bbbbbbb',
      parents: HASH_C,
      refs: '',
      subject: 'Plain commit',
      body: '',
    }) +
    '\n';

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

test('parseLog tolerates CRLF record terminators', () => {
  const raw = record({
    hash: HASH_A,
    short: 'aaaaaaa',
    parents: '',
    refs: '',
    subject: 'Root commit',
    body: '',
  }) + '\r\n';
  const commits = parseLog(raw);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0]?.parents, []);
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
