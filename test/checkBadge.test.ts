/**
 * Check badge and inspector PR card (P21).
 *
 * Source-level contract, like the other view tests in this project: there is no
 * DOM harness, so what is pinned here is the wiring a reader cannot verify by
 * eye - which helpers the views route through, which requests they may send, and
 * that no untrusted string reaches a raw `href` or `innerHTML`.
 *
 * Behaviour of the helpers themselves lives in `checkSummary.test.ts`,
 * `format.test.ts`, and `prStore.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('the inspector renders a pull request card that routes through the pure helpers', () => {
  const src = read('src/webview/Inspector.tsx');
  assert.match(src, /gc-inspector__pr-card/, 'the card has its own class');
  assert.match(src, /checkLabel\(/, 'the summary text comes from the pure helper');
  assert.match(src, /checkTone\(/, 'the tone comes from the pure helper');
  assert.match(src, /checkNamesLabel\(/, 'the failing names come from the pure helper');
  assert.match(src, /summarizeChecks\(|summary/, 'the card reads a summary, not raw runs');
  assert.match(src, /loadCommitPullRequests\(/, 'the card loads through the store action');
  assert.match(src, /openUrl\(/, 'the link opens through the host, never a raw href');
  assert.doesNotMatch(src, /href=\{/, 'no raw href in the inspector');
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
});

test('the inspector card issues no check request when the commit is in no pull request', () => {
  const src = read('src/webview/Inspector.tsx');
  // The load is gated on a head sha that came from the PR answer, so an empty
  // answer means nothing to ask about.
  assert.match(src, /headSha/, 'checks are keyed on the pull request head sha');
  const effect = src.slice(src.indexOf('loadCommitPullRequests('));
  assert.match(effect, /headSha/, 'the sha gate sits in the same effect as the load');
});

test('the pull request row renders a check badge from the same summary', () => {
  const src = read('src/webview/PullRequestsView.tsx');
  assert.match(src, /gc-check/, 'the badge class');
  assert.match(src, /checkLabel\(/);
  assert.match(src, /checkTone\(/);
  assert.match(src, /loadChecks\(/, 'rows load through the store action');
  assert.match(src, /headSha/, 'the row reads the sha off the pull request');
  assert.doesNotMatch(src, /bridge\.request\(/, 'the view still sends no request of its own');
  assert.doesNotMatch(src, /dangerouslySetInnerHTML|innerHTML/);
});

test('the row badge is text plus icon, never colour alone', () => {
  const src = read('src/webview/PullRequestsView.tsx');
  const badge = src.slice(src.indexOf('gc-check'));
  assert.match(badge, /<Icon\s+name=/, 'an icon accompanies the count');
  assert.match(badge, /aria-label=/, 'the badge has an accessible name');
});

test('the card states the empty case instead of drawing an empty frame', () => {
  const src = read('src/webview/Inspector.tsx');
  assert.match(src, /pullRequestNone/, 'a commit in no pull request says so');
  assert.match(src, /pullRequestNoneHint/, 'and says what to do about it');
  // The card must not render for a user with no GitHub linkage at all: the
  // inspector already hides the GitHub button in that case.
  assert.match(src, /linkage\?\.available/, 'the card is gated on linkage like the GitHub button');
});

test('the card reserves its height and marks itself busy while loading', () => {
  const css = read('src/webview/styles.css');
  assert.match(css, /\.gc-inspector__pr-card\s*\{[^}]*min-height/, 'no layout shift when checks land');
  const src = read('src/webview/Inspector.tsx');
  assert.match(src, /aria-busy/, 'loading is announced');
});

test('the row asks for checks only for rows that reach the viewport', () => {
  const src = read('src/webview/PullRequestsView.tsx');
  // The badge is per row, but the request is per viewport: one observer, one batch.
  assert.match(src, /IntersectionObserver/, 'rows are observed, not all requested at once');
  assert.match(src, /loadChecks\(/, 'the batch goes through the store action');
  assert.match(src, /gc-prs__check|gc-check/, 'the row renders the badge');
  assert.doesNotMatch(src, /setInterval/, 'no polling in this view');
});

test('the row badge never renders without a summary or a reason', () => {
  const src = read('src/webview/PullRequestsView.tsx');
  // A row whose pull request carries no head sha cannot have checks; it must not
  // render an empty badge that looks like "no checks".
  assert.match(src, /headSha/, 'the badge is gated on the head sha');
  assert.match(src, /checks\[/, 'the badge reads the stored summary by sha');
});
