/**
 * Pure policy for GitHub write actions.
 *
 * Same contract as {@link SafetyGuard}: takes a snapshot of the connection plus
 * the requested action and returns a verdict the bridge must honour. Pure by
 * construction (no vscode, no fetch, no clock), so every rule is unit-testable
 * without an editor or a network.
 *
 * The order of checks is deliberate: token trust, then connection, then
 * reachability, then permission, then confirmation. The first blocking rule wins
 * so the user sees the most fundamental problem. Trust precedes connection
 * because `githubAuth` reports a withheld token as disconnected, so a
 * connection-first order would tell a user on an untrusted base to connect,
 * advice that can never work. `unknown` scope (fine-grained tokens expose none)
 * never blocks: the attempt runs and a 403 becomes the permission message,
 * which is the only honest answer when the token cannot say.
 */
import type { GuardVerdict } from './guard';
import type { Lang } from './messages';
import { hostText } from './hostText';

export type GitHubWriteAction =
  | { action: 'create-pull-request'; draft: boolean }
  | { action: 'merge-pull-request'; method: 'merge' | 'squash' }
  | { action: 'submit-review'; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' }
  | { action: 'comment' }
  | { action: 'close-issue' }
  | { action: 'create-issue' }
  | { action: 'rerun-failed-jobs' }
  | { action: 'dispatch-workflow' }
  | { action: 'create-release' };

export interface GitHubGuardContext {
  connected: boolean;
  /** `null` when the token type does not expose scopes (fine-grained). */
  scopes: readonly string[] | null;
  /** False when the API base was derived from a remote URL. */
  tokenAllowed: boolean;
  circuitOpen: boolean;
}

export type GitHubGuardVerdict = GuardVerdict;

/** Writes that change shared state; the rest are additive and reversible. */
const CONFIRM_ACTIONS = new Set<GitHubWriteAction['action']>([
  'merge-pull-request',
  'create-release',
  'dispatch-workflow',
  'close-issue',
]);

/** `repo` covers every write; `public_repo` is its public-only equivalent. */
const WRITE_SCOPES: readonly string[] = ['repo', 'public_repo'];

/**
 * One coarse scope covers every write in this phase. Narrow per-action scopes
 * when fine-grained tokens expose them; until then a single check keeps the
 * gate honest instead of guessing at a permission the token cannot report.
 */
export function requiredScopes(action: GitHubWriteAction): readonly string[] {
  return ['repo'];
}

export function hasWriteScope(
  scopes: readonly string[] | null,
  action: GitHubWriteAction,
): 'yes' | 'no' | 'unknown' {
  if (scopes === null) return 'unknown';
  return scopes.some((scope) => WRITE_SCOPES.includes(scope)) ? 'yes' : 'no';
}

export function evaluateGitHubAction(
  action: GitHubWriteAction,
  ctx: GitHubGuardContext,
  lang: Lang = 'en',
): GitHubGuardVerdict {
  const text = hostText(lang).github;

  // Order matters: token trust, connection, reachability, permission, then
  // confirmation, so the user always sees the most fundamental problem first.
  //
  // Trust precedes connection on purpose. `githubAuth` reports an untrusted base
  // as disconnected, so checking connection first would answer "connect GitHub"
  // to a user who is already connected and for whom connecting can never help.
  if (!ctx.tokenAllowed) {
    return { allow: false, code: 'FORBIDDEN', message: text.tokenNotTrusted, remedies: ['cancel'] };
  }
  if (!ctx.connected) {
    return { allow: false, code: 'AUTH_ERROR', message: text.notConnected, remedies: ['cancel'] };
  }
  if (ctx.circuitOpen) {
    return { allow: false, code: 'UNAVAILABLE', message: text.writeUnavailable, remedies: ['cancel'] };
  }
  if (hasWriteScope(ctx.scopes, action) === 'no') {
    return { allow: false, code: 'FORBIDDEN', message: text.missingScope('repo'), remedies: ['cancel'] };
  }

  const reviewVerdict = action.action === 'submit-review' && action.event !== 'COMMENT';
  if (CONFIRM_ACTIONS.has(action.action) || reviewVerdict) {
    // Merging, releasing, dispatching, closing, and a review verdict change
    // shared state; an additive comment does not.
    return {
      allow: false,
      code: 'CONFIRMATION_REQUIRED',
      message: text.confirmWrite,
      remedies: ['confirm', 'cancel'],
      requiresConfirmation: true,
      confirmationLevel: 1,
      risk: reviewVerdict || action.action === 'close-issue' ? 'low' : 'medium',
    };
  }

  return { allow: true };
}
