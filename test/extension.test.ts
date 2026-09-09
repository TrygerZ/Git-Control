/**
 * Extension-host characterization contracts.
 *
 * `extension.ts` is intentionally an I/O wrapper. Importing it requires the
 * VS Code host, so this file pins the host-independent source contracts rather
 * than introducing a large vscode mock that would test the mock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'extension.ts'), 'utf8');

test('extension exports the activation lifecycle', () => {
  assert.match(source, /export async function activate\(/);
  assert.match(source, /export function deactivate\(\)/);
});

test('language normalization accepts id and falls back to en', () => {
  assert.match(source, /return rawLang === 'id' \? 'id' : 'en';/);
});

test('git path configuration rejects relative executables', () => {
  assert.match(source, /if \(!path\.isAbsolute\(configured\)\)/);
  assert.match(source, /gitPathRelative/);
});

test('webview CSP keeps network access disabled except avatar images', () => {
  assert.match(source, /"connect-src 'none'"/);
  assert.match(source, /https:\/\/avatars\.githubusercontent\.com/);
  assert.match(source, /script-src 'nonce-\$\{nonce\}'/);
});

test('webview nonce is generated from 16 random bytes', () => {
  assert.match(source, /const bytes = new Uint8Array\(16\);/);
  assert.match(source, /crypto\.getRandomValues\(bytes\)/);
  assert.match(source, /padStart\(2, '0'\)/);
});

test('historical blob size limit remains bounded', () => {
  assert.match(source, /const MAX_DIFF_BYTES = 5 \* 1024 \* 1024;/);
});
