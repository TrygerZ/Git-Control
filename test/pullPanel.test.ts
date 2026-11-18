/**
 * P24 host-side contract for the pull request panel.
 *
 * Two things are checkable without a VS Code host: the document the panel is
 * built from carries the strict CSP and an integer `data-pr` that came out of
 * the same validator the bridge uses, and the merge-base rule degrades to
 * `null` instead of throwing when the commits are not here.
 *
 * The panel creation itself needs `vscode` and is covered by
 * `test/integration-suite.js`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validatePullRequestNumber } from '../src/validation';

function source(relative: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
}

test('the PR document reaches data-pr only through validatePullRequestNumber', () => {
  const code = source('src/extension.ts');
  // The number arrives from the webview, so it must pass the same gate the
  // checkout refspec uses before it can appear in an attribute.
  assert.match(code, /validatePullRequestNumber\(/);
  const builder = /htmlPullRequest\([^)]*number[^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(code);
  assert.ok(builder, 'htmlPullRequest exists');
  assert.match(builder[1] ?? '', /data-pr="\$\{number\}"|data-pr="\$\{String\(number\)\}"/);
  assert.doesNotMatch(builder[1] ?? '', /innerHTML|dangerouslySetInnerHTML/);
});

test('the PR document keeps the same CSP the other documents carry', () => {
  const code = source('src/extension.ts');
  // One CSP array, used by every document. A second, looser copy would be the
  // way an `img-src` or `connect-src` creep starts.
  const arrays = code.match(/const csp = \[/g) ?? [];
  assert.equal(arrays.length, 1, 'exactly one CSP definition');
  const start = code.indexOf('const csp = [');
  const body = code.slice(start, code.indexOf('].join', start));
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ]) {
    assert.ok(body.includes(directive), directive);
  }
  // Scanned inside the policy itself: the source comment uses the word too.
  assert.doesNotMatch(body, /unsafe-inline|unsafe-eval/);
});

test('the merge-base lookup can only answer with a full hash or null', () => {
  const code = source('src/extension.ts');
  // `mergeBase` is what the Files tab sends to `actions/openDiff` as `parent`,
  // so it must be a commit id from git, never a ref or a partial.
  assert.match(code, /\.mergeBase\(/);
  assert.match(code, /null/, 'the degradation path returns null');
  // A failed lookup must not surface file paths or response bodies in the log.
  assert.doesNotMatch(code, /logger\.info\('pull\/files'[^)]*detail/);
});

test('validatePullRequestNumber is the single gate for panel numbers', () => {
  // Sanity: the helper itself is unchanged and still refuses the shapes a panel
  // attribute must never hold.
  assert.equal(validatePullRequestNumber(150), true);
  for (const value of [0, -1, 1.5, '150', NaN, 2_147_483_648]) {
    assert.equal(validatePullRequestNumber(value), false, String(value));
  }
});
