/**
 * Sidebar nav strip.
 *
 * Each view registers itself here when its module loads. The strip hides below
 * two destinations (D-06) and never requests anything: counts arrive from the
 * stores that already fetched them.
 */
import type { JSX } from 'react';
import { isNavVisible, navRegistry, navTabs, routeForNav, type NavDestination } from './navRegistry';
import { PR_PAGE_SIZE, badgeCount, countByFilter } from './prFilters';
import { Tablist } from './Tablist';
import { useChangesStore, useGitHubStore, useNavStore, useRouteStore } from './store';
import { useT } from './useT';

navRegistry.register({
  id: 'changes',
  order: 10,
  icon: 'changes',
  label: (s) => s.nav.changes,
  ariaName: (s, count) => (count === null ? s.nav.changes : s.nav.changesAria(String(count))),
  requiresGitHub: false,
});

/*
 * Pull requests stay readable without a token on a public repository (Q12), so
 * the destination never hides.
 */
const PRS_DESTINATION: NavDestination = {
  id: 'prs',
  order: 20,
  icon: 'pr',
  label: (s) => s.nav.prs,
  ariaName: (s, count) => (count === null ? s.nav.prs : s.nav.prsAria(String(count))),
  requiresGitHub: false,
};

// Module scope, like `changes`: the registry is a static fact about the build,
// so a headless import reports the same destinations the strip will draw.
navRegistry.register(PRS_DESTINATION);

export function NavStrip(): JSX.Element | null {
  const strings = useT();
  const route = useRouteStore((s) => s.route);
  const changesCount = useChangesStore((s) => s.changes.length);
  const pullRequests = useGitHubStore((s) => s.pullRequests);
  const viewerLogin = useGitHubStore((s) => s.auth?.login ?? null);
  const counts = useNavStore((s) => s.counts);
  const failing = useNavStore((s) => s.failing);
  const signedIn = useGitHubStore((s) => s.auth?.connected === true);

  const dests = navRegistry.list();
  if (!isNavVisible(dests.length)) return null;

  // A full page means "at least this many", which the shared 99+ cap cannot say.
  const openPrs = countByFilter(pullRequests, { viewerLogin }).open;
  const prBadge = badgeCount(openPrs, PR_PAGE_SIZE);
  const tabs = navTabs(dests, strings, {
    counts: { ...counts, changes: changesCount, prs: openPrs },
    failing,
    signedIn,
  }).map((tab) => (tab.id === 'prs' ? { ...tab, badge: prBadge } : tab));

  return (
    <Tablist
      tabs={tabs}
      activeId={route.id}
      ariaLabel={strings.nav.tablistAria}
      idPrefix="gc-nav"
      classPrefix="gc-nav"
      onSelect={(id) => {
        const dest = dests.find((d) => d.id === id);
        if (dest === undefined) return;
        useRouteStore.getState().navigate(routeForNav(useRouteStore.getState().route, dest.id));
      }}
    />
  );
}
