/**
 * Purity boundary contract.
 *
 * These modules must remain usable in the headless Node test bundle. Keep the
 * check source-based so importing the modules cannot hide an accidental host
 * dependency behind the test harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PURE_MODULES = [
  'src/layout.ts',
  'src/validation.ts',
  'src/guard.ts',
  'src/gitParse.ts',
  'src/iconThemeCore.ts',
  'src/webview/format.ts',
  'src/webview/viewport.ts',
  'src/webview/tree.ts',
];

test('pure modules contain no vscode imports', () => {
  for (const relativePath of PURE_MODULES) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s+|require\(\s*)['"]vscode['"]|import\s+['"]vscode['"]/, 
      relativePath,
    );
  }
});
