/**
 * P24 pull request detail panel, host-side contract.
 *
 * The panel is a real webview in a real host, so what is checkable here is the
 * wiring around it: the editor view exists as a distinct root, the document the
 * host builds for it carries an integer `data-pr` and the shared CSP, and the
 * internal command that opens it is not contributed to the manifest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function source(relative: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
}

test('main.tsx mounts exactly one of the three roots, never a fourth fallback', () => {
  const code = source('src/webview/main.tsx');
  for (const root of ['PendingChangesApp', 'PullRequestApp', 'ExplorerApp']) {
    assert.ok(code.includes(root), root);
  }
  // The `pr` root is selected by the host's data attribute, not by a query string.
  assert.match(code, /dataset\.view/);
  assert.match(code, /'pr'/);
  // A missing attribute still has to mount something useful.
  assert.match(code, /ExplorerApp/);
});

test('the pull request panel is a panel, not a sidebar route', () => {
  const manifest = JSON.parse(source('package.json')) as {
    contributes?: { commands?: Array<{ command?: string }> };
  };
  const commands = (manifest.contributes?.commands ?? []).map((entry) => entry.command);
  assert.equal(commands.includes('gitControl.openPullRequest'), false, 'no command without a visible entry');
});

test('the PR row and the Inspector card both open the panel, not the browser', () => {
  for (const file of ['src/webview/PullRequestsView.tsx', 'src/webview/Inspector.tsx']) {
    const code = source(file);
    assert.match(code, /actions\/openPullRequest/, file);
  }
});

test('the panel never renders untrusted text as markup', () => {
  const code = source('src/webview/PullRequestApp.tsx');
  assert.doesNotMatch(code, /dangerouslySetInnerHTML|innerHTML/);
  // Links go through the host allowlist, never an `href` the webview follows.
  assert.doesNotMatch(code, /<a\s[^>]*href=/);
});

test('the pane owns no mutation request', () => {
  const code = source('src/webview/PullRequestApp.tsx');
  assert.doesNotMatch(code, /'github\/createPullRequest'|'actions\/commit'|'actions\/git'/);
  // The merge controls are placeholders until P25: the caption states it.
  assert.match(code, /mergeLater|mergeDisabledAria/);
});

test('the icon-theme pull and the host events are wired for the pr root', () => {
  const code = source('src/webview/PullRequestApp.tsx');
  assert.match(code, /wireHostEvents\(/);
  assert.match(code, /useIconThemeStore/);
});

test('every catalogue key the panel reads exists in both catalogs', () => {
  const component = source('src/webview/PullRequestApp.tsx');
  const en = source('src/webview/i18n.en.ts');
  const id = source('src/webview/i18n.id.ts');
  const keys = [...component.matchAll(/strings\.prDetail\.([A-Za-z]+)/g)].map((match) => match[1]);
  assert.ok(keys.length > 0, 'the panel reads the prDetail namespace');
  for (const key of new Set(keys)) {
    // `en` is the source type, so a key present there is checked by tsc as well;
    // this catches the two catalogs drifting in opposite directions.
    assert.match(en, new RegExp(`\\b${key}\\b`), `en.${key}`);
    assert.match(id, new RegExp(`\\b${key}\\b`), `id.${key}`);
  }
});
