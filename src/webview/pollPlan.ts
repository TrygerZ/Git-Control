/**
 * Poll scheduler core (P12). Stub: the signature the tests import.
 * Body throws until the implementation lands.
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

export function nextPoll(_state: PollState, _config: PollConfig): PollDecision {
  throw new Error('not implemented');
}

export function applyResult(
  _state: PollState,
  _result: 'changed' | 'unchanged' | 'error',
  _flags: { rateLimited: boolean; offline: boolean },
): PollState {
  throw new Error('not implemented');
}
