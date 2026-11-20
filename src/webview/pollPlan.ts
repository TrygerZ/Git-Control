/**
 * Poll scheduler core (P12).
 *
 * Owns no timers: it answers whether to poll and after how long, and the caller
 * owns the `setTimeout`. One scheduling policy for every view instead of one per
 * view, and every rule is testable without fake clocks.
 */
export interface PollConfig {
  baseMs: number;
  maxMs: number;
  hiddenMs: number | null;
  serverMinMs: number | null;
}

export interface PollState {
  visible: boolean;
  active: boolean;
  inFlight: boolean;
  consecutiveUnchanged: number;
  consecutiveErrors: number;
  rateLimited: boolean;
  offline: boolean;
}

export type PollDecision =
  | { poll: false; reason: 'hidden' | 'idle' | 'in-flight' | 'rate-limited' | 'offline' }
  | { poll: true; delayMs: number };

export const DEFAULT_POLL_CONFIG: PollConfig = {
  baseMs: 15_000,
  maxMs: 120_000,
  hiddenMs: null,
  serverMinMs: null,
};

export function nextPoll(state: PollState, config: PollConfig): PollDecision {
  if (!state.visible && config.hiddenMs === null) {
    return { poll: false, reason: 'hidden' };
  }
  if (!state.active) {
    return { poll: false, reason: 'idle' };
  }
  if (state.inFlight) {
    return { poll: false, reason: 'in-flight' };
  }
  if (state.rateLimited) {
    return { poll: false, reason: 'rate-limited' };
  }
  if (state.offline) {
    return { poll: false, reason: 'offline' };
  }

  const base = !state.visible && config.hiddenMs !== null
    ? config.hiddenMs
    : Math.max(config.baseMs, config.serverMinMs ?? 0);
  const unchangedMultiplier = 2 ** Math.min(state.consecutiveUnchanged, 3);
  const errorBackoff = state.consecutiveErrors === 0
    ? 0
    : 15_000 * (2 ** Math.min(state.consecutiveErrors, 3) - 1);
  const rawDelay = base * unchangedMultiplier + errorBackoff;
  const delayMs = Math.min(config.maxMs, Math.max(config.baseMs, rawDelay));
  return { poll: true, delayMs };
}

export function applyResult(
  state: PollState,
  result: 'changed' | 'unchanged' | 'error',
  flags: { rateLimited: boolean; offline: boolean },
): PollState {
  let consecutiveUnchanged = state.consecutiveUnchanged;
  let consecutiveErrors = state.consecutiveErrors;

  if (result === 'changed') {
    consecutiveUnchanged = 0;
    consecutiveErrors = 0;
  } else if (result === 'unchanged') {
    consecutiveUnchanged += 1;
    consecutiveErrors = 0;
  } else if (result === 'error') {
    consecutiveErrors += 1;
  }

  return {
    ...state,
    consecutiveUnchanged,
    consecutiveErrors,
    rateLimited: flags.rateLimited,
    offline: flags.offline,
  };
}

/**
 * Post-write burst delays (P27): 5 s, 10 s, 20 s, 30 s before handing back
 * to the steady P12 poll schedule.
 */
export const POLL_BURST_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000];

export function nextBurstDelay(
  step: number,
  state: Pick<PollState, 'visible' | 'inFlight' | 'rateLimited' | 'offline'>,
): number | null {
  if (!state.visible || state.inFlight || state.rateLimited || state.offline) return null;
  if (!Number.isInteger(step) || step < 0 || step >= POLL_BURST_MS.length) return null;
  return POLL_BURST_MS[step] ?? null;
}
