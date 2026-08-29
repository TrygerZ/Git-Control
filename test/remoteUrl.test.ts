import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteUrl, stripCredentials, webUrlOf } from '../src/remoteUrl';

test('parses the https form with and without .git', () => {
  assert.deepEqual(parseRemoteUrl('https://github.com/owner/repo.git'), {
    host: 'github.com',
    owner: 'owner',
    repo: 'repo',
    isGitHub: true,
  });
  assert.deepEqual(parseRemoteUrl('https://github.com/owner/repo'), {
    host: 'github.com',
    owner: 'owner',
    repo: 'repo',
    isGitHub: true,
  });
});

test('parses the scp-like ssh form', () => {
  assert.deepEqual(parseRemoteUrl('git@github.com:owner/repo.git'), {
    host: 'github.com',
    owner: 'owner',
    repo: 'repo',
    isGitHub: true,
  });
});

test('parses ssh://, git://, and git+ssh:// schemes', () => {
  for (const url of [
    'ssh://git@github.com/owner/repo',
    'git://github.com/owner/repo.git',
    'git+ssh://git@github.com/owner/repo.git',
  ]) {
    assert.deepEqual(parseRemoteUrl(url)?.repo, 'repo', url);
    assert.equal(parseRemoteUrl(url)?.isGitHub, true, url);
  }
});

test('tolerates a port and a trailing slash', () => {
  assert.deepEqual(parseRemoteUrl('ssh://git@github.com:22/owner/repo.git'), {
    host: 'github.com',
    owner: 'owner',
    repo: 'repo',
    isGitHub: true,
  });
  assert.equal(parseRemoteUrl('https://github.com/owner/repo/')?.repo, 'repo');
  assert.equal(parseRemoteUrl('https://github.com/owner/repo.git/')?.repo, 'repo');
});

test('a GitHub Enterprise host is parsed but not flagged as github.com', () => {
  const parsed = parseRemoteUrl('https://git.acme.example/team/tooling.git');
  assert.deepEqual(parsed, {
    host: 'git.acme.example',
    owner: 'team',
    repo: 'tooling',
    isGitHub: false,
  });
});

test('the host is lower-cased so comparisons are stable', () => {
  assert.equal(parseRemoteUrl('https://GitHub.COM/owner/repo')?.host, 'github.com');
  assert.equal(parseRemoteUrl('https://GitHub.COM/owner/repo')?.isGitHub, true);
});

test('an embedded credential is stripped and never returned', () => {
  const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwx';
  const parsed = parseRemoteUrl(`https://octocat:${secret}@github.com/owner/repo.git`);
  assert.deepEqual(parsed, {
    host: 'github.com',
    owner: 'owner',
    repo: 'repo',
    isGitHub: true,
  });
  const serialized = JSON.stringify(parsed);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('octocat'));
});

test('an x-access-token credential is stripped too', () => {
  const parsed = parseRemoteUrl('https://x-access-token:ghs_abcdef1234567890abcdef@github.com/o/r.git');
  assert.equal(parsed?.host, 'github.com');
  assert.equal(parsed?.owner, 'o');
  assert.equal(parsed?.repo, 'r');
});

test('stripCredentials removes userinfo and leaves clean URLs alone', () => {
  assert.equal(
    stripCredentials('https://user:pass@github.com/owner/repo.git'),
    'https://github.com/owner/repo.git',
  );
  assert.equal(stripCredentials('https://github.com/owner/repo.git'), 'https://github.com/owner/repo.git');
  // The scp-like form has no scheme, so there is nothing to rewrite.
  assert.equal(stripCredentials('git@github.com:owner/repo.git'), 'git@github.com:owner/repo.git');
});

test('unparseable remotes return null', () => {
  for (const value of [
    '',
    '   ',
    'not a url',
    'https://github.com/onlyowner',
    'https://github.com/',
    '/srv/git/repo.git',
    'D:\\repos\\local.git',
    'file:///srv/git/repo.git',
    'https:///owner/repo',
    42,
    null,
    undefined,
  ]) {
    assert.equal(parseRemoteUrl(value as unknown), null, String(value));
  }
});

test('a control character disqualifies the URL', () => {
  assert.equal(parseRemoteUrl('https://github.com/owner/re\npo'), null);
});

test('webUrlOf builds a browsable base URL for github.com and Enterprise alike', () => {
  assert.equal(
    webUrlOf({ host: 'github.com', owner: 'owner', repo: 'repo', isGitHub: true }),
    'https://github.com/owner/repo',
  );
  assert.equal(
    webUrlOf({ host: 'git.acme.example', owner: 'team', repo: 'tooling', isGitHub: false }),
    'https://git.acme.example/team/tooling',
  );
});
