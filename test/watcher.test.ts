/**
 * Watcher characterization contracts.
 *
 * Direct construction needs the VS Code runtime and filesystem handles. Keep
 * this test narrow and source-based until a host test harness exists. No
 * production extraction or broad vscode mock belongs in this phase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'watcher.ts'), 'utf8');

test('watcher keeps the 500 ms default debounce', () => {
  assert.match(source, /export const DEBOUNCE_MS = 500;/);
  assert.match(source, /options\.debounceMs \?\? DEBOUNCE_MS/);
});

test('watcher coalesces busy mutations until completion', () => {
  assert.match(source, /if \(this\.busy\) return;/);
  assert.match(source, /if \(!busy\) this\.schedule\(\);/);
  assert.match(source, /this\.pendingChange = true;/);
});

test('watcher flush bypasses debounce without emitting after disposal', () => {
  assert.match(source, /clearTimeout\(this\.timer\)/);
  assert.match(source, /if \(!this\.disposed\) this\.onChange\(\);/);
});

test('watcher observes workspace changes and repository metadata', () => {
  assert.match(source, /createFileSystemWatcher\(pattern\)/);
  assert.match(source, /path\.join\(gitDir, 'refs'\)/);
  assert.match(source, /GIT_DIR_WATCH_TARGETS/);
});
