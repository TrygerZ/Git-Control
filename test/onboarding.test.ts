/**
 * Get started checklist (P16).
 *
 * The card's whole judgement lives in the pure module: which steps apply, which
 * one is current, when the card is visible, and what the compare link says. The
 * component only renders the answer, so every rule in PHASE_16 section 5.1 is
 * pinned here without a DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cardPhase,
  compareUrl,
  computeSteps,
  progress,
  type OnboardingInput,
  type OnboardingStep,
  type StepId,
} from '../src/webview/onboarding';

function input(over: Partial<OnboardingInput> = {}): OnboardingInput {
  return {
    head: 'abc123',
    branch: 'feat/a',
    upstream: 'origin/feat/a',
    hasRemote: true,
    github: { linked: true, connected: true, webUrl: 'https://github.com/o/r' },
    pullRequests: [{ headRef: 'feat/a', state: 'open' }],
    createPrAvailable: false,
    ...over,
  };
}

function step(steps: readonly OnboardingStep[] | null, id: StepId): OnboardingStep | undefined {
  return steps?.find((entry) => entry.id === id);
}

function stateOf(steps: readonly OnboardingStep[] | null, id: StepId): string | undefined {
  return step(steps, id)?.state;
}

/** Steps the user actually sees: `na` is hidden, not drawn greyed out. */
function visible(steps: readonly OnboardingStep[] | null): OnboardingStep[] {
  return (steps ?? []).filter((entry) => entry.state !== 'na');
}

// ------------------------------------------------------------ derivation

test('a GitHub remote, signed in, with a commit, a published branch, and an open PR gives four done', () => {
  const steps = computeSteps(input());
  assert.deepEqual(
    visible(steps).map((entry) => [entry.id, entry.state]),
    [
      ['connect', 'done'],
      ['commit', 'done'],
      ['publish', 'done'],
      ['pull-request', 'done'],
    ],
  );
  assert.equal(progress(visible(steps)).done, 4);
  assert.equal(progress(visible(steps)).total, 4);
});

test('signed out makes connect current, even with a null PR list from a private repository', () => {
  const steps = computeSteps(
    input({
      github: { linked: true, connected: false, webUrl: 'https://github.com/o/r' },
      pullRequests: null,
    }),
  );
  assert.ok(steps !== null, 'a signed-out private repository still shows the card');
  assert.equal(stateOf(steps, 'connect'), 'current');
  assert.equal(stateOf(steps, 'commit'), 'done');
  assert.equal(stateOf(steps, 'publish'), 'done');
  assert.equal(stateOf(steps, 'pull-request'), 'todo', 'an unknown list is an empty list while signed out');
  assert.deepEqual(step(steps, 'connect')?.action, { kind: 'connect' });
});

test('a non-GitHub remote keeps two steps and never offers a GitHub action', () => {
  const steps = computeSteps(
    input({
      github: { linked: false, connected: false, webUrl: null },
      pullRequests: null,
    }),
  );
  assert.deepEqual(
    visible(steps).map((entry) => entry.id),
    ['commit', 'publish'],
  );
  assert.equal(stateOf(steps, 'connect'), 'na');
  assert.equal(stateOf(steps, 'pull-request'), 'na');
});

test('no remote leaves only the commit step', () => {
  const steps = computeSteps(
    input({
      head: null,
      branch: 'feat/a',
      upstream: null,
      hasRemote: false,
      github: { linked: false, connected: false, webUrl: null },
      pullRequests: null,
    }),
  );
  assert.deepEqual(
    visible(steps).map((entry) => [entry.id, entry.state]),
    [['commit', 'current']],
  );
});

test('a detached HEAD hides publish and the pull request step', () => {
  const steps = computeSteps(input({ branch: null, upstream: null }));
  assert.equal(stateOf(steps, 'commit'), 'done');
  assert.equal(stateOf(steps, 'publish'), 'na');
  assert.equal(stateOf(steps, 'pull-request'), 'na');
});

test('unknown inputs make the card hidden instead of flickering', () => {
  // `null` (not `[]`) is the unknown signal: an empty list would read as "every
  // applicable step is done", which is the celebration this rule exists to avoid.
  assert.equal(computeSteps(input({ hasRemote: null })), null, 'remotes not loaded yet');
  assert.equal(computeSteps(input({ pullRequests: null })), null, 'signed in, PR list not loaded yet');
  assert.equal(
    cardPhase(null, { dismissed: false, sawIncomplete: true, forced: true }),
    'hidden',
    'unknown beats even a forced card',
  );
});

test('a closed pull request does not complete the last step, a merged one does', () => {
  const closed = computeSteps(input({ pullRequests: [{ headRef: 'feat/a', state: 'closed' }] }));
  assert.equal(stateOf(closed, 'pull-request'), 'current');

  const merged = computeSteps(input({ pullRequests: [{ headRef: 'feat/a', state: 'merged' }] }));
  assert.equal(stateOf(merged, 'pull-request'), 'done');
});

