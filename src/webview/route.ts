/**
 * Pure sidebar route model.
 *
 * No react, DOM, or vscode imports. A route reaches this module from three places
 * (a host event, a pulled pending route, and webview `getState`), and none of
 * them is trusted: `parseRoute` is the single gate, and it drops what it does not
 * recognise instead of storing it.
 */
import type { BranchesSub, ChangesSub, Route } from '../messages';

export const DEFAULT_ROUTE: Route = { id: 'changes', sub: 'changes' };

/** A queued route older than this is dropped, so a stale command cannot hijack a later open. */
export const PENDING_ROUTE_TTL_MS = 30_000;

const CHANGES_SUBS: readonly ChangesSub[] = ['changes', 'stashes'];
const BRANCHES_SUBS: readonly BranchesSub[] = ['local', 'remote', 'tags'];

/**
 * Narrow an unknown value to a {@link Route}, or null. A missing `sub` takes the
 * default for its view. A `sub` on a view without sub-tabs is rejected, not ignored.
 * Only known fields are copied, so extra keys never survive.
 */
export function parseRoute(raw: unknown): Route | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, sub, tab } = raw as { id?: unknown; sub?: unknown; tab?: unknown };
  switch (id) {
    case 'changes':
      if (sub === undefined) return { id, sub: 'changes' };
      return CHANGES_SUBS.find((s) => s === sub) === undefined ? null : { id, sub: sub as ChangesSub };
    case 'branches':
      if (sub === undefined) return { id, sub: 'local' };
      return BRANCHES_SUBS.find((s) => s === sub) === undefined ? null : { id, sub: sub as BranchesSub };
    case 'help':
      // `tab` is validated like `sub`: the route arrives from the host and from
      // storage, so an unknown tab is dropped rather than rendered as a blank panel.
      if (sub !== undefined) return null;
      if (tab === undefined) return { id, tab: 'features' };
      return tab === 'features' || tab === 'shortcuts' ? { id, tab } : null;
    case 'prs':
    case 'issues':
    case 'actions':
      return sub === undefined ? { id } : null;
    default:
      return null;
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  if (a.id !== b.id) return false;
  return ('sub' in a ? a.sub : undefined) === ('sub' in b ? b.sub : undefined);
}

/** Which Changes sub-view a route shows; any other view falls back to `changes`. */
export function changesSubOf(route: Route): ChangesSub {
  return route.id === 'changes' ? route.sub : 'changes';
}

/** Startup route: a one-shot from the host wins, then webview state, then the default. */
export function resolveInitialRoute(input: { pending: Route | null; local: unknown }): Route {
  return input.pending ?? parseRoute(input.local) ?? DEFAULT_ROUTE;
}

/** True while `nowMs` is within `ttlMs` of `createdAtMs`, boundary inclusive. */
export function isFresh(createdAtMs: number, nowMs: number, ttlMs: number): boolean {
  return nowMs - createdAtMs <= ttlMs;
}
