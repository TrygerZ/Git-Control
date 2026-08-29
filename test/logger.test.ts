import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger, formatRecord, redact, type LogSink } from '../src/logger';

/** Collects lines so assertions can inspect exactly what would be written. */
class MemorySink implements LogSink {
  readonly lines: string[] = [];
  appendLine(value: string): void {
    this.lines.push(value);
  }
}

test('redact strips every GitHub token prefix', () => {
  const prefixes = ['ghp', 'gho', 'ghu', 'ghs', 'ghr'];
  for (const prefix of prefixes) {
    const token = `${prefix}_${'A1b2C3d4E5f6G7h8I9j0'}`;
    assert.equal(redact(`using ${token} now`), 'using [redacted] now', prefix);
  }
});

test('redact leaves short token-like strings alone', () => {
  // Under 20 chars after the prefix: not a real token, keep it readable.
  assert.equal(redact('ghp_short'), 'ghp_short');
});

test('redact strips x-access-token credentials from remote URLs', () => {
  const url = 'https://x-access-token:ghs_A1b2C3d4E5f6G7h8I9j0@github.com/o/r.git';
  const out = redact(url);
  assert.ok(!out.includes('ghs_A1b2C3d4E5f6G7h8I9j0'));
  assert.ok(out.includes('x-access-token:[redacted]@github.com/o/r.git'));
});

test('redact strips generic user:password credentials from URLs', () => {
  const out = redact('remote: https://alice:s3cr3t@example.com/repo.git');
  assert.equal(out, 'remote: https://alice:[redacted]@example.com/repo.git');
  assert.ok(!out.includes('s3cr3t'));
});

test('redact is idempotent', () => {
  const once = redact('https://x-access-token:ghs_A1b2C3d4E5f6G7h8I9j0@github.com/o/r.git');
  assert.equal(redact(once), once);
});

test('redact strips Authorization headers regardless of case', () => {
  assert.equal(redact('Authorization: Bearer abc.def.ghi'), 'Authorization: [redacted]');
  assert.equal(redact('authorization:  token xyz'), 'authorization:  [redacted]');
});

test('redact handles several secrets in one line', () => {
  const line = 'Authorization: Bearer x and ghp_A1b2C3d4E5f6G7h8I9j0 and https://u:p@h/r';
  const out = redact(line);
  assert.ok(!out.includes('ghp_A1b2C3d4E5f6G7h8I9j0'));
  assert.ok(!out.includes('Bearer x'));
  assert.ok(!out.includes(':p@'));
});

test('redact is a no-op on clean text and empty input', () => {
  assert.equal(redact(''), '');
  assert.equal(redact('git push origin main'), 'git push origin main');
});

test('formatRecord emits timestamp, id, kind, status, duration, and exit code', () => {
  const line = formatRecord(
    { operationId: 'op-00007', kind: 'actions/git', status: 'fail', durationMs: 1234.6, exitCode: 128 },
    new Date('2026-08-29T10:11:12.000Z'),
  );
  assert.equal(line, '2026-08-29T10:11:12.000Z op-00007 actions/git fail 1235ms exit=128');
});

test('formatRecord collapses a multi-line detail onto one line', () => {
  const line = formatRecord(
    { operationId: 'op-1', kind: 'push', status: 'fail', detail: 'first\nsecond\r\nthird' },
    new Date('2026-08-29T00:00:00.000Z'),
  );
  assert.ok(line.endsWith('first | second | third'));
  assert.equal(line.split('\n').length, 1);
});

test('formatRecord redacts secrets that reach the detail field', () => {
  const line = formatRecord(
    { operationId: 'op-2', kind: 'push', status: 'fail', detail: 'token ghp_A1b2C3d4E5f6G7h8I9j0 rejected' },
    new Date('2026-08-29T00:00:00.000Z'),
  );
  assert.ok(!line.includes('ghp_A1b2C3d4E5f6G7h8I9j0'));
  assert.ok(line.includes('[redacted]'));
});

test('nextOperationId is monotonic and zero padded', () => {
  const logger = new Logger(new MemorySink());
  assert.equal(logger.nextOperationId(), 'op-00001');
  assert.equal(logger.nextOperationId(), 'op-00002');
});

