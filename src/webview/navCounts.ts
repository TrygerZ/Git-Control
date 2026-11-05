import type { RouteId } from '../messages';

/** Count per view. `null` means unknown or still loading, which draws no badge. */
export type NavCounts = Partial<Record<RouteId, number | null>>;

/**
 * Pure sidebar nav badge text.
 *
 * A signed-out user must not see a count the host cannot supply, so the
 * GitHub gate lives here instead of in each render site. Counts cap at 99+
 * because the badge has room for two digits.
 */

export function formatBadge(count: number | null | undefined): string | null {
  if (count === null || count === undefined || !Number.isInteger(count) || count < 1) return null;
  return count >= 100 ? '99+' : String(count);
}

export function navBadge(
  dest: { requiresGitHub: boolean },
  count: number | null | undefined,
  signedIn: boolean,
): string | null {
  if (dest.requiresGitHub && !signedIn) return null;
  return formatBadge(count);
}
