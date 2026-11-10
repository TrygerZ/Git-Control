/**
 * Get started card component (P16).
 *
 * Source-level contract, like `actionsView.test.ts`: there is no DOM harness in
 * this repo, so the component is pinned by the pure helpers it must route
 * through, the accessibility attributes it must carry, and the requests it may
 * not send. Step behaviour lives in `onboarding.test.ts`; the preference lives in
 * `onboardingStore.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('the card routes every decision through the pure helpers', () => {
  const card = read('src/webview/GetStartedCard.tsx');
  for (const helper of ['computeSteps', 'cardPhase', 'progress', 'compareUrl']) {
    assert.match(card, new RegExp(`\\b${helper}\\b`), `GetStartedCard: ${helper}`);
  }
});

test('the card mounts in the Changes sub-tab only, under the sub-tabs', () => {
  const src = read('src/webview/PendingChanges.tsx');
  assert.match(src, /<GetStartedCard\s*\/>/, 'the card is mounted');

  const tabs = src.indexOf('<Tablist');
  const card = src.indexOf('<GetStartedCard />');
  const search = src.indexOf('strings.pending.searchPlaceholder');
  assert.ok(tabs > 0, 'the sub-tab strip exists');
  assert.ok(card > tabs, 'the card follows the sub-tabs');
  assert.ok(search > card, 'and precedes the filter row');

  // `changesSubOf` answers 'changes' for every non-Changes route, so the sub-tab
  // test alone would draw the card above the Pull requests, Issues, Actions, and
  // Branches views. The route has to be named too.
  assert.match(
    src,
    /route\.id === 'changes' &&\s*sub === 'changes' &&[\s\S]{0,40}<GetStartedCard \/>/,
    'the card needs the Changes route, not just the changes sub-tab',
  );
});

test('an unloaded pull request list is passed as unknown, not as empty', () => {
  // The store starts with `pullRequests: []`, which the pure model cannot tell
  // apart from "loaded, and this branch has none". Passing that through would
  // flash a 3 of 4 card and then flip to 4 of 4 a moment later.
  const card = read('src/webview/GetStartedCard.tsx');
  assert.match(card, /pullRequestsLoadedAt/, 'the store records whether the list ever loaded');
  assert.match(
    card,
    /pullRequestsLoadedAt === null \? null :/,
    'an unloaded list is handed over as unknown',
  );
});

test('the card is a labelled section with an ordered step list and a real progressbar', () => {
  const card = read('src/webview/GetStartedCard.tsx');
  assert.match(card, /<section\b/);
  assert.match(card, /aria-label=/);
  assert.match(card, /<ol\b/, 'steps are an ordered list');
  assert.match(card, /role="progressbar"/);
  assert.match(card, /aria-valuenow=/);
  assert.match(card, /aria-valuemin=/);
  assert.match(card, /aria-valuemax=/);
  assert.match(card, /aria-valuetext=/, 'the bar says the count in words too');
});

test('every step exposes its state as text, not colour alone', () => {
  const card = read('src/webview/GetStartedCard.tsx');
  for (const key of ['stepDoneAria', 'stepCurrentAria', 'stepTodoAria']) {
    assert.match(card, new RegExp(`strings\\.onboarding\\.${key}`), key);
  }
  assert.match(card, /gc-visually-hidden/, 'the state word is announced, the mark is decorative');
});

test('the dismiss control is a real button with a minimum target and an accessible name', () => {
  const card = read('src/webview/GetStartedCard.tsx');
  assert.match(card, /<button\b[^>]*className="gc-icon-button/);
  assert.match(card, /aria-label=\{strings\.onboarding\.dismissAria\}/);
  const css = read('src/webview/styles.css');
  assert.match(css, /\.gc-started__dismiss/, 'the dismiss button has its own rule');
});

test('the done note is a live region and the hide timer is cleared on unmount', () => {
  const card = read('src/webview/GetStartedCard.tsx');
  assert.match(card, /role="status"/, 'the hide notice is announced');
  assert.match(card, /clearTimeout/, 'the auto-hide timer does not outlive the component');
  assert.match(card, /return \(\) => clearTimeout\(/, 'cleanup is returned from the effect');
  assert.match(card, /3000|HIDE_DELAY_MS/, 'the delay is the three seconds the frame promises');
});

test('the card sends no request of its own: connect and publish go through the stores', () => {
  const card = read('src/webview/GetStartedCard.tsx');
  assert.doesNotMatch(card, /bridge\.request\(/, 'no direct request');
  assert.doesNotMatch(card, /fetch\(/, 'no network');
  assert.doesNotMatch(card, /dangerouslySetInnerHTML|innerHTML/);
  assert.match(card, /connect/, 'the connect action uses the existing store action');
  assert.match(card, /runAction\(\{\s*action: 'push'/, 'publish reuses the footer push');
});

test('the branch name in the card text is sanitized and the url comes from the pure helper', () => {
  const card = read('src/webview/GetStartedCard.tsx');
  assert.match(card, /sanitizeGitText/, 'git-sourced text is sanitized at the render site');
  assert.match(card, /openUrl\(/, 'the compare link opens through the host');
});

test('remote existence comes from the configured remotes, not from remote-tracking refs', () => {
  // `git remote add` writes `.git/config` and creates no `refs/remotes/*` entry
  // until a fetch or push, so `firstRemoteName(graph.refs)` reports "no remote"
  // for exactly the new-user state the card exists for. PHASE_16 precondition 4
  // names `repos/remotes` as the source.
  const card = read('src/webview/GetStartedCard.tsx');
  assert.match(card, /useRepoStore\(\(s\) => s\.remotes\)/, 'the card reads the configured remotes');
  assert.match(card, /loadRemotes/, 'and asks for them once');
  assert.match(
    card,
    /hasRemote\s*=\s*remotes === null \? null : remotes\.length > 0/,
    'a configured remote counts before anything is fetched',
  );
  assert.doesNotMatch(
    card,
    /firstRemoteName\(graph\.refs\) !== null/,
    'the ref list is not a remote existence check',
  );
});

test('the publish target prefers the upstream remote and falls back to the first configured remote', () => {
  const card = read('src/webview/GetStartedCard.tsx');
  assert.match(card, /status\?\.upstream\.split\('\/'\)\[0\]/, 'an existing upstream names the target');
  assert.match(card, /remotes\[0\]/, 'otherwise the first configured remote does');
  assert.doesNotMatch(card, /firstRemoteName\(graph\?\.refs/, 'no ref-derived remote name');
});

test('merged pull requests reach the model, from a closed list loaded when the step needs it', () => {
  // A merged PR only exists in the closed list (`github.ts` maps `merged_at`),
  // and that list loads on a PR view expand. Without this the card sits at
  // 3 of 4 forever after the merge, so the done state never fires (AC4).
  const card = read('src/webview/GetStartedCard.tsx');
  assert.match(card, /closedPullRequests/, 'the closed list is read');
  assert.match(card, /loadClosedPullRequests/, 'and requested when the step needs it');
  assert.match(
    card,
    /pullRequests:[\s\S]{0,200}closedPullRequests/,
    'both lists reach computeSteps',
  );
  assert.match(
    card,
    /closedLoaded/,
    'an already loaded list is not requested again',
  );
});

test('an explicit dismiss returns focus to the list, and the auto-hide does not steal it', () => {
  const card = read('src/webview/GetStartedCard.tsx');
  assert.match(card, /onDismissed/, 'the card hands focus back to its host');

  const timer = card.slice(card.indexOf('setTimeout('), card.indexOf('setTimeout(') + 200);
  assert.ok(timer.length > 0, 'the auto-hide timer exists');
  assert.doesNotMatch(timer, /onDismissed/, 'a timer is not a user action and must not move focus');

  const pending = read('src/webview/PendingChanges.tsx');
  assert.match(pending, /onDismissed=\{/, 'the Changes view supplies the focus target');
  assert.match(pending, /tabIndex=\{-1\}/, 'the panel itself can take focus when the list is empty');
});

test('the card styles use design tokens and no colour literal', () => {
  const css = read('src/webview/styles.css')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /\.gc-started\b/);
  const block = css.slice(css.indexOf('.gc-started'), css.indexOf('.gc-started') + 4000);
  assert.match(block, /var\(--gc-/, 'tokens, not literals');
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
});
