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
  'src/webview/hostGuards.ts',
  'src/webview/focusTrap.ts',
  'src/webview/route.ts',
  'src/webview/navRegistry.ts',
  'src/webview/navCounts.ts',
  'src/webview/githubGate.ts',
  'src/webview/prFilters.ts',
  'src/webview/listNav.ts',
  'src/webview/issueFilters.ts',
  'src/webview/issueText.ts',
  'src/webview/issueBranch.ts',
  'src/webview/branchesModel.ts',
  'src/webview/pollPlan.ts',
  'src/webview/actionsModel.ts',
  'src/githubLog.ts',
  'src/githubGuard.ts',
  'src/quickActions.ts',
  'src/webview/onboarding.ts',
  'src/webview/shortcuts.ts',
  'src/webview/helpModel.ts',
  'src/webview/explorerMenu.ts',
  'src/webview/syncActions.ts',
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

test('the P07 pure modules are listed', () => {
  for (const relativePath of ['src/webview/githubGate.ts', 'src/webview/prFilters.ts', 'src/webview/listNav.ts']) {
    assert.ok(PURE_MODULES.includes(relativePath), relativePath);
  }
});

test('the P08 pure modules are listed', () => {
  for (const relativePath of ['src/webview/issueFilters.ts', 'src/webview/issueText.ts']) {
    assert.ok(PURE_MODULES.includes(relativePath), relativePath);
  }
});

test('the P09 pure modules are listed', () => {
  for (const relativePath of ['src/webview/issueBranch.ts']) {
    assert.ok(PURE_MODULES.includes(relativePath), relativePath);
  }
});

test('the P11 pure module is listed', () => {
  assert.ok(PURE_MODULES.includes('src/webview/branchesModel.ts'));
});

test('the P13 pure module is listed', () => {
  assert.ok(PURE_MODULES.includes('src/webview/actionsModel.ts'));
});

test('the P14 pure module is listed', () => {
  assert.ok(PURE_MODULES.includes('src/githubLog.ts'));
});

test('the P15 pure module is listed', () => {
  assert.ok(PURE_MODULES.includes('src/quickActions.ts'));
});

test('the P16 pure module is listed', () => {
  assert.ok(PURE_MODULES.includes('src/webview/onboarding.ts'));
});

test('the P17 pure modules are listed', () => {
  for (const relativePath of ['src/webview/shortcuts.ts', 'src/webview/helpModel.ts']) {
    assert.ok(PURE_MODULES.includes(relativePath), relativePath);
  }
});

test('the P18 pure module is listed', () => {
  assert.ok(PURE_MODULES.includes('src/webview/explorerMenu.ts'));
});

test('the P18b pure module is listed', () => {
  assert.ok(PURE_MODULES.includes('src/webview/syncActions.ts'));
});

test('the P19 pure module is listed', () => {
  assert.ok(PURE_MODULES.includes('src/githubGuard.ts'));
});
