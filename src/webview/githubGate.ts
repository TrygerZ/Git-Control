/**
 * Sidebar GitHub gate (P07).
 *
 * One pure function maps the host snapshot to the single view and the single
 * banner a GitHub-backed tab shows. Pure by contract, like `route.ts`: no
 * react, no DOM, no vscode. The gate never hides cached data, so a list that
 * has already arrived keeps rendering under every banner.
 */
import type {
  ErrorBody,
  GitHubAuthState,
  GitHubLinkage,
  GitHubRateLimit,
} from '../messages';

export type GateViewId = 'prs' | 'issues' | 'actions';

export const AUTH_REQUIRED: Record<GateViewId, boolean> = { prs: false, issues: true, actions: true };

export type GateView = 'loading' | 'no-remote' | 'signed-out' | 'ready';

export type GateBanner =
  | { kind: 'sign-in' }
  | { kind: 'rate-limited'; resetAt: number | null; canConnect: boolean }
  | { kind: 'offline' }
  | { kind: 'invalid-token' }
  | { kind: 'scope-warning'; text: string }
  | { kind: 'metadata-incomplete'; text: string };

export interface GateInput {
  view: GateViewId;
  auth: GitHubAuthState | null;
  linkage: GitHubLinkage | null;
  rateLimit: GitHubRateLimit | null;
  error: ErrorBody | null;
  loading: boolean;
  hasData: boolean;
}

export interface Gate {
  view: GateView;
  banner: GateBanner | null;
}

export const PR_STALE_MS = 60_000;

/** Error codes that mean the read was refused rather than failing. */
const AUTH_ERRORS: ReadonlySet<ErrorBody['code']> = new Set(['AUTH_ERROR', 'FORBIDDEN', 'NOT_FOUND']);

/**
 * Reset timestamp carried by a `RATE_LIMITED` failure.
 *
 * The API refuses the read before any successful response can report
 * `remaining: 0`, so the failure body is the only signal the real quota wall
 * produces. The host encodes it as `resetAt=<epoch ms>`; anything else is not
 * a timestamp and must not be rendered as one.
 */
function resetAtOf(detail: string | undefined): number | null {
  if (detail === undefined) return null;
  const match = /^resetAt=(\d+)$/.exec(detail);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function bannerFor(input: GateInput): GateBanner | null {
  const { auth, rateLimit, error, view } = input;
  if (auth === null) return null;
  if (auth.invalidToken === true) return { kind: 'invalid-token' };
  if (error !== null && error.code === 'RATE_LIMITED') {
    return { kind: 'rate-limited', resetAt: resetAtOf(error.detail), canConnect: !auth.connected };
  }
  if (rateLimit !== null && rateLimit.remaining === 0) {
    return { kind: 'rate-limited', resetAt: rateLimit.resetAt, canConnect: !auth.connected };
  }
  if (rateLimit !== null && rateLimit.offline) return { kind: 'offline' };
  if (auth.scopeWarning !== undefined) return { kind: 'scope-warning', text: auth.scopeWarning };
  if (error !== null) return { kind: 'metadata-incomplete', text: error.message };
  if (view === 'prs' && !auth.connected) return { kind: 'sign-in' };
  return null;
}

export function githubGate(input: GateInput): Gate {
  const { view, auth, linkage } = input;
  if (linkage === null || auth === null) {
    // A still-loading snapshot shows the skeleton; a settled failure shows the
    // Connect affordance, which retries through `connect()`.
    return { view: input.loading ? 'loading' : 'signed-out', banner: null };
  }
  if (!linkage.available) return { view: 'no-remote', banner: null };
  if (AUTH_REQUIRED[view] && !auth.connected) return { view: 'signed-out', banner: null };
  if (
    view === 'prs' &&
    !auth.connected &&
    !input.hasData &&
    input.error !== null &&
    AUTH_ERRORS.has(input.error.code)
  ) {
    return { view: 'signed-out', banner: null };
  }
  return { view: 'ready', banner: bannerFor(input) };
}

export function isStale(loadedAt: number | null, now: number, ttlMs: number = PR_STALE_MS): boolean {
  if (loadedAt === null) return true;
  return now - loadedAt > ttlMs;
}