test('time logs a start line then an ok line and returns the value', async () => {
  const sink = new MemorySink();
  const logger = new Logger(sink, () => new Date('2026-08-29T00:00:00.000Z'));
  const value = await logger.time('op-1', 'repos/status', async () => 42);
  assert.equal(value, 42);
  assert.equal(sink.lines.length, 2);
  assert.ok(sink.lines[0]?.includes('op-1 repos/status start'));
  assert.ok(sink.lines[1]?.includes('op-1 repos/status ok'));
});

test('time logs a fail line with the exit code and rethrows', async () => {
  const sink = new MemorySink();
  const logger = new Logger(sink, () => new Date('2026-08-29T00:00:00.000Z'));
  const err = Object.assign(new Error('boom ghp_A1b2C3d4E5f6G7h8I9j0'), { exitCode: 1 });
  await assert.rejects(() => logger.time('op-9', 'push', () => Promise.reject(err)), /boom/);
  const failLine = sink.lines[1] ?? '';
  assert.ok(failLine.includes('op-9 push fail'));
  assert.ok(failLine.includes('exit=1'));
  assert.ok(!failLine.includes('ghp_A1b2C3d4E5f6G7h8I9j0'));
});

test('info writes a single redacted line with no operation id', () => {
  const sink = new MemorySink();
  const logger = new Logger(sink, () => new Date('2026-08-29T00:00:00.000Z'));
  logger.info('git/exec', 'git push https://x-access-token:ghs_A1b2C3d4E5f6G7h8I9j0@h/r');
  assert.equal(sink.lines.length, 1);
  assert.ok(sink.lines[0]?.startsWith('2026-08-29T00:00:00.000Z - git/exec info '));
  assert.ok(!sink.lines[0]?.includes('ghs_A1b2C3d4E5f6G7h8I9j0'));
});

// ------------------------------------------------ regression: SEC-004 redactor

test('redact strips a fine-grained github_pat_ token (SEC-004)', () => {
  // Different prefix and an underscore body, so the `gh[pousr]_` rule misses it.
  const token = 'github_pat_11ABCDEFG0aBcDeFgHiJk_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
  const out = redact(`fatal: unable to access using ${token} now`);
  assert.ok(!out.includes(token), out);
  assert.ok(out.includes('[redacted]'));

  // Also inside a remote URL, where git actually prints it.
  const url = redact(`https://x-access-token:${token}@github.com/o/r.git`);
  assert.ok(!url.includes(token), url);
});

test('redact strips a credential whose userinfo contains an @ (SEC-004)', () => {
  const secret = 'ghs_A1b2C3d4E5f6G7h8I9j0';
  const out = redact(`remote: https://x-access-token:${secret}@corp@github.com/o/r.git`);
  assert.ok(!out.includes(secret), out);

  const email = redact('remote: https://alice@corp.example:s3cr3t@example.com/repo.git');
  assert.ok(!email.includes('s3cr3t'), email);
});

test('redact strips a bare Bearer/Basic/token credential without a header name', () => {
  for (const line of [
    'sent Bearer github_pat_11ABCDEFG0aBcDeFgHiJk_ZZZZZZZZZZZZZZZZZZZ upstream',
    'used Basic YWxpY2U6czNjcjN0MDAwMDAwMDA= upstream',
    'used token 0123456789abcdef0123456789abcdef01234567 upstream',
  ]) {
    const out = redact(line);
    assert.ok(out.includes('[redacted]'), out);
  }
});

test('redact leaves a bare 40-hex object id alone, by design', () => {
  // A classic OAuth token and a git object id are byte-identical, and this log is
  // full of object ids. Redacting them would erase every hash from the channel.
  const hash = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(redact(`git show ${hash}`), `git show ${hash}`);
});

test('redact stays idempotent across the new rules', () => {
  const line =
    'Authorization: Bearer x; https://x-access-token:github_pat_11AAAAAAAAAAAAAAAAAAAA_BBBB@corp@h/r; ghp_A1b2C3d4E5f6G7h8I9j0';
  const once = redact(line);
  assert.equal(redact(once), once);
});
