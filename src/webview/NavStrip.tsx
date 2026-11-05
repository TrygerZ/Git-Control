/**
 * Sidebar nav strip.
 *
 * Changes registers itself here because this is the only view that ships with
 * the strip; every later view registers in its own phase. The strip hides below
 * two destinations (D-06) and never requests anything: counts arrive from the
 * stores that already fetched them.
 */
import type { JSX } from 'react';
import { isNavVisible, navRegistry, navTabs, routeForNav } from './navRegistry';
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

export function NavStrip(): JSX.Element | null {
  const strings = useT();
  const route = useRouteStore((s) => s.route);
  const changesCount = useChangesStore((s) => s.changes.length);
  const counts = useNavStore((s) => s.counts);
  const failing = useNavStore((s) => s.failing);
  const signedIn = useGitHubStore((s) => s.auth?.connected === true);

  const dests = navRegistry.list();
  if (!isNavVisible(dests.length)) return null;

  const tabs = navTabs(dests, strings, { counts: { ...counts, changes: changesCount }, failing, signedIn });

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