test('another branch PR does not count', () => {
  const steps = computeSteps(input({ pullRequests: [{ headRef: 'feat/b', state: 'open' }] }));
  assert.equal(stateOf(steps, 'pull-request'), 'current');
});

test('the current step is the first applicable one that is not done', () => {
  const steps = computeSteps(
    input({
      head: null,
      upstream: null,
      pullRequests: [],
    }),
  );
  assert.deepEqual(
    visible(steps).map((entry) => [entry.id, entry.state]),
    [
      ['connect', 'done'],
      ['commit', 'current'],
      ['publish', 'todo'],
      ['pull-request', 'todo'],
    ],
  );
});

test('publish is current with a publish action while the branch has no upstream', () => {
  const steps = computeSteps(input({ upstream: null, pullRequests: [] }));
  assert.equal(stateOf(steps, 'publish'), 'current');
  assert.deepEqual(step(steps, 'publish')?.action, { kind: 'publish' });
  assert.equal(step(steps, 'commit')?.action, null, 'the commit form is already on screen');
});

test('the pull request step opens the compare page until create-pr ships', () => {
  const steps = computeSteps(input({ pullRequests: [] }));
  assert.equal(stateOf(steps, 'pull-request'), 'current');
  assert.deepEqual(step(steps, 'pull-request')?.action, {
    kind: 'open-compare',
    url: 'https://github.com/o/r/compare/feat/a?expand=1',
  });

  const withDialog = computeSteps(input({ pullRequests: [], createPrAvailable: true }));
  assert.deepEqual(step(withDialog, 'pull-request')?.action, { kind: 'create-pr' });
});

test('actions hang off the current step only', () => {
  const steps = computeSteps(input({ head: null, upstream: null, pullRequests: [] }));
  assert.equal(step(steps, 'commit')?.action, null);
  assert.equal(step(steps, 'publish')?.action, null, 'a todo step draws no button');
  assert.equal(step(steps, 'pull-request')?.action, null);
});

// ----------------------------------------------------------------- progress

test('progress counts done against applicable steps and ignores na', () => {
  const steps = computeSteps(
    input({
      head: 'abc123',
      upstream: null,
      hasRemote: true,
      github: { linked: false, connected: false, webUrl: null },
      pullRequests: null,
    }),
  );
  assert.deepEqual(progress(visible(steps)), { done: 1, total: 2 });
  assert.deepEqual(progress([]), { done: 0, total: 0 });
});

// ------------------------------------------------------------------- phases

test('a dismissed card is hidden, whatever the steps say', () => {
  const steps = computeSteps(input({ head: null, upstream: null, pullRequests: [] }));
  assert.equal(cardPhase(steps, { dismissed: true, sawIncomplete: true, forced: false }), 'hidden');
});

test('unknown steps are hidden', () => {
  assert.equal(cardPhase(null, { dismissed: false, sawIncomplete: false, forced: false }), 'hidden');
});

test('an incomplete card is active', () => {
  const steps = computeSteps(input({ head: null, upstream: null, pullRequests: [] }));
  assert.equal(cardPhase(steps, { dismissed: false, sawIncomplete: false, forced: false }), 'active');
});

test('all done on first load stays hidden: no celebration for a finished repository', () => {
  const steps = computeSteps(input());
  assert.equal(cardPhase(steps, { dismissed: false, sawIncomplete: false, forced: false }), 'hidden');
});

test('all done after the card was seen incomplete shows the done state', () => {
  const steps = computeSteps(input());
  assert.equal(cardPhase(steps, { dismissed: false, sawIncomplete: true, forced: false }), 'done');
});

test('forcing the card brings it back, including the done state', () => {
  const incomplete = computeSteps(input({ head: null, upstream: null, pullRequests: [] }));
  assert.equal(cardPhase(incomplete, { dismissed: true, sawIncomplete: false, forced: true }), 'active');

  const complete = computeSteps(input());
  assert.equal(cardPhase(complete, { dismissed: true, sawIncomplete: false, forced: true }), 'done');
});

// --------------------------------------------------------------- compareUrl

test('compareUrl keeps the branch slashes and encodes everything else', () => {
  assert.equal(
    compareUrl('https://github.com/o/r', 'feat/a b#c?d%e'),
    'https://github.com/o/r/compare/feat/a%20b%23c%3Fd%25e?expand=1',
  );
  assert.equal(
    compareUrl('https://github.com/o/r', 'feat/nested/deep'),
    'https://github.com/o/r/compare/feat/nested/deep?expand=1',
  );
});

test('compareUrl trims a trailing slash on the web url', () => {
  assert.equal(
    compareUrl('https://github.com/o/r/', 'main'),
    'https://github.com/o/r/compare/main?expand=1',
  );
});

test('compareUrl refuses anything that is not an https url', () => {
  assert.equal(compareUrl('http://github.com/o/r', 'main'), null);
  assert.equal(compareUrl('javascript:alert(1)', 'main'), null);
  assert.equal(compareUrl('not a url', 'main'), null);
});

test('compareUrl returns null without both inputs', () => {
  assert.equal(compareUrl(null, 'main'), null);
  assert.equal(compareUrl('https://github.com/o/r', null), null);
});
