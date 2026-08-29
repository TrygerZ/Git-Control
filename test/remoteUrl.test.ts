import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GITHUB_API_URL,
  parseRemoteUrl,
  resolveGitHubApiBase,
  stripCredentials,
  webUrlOf,
} from '../src/remoteUrl';

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

// ------------------------------------------------------------------- SEC-010

test('a backslash authority is attributed exactly as WHATWG URL attributes it (SEC-010)', () => {
  // The divergent inputs the audit names. `new URL()` is the reference: a
  // backslash terminates the authority, so the userinfo rule must not be allowed
  // to swallow it and promote the text after the `@` to host.
  const cases = [
    'https://evil.example\\@github.com/owner/repo.git',
    'https://github.com\\@evil.example/owner/repo.git',
    'https://evil.example\\github.com/owner/repo.git',
  ];
  for (const url of cases) {
    const reference = new URL(url).hostname.toLowerCase();
    const parsed = parseRemoteUrl(url);
    assert.notEqual(parsed, null, url);
    assert.equal(parsed?.host, reference, url);
  }

  // Concretely: the first case is `evil.example`, never `github.com`.
  const crafted = parseRemoteUrl('https://evil.example\\@github.com/owner/repo.git');
  assert.equal(crafted?.host, 'evil.example');
  assert.equal(crafted?.isGitHub, false, 'a crafted remote must not be trusted as github.com');
});

test('stripCredentials does not rewrite a backslash authority into a false host (SEC-010)', () => {
  // Stopping the userinfo match at the backslash keeps the output honest: it must
  // not read as a plain `github.com` URL.
  const stripped = stripCredentials('https://evil.example\\@github.com/owner/repo.git');
  assert.notEqual(stripped, 'https://github.com/owner/repo.git');
  assert.ok(stripped.includes('evil.example'));
  // A real credential in a normal authority is still removed.
  assert.equal(
    stripCredentials('https://user:pass@github.com/owner/repo.git'),
    'https://github.com/owner/repo.git',
  );
});

test('a backslash inside the path is normalised, not treated as an authority end (SEC-010)', () => {
  const parsed = parseRemoteUrl('https://github.com/owner\\repo.git');
  assert.equal(parsed?.host, 'github.com');
  assert.equal(parsed?.owner, 'owner');
  assert.equal(parsed?.repo, 'repo');
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

// -------------------------------------------------- regression: SEC-002/SEC-003

test('stripCredentials removes userinfo containing an @ (SEC-003)', () => {
  // Userinfo runs to the LAST `@`. Stopping at the first one left the tail of the
  // secret in the URL handed to the webview.
  const secret = 'ghs_A1b2C3d4E5f6G7h8I9j0';
  const leaky = `https://x-access-token:${secret}@corp@github.com/owner/repo.git`;
  const stripped = stripCredentials(leaky);
  assert.ok(!stripped.includes(secret), stripped);
  assert.equal(stripped, 'https://github.com/owner/repo.git');

  // An email-style username has the same shape.
  assert.equal(
    stripCredentials('https://alice@corp.example:s3cr3t@git.acme.example/t/r.git'),
    'https://git.acme.example/t/r.git',
  );
});

test('a derived Enterprise API base is never a trusted token target (SEC-002)', () => {
  // A cloned repository chooses its own remote, so a base derived from that
  // remote must not receive the stored token.
  const evil = parseRemoteUrl('https://evil.example/o/r.git');
  assert.notEqual(evil, null);
  const derived = resolveGitHubApiBase(DEFAULT_GITHUB_API_URL, evil);
  assert.equal(derived.apiUrl, 'https://evil.example/api/v3');
  assert.equal(derived.tokenAllowed, false, 'token must not travel to a derived base');
});

test('a user-configured API base does receive the token, github.com included', () => {
  const remote = parseRemoteUrl('https://git.acme.example/team/tooling.git');
  const configured = resolveGitHubApiBase('https://git.acme.example/api/v3/', remote);
  assert.equal(configured.apiUrl, 'https://git.acme.example/api/v3');
  assert.equal(configured.tokenAllowed, true);

  const github = resolveGitHubApiBase(DEFAULT_GITHUB_API_URL, parseRemoteUrl('git@github.com:o/r.git'));
  assert.equal(github.apiUrl, DEFAULT_GITHUB_API_URL);
  assert.equal(github.tokenAllowed, true);

  // No remote at all still means the default API.
  assert.deepEqual(resolveGitHubApiBase('', null), {
    apiUrl: DEFAULT_GITHUB_API_URL,
    tokenAllowed: true,
  });
});

test('a non-https configured base falls back to the default rather than sending the token in the clear', () => {
  for (const value of ['http://evil.example/api/v3', 'ftp://x.example', 'evil.example']) {
    const base = resolveGitHubApiBase(value, null);
    assert.equal(base.apiUrl, DEFAULT_GITHUB_API_URL, value);
    assert.equal(base.tokenAllowed, true, value);
  }
});
