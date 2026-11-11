/**
 * Help panel (P17), frames 105 (Features) and 106 (Shortcuts).
 *
 * Every decision is made by the pure helpers in `helpModel.ts` and the data in
 * `shortcuts.ts`; this component only reads the route and draws.
 */
import { Fragment, useEffect, useRef, type JSX } from 'react';
import { FEATURES, SHIPPED_ROUTES, type Capability } from '../quickActions';
import { bridge } from './bridge';
import {
  helpFeatureRows,
  shortcutGroups,
  type HelpGroupId,
  type HelpTarget,
  type ShortcutGroup,
} from './helpModel';
import {
  toErrorBody,
  useOperationStore,
  useRouteStore,
  useSettingsStore,
} from './store';
import { Tablist, type TabDef } from './Tablist';
import { Icon } from './ui';
import { useT } from './useT';

/**
 * Capabilities this build actually serves. Module scope so the set identity is
 * stable across renders; the pure model filters the rows against it.
 */
const AVAILABLE: ReadonlySet<Capability> = new Set<Capability>([...SHIPPED_ROUTES, ...FEATURES]);

const TITLE_ID = 'gc-help-title';
const PANEL_ID = 'gc-help-panel';
const TABS_PREFIX = 'gc-help-tabs';

/** Fixed reading order of the feature groups. */
const GROUP_ORDER: readonly HelpGroupId[] = ['everyday', 'github', 'organize'];

const GROUP_HEADING: Record<HelpGroupId, string> = {
  everyday: 'groupEveryday',
  github: 'groupGithub',
  organize: 'groupOrganize',
};

const SHORTCUT_HEADING: Record<ShortcutGroup['id'], string> = {
  graph: 'gGraph',
  changes: 'gChanges',
  menus: 'gMenus',
  anywhere: 'gAnywhere',
};

export function HelpPanel(): JSX.Element {
  const strings = useT();
  // The catalog is a fixed object, so a row's key type is `string`, not a keyof.
  const copy = strings.help as unknown as Record<string, string>;

  const route = useRouteStore((s) => s.route);
  const openHelp = useRouteStore((s) => s.openHelp);
  const closeHelp = useRouteStore((s) => s.closeHelp);
  const pushToast = useOperationStore((s) => s.pushToast);

  const titleRef = useRef<HTMLHeadingElement>(null);

  // Opening lands on the heading (section 10). Closing restores the route in the
  // store; the header's info button carries `data-help-open` as the return target.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const tab = route.id === 'help' ? route.tab : 'features';

  const tabs: readonly TabDef[] = [
    {
      id: 'features',
      label: strings.help.tabFeatures,
      ariaLabel: strings.help.tabFeatures,
      panelId: PANEL_ID,
    },
    {
      id: 'shortcuts',
      label: strings.help.tabShortcuts,
      ariaLabel: strings.help.tabShortcuts,
      panelId: PANEL_ID,
    },
  ];

  const openExplorer = async (): Promise<void> => {
    try {
      await bridge.request('actions/openExplorer', {});
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
        message: body.message,
      });
    }
  };

  const openTarget = (target: HelpTarget): void => {
    if (target.kind === 'openExplorer') {
      void openExplorer();
      return;
    }
    switch (target.route) {
      case 'changes':
        if (target.focus === 'publish') {
          useRouteStore.getState().navigateWithFocus({ id: 'changes', sub: 'changes' }, 'publish');
        } else {
          useRouteStore.getState().navigate({ id: 'changes', sub: target.sub ?? 'changes' });
        }
        return;
      case 'branches':
        useRouteStore.getState().navigate({ id: 'branches', sub: 'local' });
        return;
      case 'prs':
      case 'issues':
      case 'actions':
        useRouteStore.getState().navigate({ id: target.route });
        return;
      default:
        return;
    }
  };

  /**
   * Close and return focus to the header button that opened the panel. A feature
   * row does not come through here: it navigates to a view that owns its own
   * focus target, and stealing it back to the header would fight that.
   */
  const leave = (): void => {
    closeHelp();
    document.querySelector<HTMLElement>('[data-help-open]')?.focus();
  };

  const close = (): void => {
    leave();
  };

  const back = (): void => {
    leave();
  };

  const showChecklist = (): void => {
    useSettingsStore.getState().reopenChecklist();
    useRouteStore.getState().navigate({ id: 'changes', sub: 'changes' });
  };

  const rows = helpFeatureRows(AVAILABLE);

  return (
    <section className="gc-help" aria-labelledby={TITLE_ID}>
      <div className="gc-help__head">
        <button type="button" className="gc-icon-button" aria-label={strings.help.backAria} onClick={back}>
          <Icon name="chevron-left" />
        </button>
        <h2 id={TITLE_ID} className="gc-help__title" tabIndex={-1} ref={titleRef}>
          {strings.help.title}
        </h2>
        <button type="button" className="gc-icon-button" aria-label={strings.help.closeAria} onClick={close}>
          <Icon name="close" />
        </button>
      </div>

      <Tablist
        tabs={tabs}
        activeId={tab}
        onSelect={(id) => openHelp(id === 'shortcuts' ? 'shortcuts' : 'features')}
        ariaLabel={strings.help.title}
        idPrefix={TABS_PREFIX}
        classPrefix="gc-subtabs"
      />

      <div role="tabpanel" id={PANEL_ID} aria-labelledby={`${TABS_PREFIX}-tab-${tab}`} tabIndex={-1}>
        {tab === 'features' ? (
          <>
            {GROUP_ORDER.map((group) => {
              const groupRows = rows.filter((row) => row.group === group);
              if (groupRows.length === 0) return null;
              return (
                <div className="gc-help__group" key={group}>
                  <h3 className="gc-help__group-title">{copy[GROUP_HEADING[group]]}</h3>
                  <ul role="list" className="gc-help__rows">
                    {groupRows.map((row) => (
                      <li key={row.id}>
                        <button type="button" className="gc-help__row" onClick={() => openTarget(row.target)}>
                          <span className="gc-help__icon" aria-hidden="true">
                            <Icon name={row.icon} />
                          </span>
                          <span className="gc-help__body">
                            <strong>{copy[row.titleKey]}</strong>
                            <span className="gc-help__desc">{copy[row.descKey]}</span>
                          </span>
                          <span className="gc-help__open">{strings.help.open}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </>
        ) : (
          <>
            <p className="gc-help__intro">{strings.help.shortcutsIntro}</p>
            {shortcutGroups().map((group) => (
              <div className="gc-help__group" key={group.id}>
                <h3 className="gc-help__group-title">{copy[SHORTCUT_HEADING[group.id]]}</h3>
                <dl className="gc-help__keys">
                  {group.entries.map((entry) => (
                    <div className="gc-help__key" key={entry.id}>
                      <dt>{copy[entry.labelKey]}</dt>
                      <dd>
                        {entry.keys.map((key, i) => (
                          <Fragment key={`${entry.id}-${key}`}>
                            {i > 0 && entry.joiner !== null && (
                              <span>{entry.joiner === 'or' ? strings.help.or : '+'}</span>
                            )}
                            <kbd className="gc-kbd">{key}</kbd>
                          </Fragment>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </>
        )}
      </div>

      {AVAILABLE.has('checklist') && (
        <button type="button" className="gc-help__footer" onClick={showChecklist}>
          <Icon name="sparkle" />
          <span>{strings.help.showChecklist}</span>
        </button>
      )}
    </section>
  );
}
