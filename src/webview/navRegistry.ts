/**
 * Pure sidebar nav registry, tab key model, and route selection.
 *
 * The strip stays hidden below two destinations (D-06), so registering the
 * shared registry before a second view exists cannot change what users see.
 * Ordering lives here rather than in the render tree so the strip and the
 * keyboard model agree on one source of truth.
 */
import type { Route, RouteId } from '../messages';
import type { Catalog } from './i18n';
import type { IconName } from './icons';
import { DEFAULT_ROUTE, parseRoute } from './route';

export interface NavDestination {
  id: RouteId;
  order: number;
  icon: IconName;
  label: (strings: Catalog) => string;
  ariaName: (strings: Catalog, count: number | null) => string;
  requiresGitHub: boolean;
}

export interface NavRegistry {
  register(dest: NavDestination): void;
  list(): readonly NavDestination[];
}

export const MIN_VISIBLE_DESTINATIONS = 2;

export function createNavRegistry(): NavRegistry {
  const destinations = new Map<RouteId, NavDestination>();
  return {
    register(dest) {
      destinations.set(dest.id, dest);
    },
    list() {
      return [...destinations.values()].sort((a, b) => a.order - b.order);
    },
  };
}

/** One shared registry. The strip registers `changes` when it mounts. */
export const navRegistry: NavRegistry = createNavRegistry();

export function isNavVisible(count: number): boolean {
  return count >= MIN_VISIBLE_DESTINATIONS;
}

export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Reuse `parseRoute` so the default sub-tab table stays in one place. */
export function routeForNav(current: Route, target: RouteId): Route {
  if (current.id === target) return current;
  return parseRoute({ id: target }) ?? DEFAULT_ROUTE;
}
