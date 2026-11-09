/**
 * Job log processing (P14).
 *
 * The log body is untrusted text from a signed storage URL: it can carry ANSI
 * escapes, progress-bar carriage returns, PEM key material, and secrets. These
 * tests pin the pipeline order and the host policy, because both fail closed and
 * a silent regression here is a leak or an SSRF, not a cosmetic bug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOG_LIMITS,
  TailBuffer,
  isLogHostAllowed,
  processLog,
  validateLogLocation,
} from '../src/githubLog';

const MASK = '[masked key material]';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function lines(text: string, headDropped = false): ReturnType<typeof processLog> {
  return processLog({ bytes: encode(text), headDropped }, undefined, MASK);
}

// ----------------------------------------------------------------- TailBuffer

test('TailBuffer keeps every byte under the tail window', () => {
  const buf = new TailBuffer({ tailBytes: 16, hardCapBytes: 1024 });
  assert.equal(buf.push(encode('abc')), 'ok');
  assert.equal(buf.push(encode('def')), 'ok');
  assert.equal(buf.total, 6);
  assert.equal(buf.headDropped, false);
  assert.equal(new TextDecoder().decode(buf.bytes()), 'abcdef');
});

test('TailBuffer keeps the end of the stream in order once it overflows the window', () => {
  const buf = new TailBuffer({ tailBytes: 5, hardCapBytes: 1024 });
  assert.equal(buf.push(encode('abc')), 'ok');
  assert.equal(buf.push(encode('defgh')), 'ok');
  assert.equal(buf.total, 8);
  assert.equal(buf.headDropped, true);
  assert.equal(new TextDecoder().decode(buf.bytes()), 'defgh');
});

test('TailBuffer reports overflow past the hard cap and keeps the tail', () => {
  const buf = new TailBuffer({ tailBytes: 4, hardCapBytes: 6 });
  assert.equal(buf.push(encode('abcd')), 'ok');
  assert.equal(buf.push(encode('ef')), 'ok');
  assert.equal(buf.push(encode('g')), 'overflow');
  assert.equal(buf.headDropped, true);
  assert.equal(new TextDecoder().decode(buf.bytes()), 'defg');
});

test('TailBuffer accepts empty chunks without moving the counter', () => {
  const buf = new TailBuffer({ tailBytes: 8, hardCapBytes: 64 });
  assert.equal(buf.push(new Uint8Array(0)), 'ok');
  assert.equal(buf.total, 0);
  assert.equal(buf.bytes().length, 0);
});

// --------------------------------------------------------------- processLog

test('processLog strips ANSI colour and cursor codes', () => {
  const out = lines('\x1b[31merror\x1b[0m here\n\x1b[2K\x1b[1Gprogress 10%');
  assert.deepEqual(
    out.lines.map((l) => l.text),
    ['error here', 'progress 10%'],
  );
});

test('processLog keeps the last segment of a carriage-return progress line', () => {
  const out = lines('step 1\rstep 2\rstep 3');
  assert.deepEqual(out.lines.map((l) => l.text), ['step 3']);
});

test('processLog removes a leading BOM and leading timestamps', () => {
  const out = lines('﻿2026-11-01T10:00:00.1234567Z hello\n2026-11-01T10:00:01Z world');
  assert.deepEqual(out.lines.map((l) => l.text), ['hello', 'world']);
});

test('processLog maps markers to tones and removes them from the text', () => {
  const out = lines(
    ['##[group]Build', '##[command]/usr/bin/bash -e build.sh', '##[warning]Careful', '##[error]Boom', '##[endgroup]'].join(
      '\n',
    ),
  );
  assert.deepEqual(out.lines, [
    { text: 'Build', tone: 'group' },
    { text: '/usr/bin/bash -e build.sh', tone: 'command' },
    { text: 'Careful', tone: 'warning' },
    { text: 'Boom', tone: 'error' },
  ]);
});

test('processLog discards the partial first line only when the head was dropped', () => {
  const text = 'al line\nsecond\nthird';
  assert.deepEqual(lines(text, true).lines.map((l) => l.text), ['second', 'third']);
  assert.deepEqual(lines(text, false).lines.map((l) => l.text), ['al line', 'second', 'third']);
});

test('processLog keeps exactly the last 200 lines and reports the cut', () => {
  const text = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n');
  const out = lines(text);
  assert.equal(out.lines.length, 200);
  assert.equal(out.lines[0]?.text, 'line 50');
  assert.equal(out.lines[199]?.text, 'line 249');
  assert.equal(out.headCut, true);
});

test('processLog does not claim a cut when nothing was dropped', () => {
  const out = lines('one\ntwo');
  assert.equal(out.headCut, false);
});

test('processLog truncates a line at maxLineChars with an ellipsis', () => {
  const out = lines('x'.repeat(1200), false);
  assert.equal(out.lines[0]?.text.length, 1000);
  assert.ok(out.lines[0]?.text.endsWith('...'));
});

test('processLog enforces maxChars by dropping the oldest kept lines', () => {
  const out = processLog(
    { bytes: encode('aaaaaaaa\nbbbbbbbb\ncccccccc'), headDropped: false },
    { maxChars: 9 },
    MASK,
  );
  assert.deepEqual(out.lines.map((l) => l.text), ['cccccccc']);
  assert.equal(out.headCut, true);
});

test('processLog reports binary when the window carries a NUL byte', () => {
  const bytes = new Uint8Array([0x68, 0x69, 0x00, 0x0a]);
  const out = processLog({ bytes, headDropped: false }, undefined, MASK);
  assert.equal(out.state, 'binary');
  assert.deepEqual(out.lines, []);
});

test('processLog reports empty for whitespace-only input', () => {
  assert.equal(lines('').state, 'empty');
  assert.equal(lines('\n\n\n').state, 'empty');
  assert.equal(lines('   ').state, 'empty');
});

test('processLog masks a PEM block even when its BEGIN line sits before the line cut', () => {
  const block = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----'];
  const filler = Array.from({ length: 300 }, (_, i) => `filler ${i}`);
  const text = [...block, ...filler].join('\n');
  const out = lines(text);
  assert.equal(out.lines.length, 200);
  assert.ok(out.lines.every((l) => !l.text.includes('MIIEowIBAAKCAQEA')));
  assert.ok(!out.lines.some((l) => l.text.includes('PRIVATE KEY')));
  assert.ok(out.lines.every((l) => l.text !== MASK), 'masked block is before the cut, not inside it');
});

test('processLog masks an unterminated PEM block through the end of the window', () => {
  const out = lines('before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n');
  assert.deepEqual(out.lines, [
    { text: 'before', tone: 'normal' },
    { text: MASK, tone: 'normal' },
    { text: MASK, tone: 'normal' },
  ]);
});

test('processLog masks a PEM block that is inside the kept window', () => {
  const out = lines(
    ['before', '-----BEGIN PRIVATE KEY-----', 'AAAA', '-----END PRIVATE KEY-----', 'after'].join('\n'),
  );
  assert.deepEqual(out.lines.map((l) => l.text), ['before', MASK, MASK, MASK, 'after']);
});

test('processLog redacts a token-shaped secret and leaves a bare object id alone', () => {
  const token = `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`;
  const hash = '0123456789abcdef0123456789abcdef01234567';
  const out = lines(`${token}\n${hash}`);
  assert.ok(!out.lines[0]?.text.includes(token));
  assert.equal(out.lines[0]?.text, '[redacted]');
  assert.equal(out.lines[1]?.text, hash);
});

test('processLog keeps tabs and drops other control characters', () => {
  const out = lines('a\tb\u0007c\u001bd');
  assert.equal(out.lines[0]?.text, 'a\tbcd');
});

test('processLog drops trailing empty lines but keeps the state ok', () => {
  const out = lines('one\n\n\n');
  assert.deepEqual(out.lines.map((l) => l.text), ['one']);
  assert.equal(out.state, 'ok');
});

test('DEFAULT_LOG_LIMITS matches the documented phase defaults', () => {
  assert.deepEqual(DEFAULT_LOG_LIMITS, {
    tailBytes: 1024 * 1024,
    hardCapBytes: 64 * 1024 * 1024,
    maxLines: 200,
    maxLineChars: 1000,
    maxChars: 32768,
  });
});

// -------------------------------------------------------- validateLogLocation

const API = 'https://api.github.com';

function allowed(location: string, apiUrl = API): boolean {
  return validateLogLocation(location, apiUrl) !== null;
}

test('validateLogLocation resolves a relative location against the API base', () => {
  const url = validateLogLocation('/storage/log.txt', API);
  assert.ok(url !== null);
  assert.equal(url.hostname, 'api.github.com');
  assert.equal(url.protocol, 'https:');
});

test('validateLogLocation accepts the documented storage hosts', () => {
  assert.ok(allowed('https://api.github.com/x'));
  assert.ok(allowed('https://github.com/x'));
  assert.ok(allowed('https://pipelines.actions.githubusercontent.com/x'));
  assert.ok(allowed('https://productionresultssa0.blob.core.windows.net/x'));
});

test('validateLogLocation rejects plain http', () => {
  assert.equal(allowed('http://api.github.com/x'), false);
});

test('validateLogLocation rejects credentials and non-443 ports', () => {
  assert.equal(allowed('https://user:pass@api.github.com/x'), false);
  assert.equal(allowed('https://api.github.com:8443/x'), false);
  assert.ok(allowed('https://api.github.com:443/x'));
});

test('validateLogLocation rejects internal and literal addresses', () => {
  for (const location of [
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://build.local/x',
    'https://cache.internal/x',
    'https://x.localhost/x',
  ]) {
    assert.equal(allowed(location), false, location);
  }
});

test('validateLogLocation rejects a backslash and an over-long location', () => {
  assert.equal(allowed('https:\\\\api.github.com\\x'), false);
  assert.equal(allowed(`https://api.github.com/${'a'.repeat(4096)}`), false);
});

test('validateLogLocation rejects look-alike hosts on the suffix boundary', () => {
  assert.equal(allowed('https://evilgithub.com/x'), false);
  assert.equal(allowed('https://github.com.evil.test/x'), false);
  assert.equal(allowed('https://notgithub.com/x'), false);
});

test('isLogHostAllowed follows the API host for an enterprise base', () => {
  assert.ok(isLogHostAllowed('github.corp.example', 'github.corp.example'));
  assert.ok(isLogHostAllowed('logs.github.corp.example', 'github.corp.example'));
  assert.equal(isLogHostAllowed('github.com', 'github.corp.example'), false);
  assert.equal(isLogHostAllowed('evilgithub.corp.example', 'github.corp.example'), false);
});

test('isLogHostAllowed is case-insensitive', () => {
  assert.ok(isLogHostAllowed('API.GitHub.com', 'api.github.com'));
});

// ------------------------------------------- PEM across the tail window (gate)

test('TailBuffer reports an open PEM block that started before the window', () => {
  const buf = new TailBuffer({ tailBytes: 1024, hardCapBytes: 1024 * 1024 });
  buf.push(encode('-----BEGIN RSA PRIVATE KEY-----\n'));
  for (let i = 0; i < 200; i += 1) buf.push(encode(`MIIEsecretline${i}\n`));
  assert.equal(buf.headDropped, true, 'the window moved past the BEGIN line');
  assert.equal(buf.pemOpen, true, 'the block is still open at the window start');
  const out = processLog({ bytes: buf.bytes(), headDropped: true, pemOpen: buf.pemOpen }, undefined, MASK);
  assert.ok(out.lines.length > 0);
  assert.ok(
    out.lines.every((l) => l.text === MASK),
    `every line must be masked, first was ${JSON.stringify(out.lines[0]?.text)}`,
  );
});

test('TailBuffer clears the open state once the END marker is inside the window', () => {
  const buf = new TailBuffer({ tailBytes: 4096, hardCapBytes: 1024 * 1024 });
  buf.push(encode('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\nafter\n'));
  assert.equal(buf.pemOpen, false);
  const out = processLog({ bytes: buf.bytes(), headDropped: false, pemOpen: buf.pemOpen }, undefined, MASK);
  assert.deepEqual(out.lines.map((l) => l.text), [MASK, MASK, MASK, 'after']);
});

test('TailBuffer does not report a block as open when a later END closed it', () => {
  const buf = new TailBuffer({ tailBytes: 64, hardCapBytes: 1024 * 1024 });
  buf.push(encode('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'));
  for (let i = 0; i < 20; i += 1) buf.push(encode(`tail line ${i}\n`));
  assert.equal(buf.headDropped, true);
  assert.equal(buf.pemOpen, false, 'the BEGIN was closed before the window start');
});

test('TailBuffer detects a marker split across two chunks', () => {
  // The split BEGIN must be found even though no single chunk contains it, and
  // once the window has moved past it the block must still read as open.
  const buf = new TailBuffer({ tailBytes: 32, hardCapBytes: 1024 * 1024 });
  buf.push(encode('-----BEG'));
  buf.push(encode('IN RSA PRIVATE KEY-----\nAAAA\n'));
  for (let i = 0; i < 6; i += 1) buf.push(encode(`MIIEbody${i}\n`));
  assert.equal(buf.headDropped, true);
  assert.equal(buf.pemOpen, true);
  const out = processLog({ bytes: buf.bytes(), headDropped: true, pemOpen: buf.pemOpen }, undefined, MASK);
  assert.ok(out.lines.every((l) => l.text === MASK), JSON.stringify(out.lines.map((l) => l.text)));
});
