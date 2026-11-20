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
  assert.match(source, /"base-uri 'none'"/);
  assert.match(source, /"form-action 'none'"/);
  assert.match(source, /"frame-src 'none'"/);
});

test('webview nonce is generated from 16 random bytes', () => {
  assert.match(source, /const bytes = new Uint8Array\(16\);/);
  assert.match(source, /crypto\.getRandomValues\(bytes\)/);
  assert.match(source, /padStart\(2, '0'\)/);
});

test('historical blob size limit remains bounded', () => {
  assert.match(source, /const MAX_DIFF_BYTES = 5 \* 1024 \* 1024;/);
});

test('checklistDismissed is read with a false default and written only as a boolean', () => {
  // P16: the preference rides in `workspaceState` beside zoom and branchFilter.
  // A missing key must read as "not dismissed", and a non-boolean value from the
  // webview must not be able to store anything else.
  const start = source.indexOf('private uiPreferences()');
  assert.ok(start > 0, 'uiPreferences exists');
  const body = source.slice(start, start + 1200);
  assert.match(
    body,
    /checklistDismissed:\s*stored\.checklistDismissed === true/,
    'a missing or non-true value reads as false',
  );

  const setStart = source.indexOf('private async setUiPreference');
  assert.ok(setStart > 0, 'setUiPreference exists');
  const setBody = source.slice(setStart, setStart + 1400);
  assert.match(
    setBody,
    /payload\.key === 'checklistDismissed' && typeof payload\.value === 'boolean'/,
    'only a boolean is accepted',
  );
});

test('P27: bridgeHost registers Actions write host methods and never logs dispatch inputs', () => {
  for (const name of [
    'githubActionsRun',
    'githubActionsWorkflows',
    'githubRerunFailed',
    'githubWorkflowInputs',
    'githubDispatchWorkflow',
  ]) {
    assert.match(source, new RegExp(`${name}:\\s*\\(payload\\)\\s*=>\\s*this\\.${name}\\(payload\\)`), name);
  }

  const wiStart = source.indexOf('private async githubWorkflowInputs(');
  assert.ok(wiStart > 0, 'githubWorkflowInputs method exists');
  const wiBody = source.slice(wiStart, wiStart + 1600);
  assert.match(wiBody, /parseDispatchInputs/);
  assert.match(wiBody, /workflowWebUrl/);
  assert.match(wiBody, /detectRemote\(\)/);
  assert.doesNotMatch(wiBody, /logger\./, 'workflow file contents must not be logged');

  const dwStart = source.indexOf('private async githubDispatchWorkflow(');
  assert.ok(dwStart > 0, 'githubDispatchWorkflow method exists');
  const dwBody = source.slice(dwStart, dwStart + 1000);
  assert.doesNotMatch(dwBody, /payload\.inputs[^\n]*logger|logger\.[^\n]*inputs/i, 'inputs must never reach logs');
  assert.match(dwBody, /dispatchWorkflow\(/);
});
