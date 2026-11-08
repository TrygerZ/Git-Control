/**
 * Poll scheduler core (P12).
 *
 * The module owns no timers: it answers "poll now, and after how long" so the
 * view can own the `setTimeout`. That makes every rule below testable without
 * fake clocks, and keeps one scheduling policy instead of one per view.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLL_CONFIG,
  applyResult,
  nextPoll,
  type PollConfig,
  type PollState,
} from '../src/webview/pollPlan';

function state(overrides: Partial<PollState> = {}): PollState {
  return {
    visible: true,
    active: true,
    inFlight: false,
    consecutiveUnchanged: 0,
    consecutiveErrors: 0,
    rateLimited: false,
    offline: false,
    ...overrides,
  };
}

function config(overrides: Partial<PollConfig> = {}): PollConfig {
  return { ...DEFAULT_POLL_CONFIG, ...overrides };
}

test('hidden blocks polling when no hidden interval is configured', () => {
  assert.deepEqual(nextPoll(state({ visible: false }), config()), { poll: false, reason: 'hidden' });
});

test('a configured hidden interval still polls, clamped to the bounds', () => {
  const decision = nextPoll(state({ visible: false }), config({ hiddenMs: 300_000 }));
  assert.equal(decision.poll, true);
  if (!decision.poll) return;
  assert.equal(decision.delayMs, DEFAULT_POLL_CONFIG.maxMs, 'never above maxMs');
});

test('idle blocks polling', () => {
  assert.deepEqual(nextPoll(state({ active: false }), config()), { poll: false, reason: 'idle' });
});

test('an in-flight read blocks the next poll', () => {
  assert.deepEqual(nextPoll(state({ inFlight: true }), config()), { poll: false, reason: 'in-flight' });
});

test('a rate-limited or offline client blocks polling', () => {
  assert.deepEqual(nextPoll(state({ rateLimited: true }), config()), { poll: false, reason: 'rate-limited' });
  assert.deepEqual(nextPoll(state({ offline: true }), config()), { poll: false, reason: 'offline' });
});

test('a fresh active state polls at the base interval', () => {
  const decision = nextPoll(state(), config());
  assert.equal(decision.poll, true);
  if (!decision.poll) return;
  assert.equal(decision.delayMs, 15_000);
});

test('a server hint above the base raises the floor', () => {
  const decision = nextPoll(state(), config({ serverMinMs: 60_000 }));
  assert.equal(decision.poll, true);
  if (!decision.poll) return;
  assert.equal(decision.delayMs, 60_000);
});

test('a server hint below the base does not lower it', () => {
  const decision = nextPoll(state(), config({ serverMinMs: 5_000 }));
  assert.equal(decision.poll, true);
  if (!decision.poll) return;
  assert.equal(decision.delayMs, 15_000);
});

test('unchanged results double the delay up to the cap', () => {
  const delays = [0, 1, 2, 3, 9].map((consecutiveUnchanged) => {
    const decision = nextPoll(state({ consecutiveUnchanged }), config());
    assert.equal(decision.poll, true);
    return decision.poll ? decision.delayMs : -1;
  });
  assert.deepEqual(delays, [15_000, 30_000, 60_000, 120_000, 120_000]);
});

test('errors back off and cap', () => {
  const delays = [0, 1, 2, 3, 4].map((consecutiveErrors) => {
    const decision = nextPoll(state({ consecutiveErrors }), config());
    assert.equal(decision.poll, true);
    return decision.poll ? decision.delayMs : -1;
  });
  // base 15s plus 15/30/60/120s of backoff, clamped at 120s.
  assert.deepEqual(delays, [15_000, 30_000, 60_000, 120_000, 120_000]);
});

test('a changed result resets both counters', () => {
  const before = state({ consecutiveUnchanged: 3, consecutiveErrors: 2 });
  const after = applyResult(before, 'changed', { rateLimited: false, offline: false });
  assert.equal(after.consecutiveUnchanged, 0);
  assert.equal(after.consecutiveErrors, 0);
});

test('an unchanged result grows the unchanged counter and clears the error streak', () => {
  const after = applyResult(state({ consecutiveUnchanged: 1, consecutiveErrors: 2 }), 'unchanged', {
    rateLimited: false,
    offline: false,
  });
  assert.equal(after.consecutiveUnchanged, 2);
  assert.equal(after.consecutiveErrors, 0, 'a 304 proves the API answered, so the error streak is over');
});

test('an error grows the error counter and takes the flags from the caller', () => {
  const after = applyResult(state({ consecutiveUnchanged: 2, consecutiveErrors: 1 }), 'error', {
    rateLimited: true,
    offline: true,
  });
  assert.equal(after.consecutiveErrors, 2);
  assert.equal(after.consecutiveUnchanged, 2, 'an error says nothing about the payload');
  assert.equal(after.rateLimited, true);
  assert.equal(after.offline, true);
});

test('applyResult never mutates its input', () => {
  const before = state({ consecutiveUnchanged: 1, consecutiveErrors: 1 });
  const snapshot = { ...before };
  applyResult(before, 'error', { rateLimited: true, offline: true });
  applyResult(before, 'changed', { rateLimited: false, offline: false });
  assert.deepEqual(before, snapshot);
});

test('the delay stays inside the bounds for any reachable state', () => {
  // Seeded so a failure is reproducible, and wide enough to hit every branch.
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let i = 0; i < 200; i += 1) {
    const cfg = config({
      baseMs: 1_000 + Math.floor(next() * 20_000),
      maxMs: 30_000 + Math.floor(next() * 200_000),
      serverMinMs: next() < 0.5 ? null : Math.floor(next() * 90_000),
    });
    const s = state({
      consecutiveUnchanged: Math.floor(next() * 6),
      consecutiveErrors: Math.floor(next() * 6),
    });
    const decision = nextPoll(s, cfg);
    if (!decision.poll) continue;
    assert.ok(decision.delayMs >= cfg.baseMs, `below base: ${decision.delayMs} < ${cfg.baseMs}`);
    assert.ok(decision.delayMs <= cfg.maxMs, `above max: ${decision.delayMs} > ${cfg.maxMs}`);
  }
});

test('the default config polls every 15 s and never while hidden', () => {
  assert.equal(DEFAULT_POLL_CONFIG.baseMs, 15_000);
  assert.equal(DEFAULT_POLL_CONFIG.maxMs, 120_000);
  assert.equal(DEFAULT_POLL_CONFIG.hiddenMs, null);
  assert.equal(DEFAULT_POLL_CONFIG.serverMinMs, null);
});
