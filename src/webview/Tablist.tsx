/**
 * Generic WAI-ARIA tabs. Roving tabindex plus automatic activation: switching
 * views is instant and cheap, so moving focus with the arrow keys may as well
 * select. The prefix keeps it reusable; P06 drives its sub-tabs with the same
 * component.
 */
import { useRef } from 'react';
import type { JSX } from 'react';
import type { IconName } from './icons';
import { nextTabIndex } from './navRegistry';
import { Icon } from './ui';

export interface TabDef {
  id: string;
  label: string;
  ariaLabel: string;
  icon?: IconName;
  badge?: string | null;
  dot?: boolean;
  /** Id of the panel this tab controls. Omitted until a panel exists, so no IDREF dangles. */
  panelId?: string;
}

export function Tablist(props: {
  tabs: readonly TabDef[];
  activeId: string;
  onSelect(id: string): void;
  ariaLabel: string;
  idPrefix: string;
  classPrefix: string;
}): JSX.Element {
  const { tabs, activeId, onSelect, ariaLabel, idPrefix, classPrefix } = props;
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div role="tablist" aria-label={ariaLabel} className={classPrefix} ref={ref}>
      {tabs.map((tab, i) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            className={active ? `${classPrefix}__tab ${classPrefix}__tab--active` : `${classPrefix}__tab`}
            aria-selected={active}
            aria-controls={tab.panelId}
            aria-label={tab.ariaLabel}
            title={tab.ariaLabel}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              const next = nextTabIndex(i, event.key, tabs.length);
              if (next === null) return;
              event.preventDefault();
              const target = tabs[next];
              if (target === undefined) return;
              onSelect(target.id);
              ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}
          >
            {tab.icon !== undefined && (
              <span className={`${classPrefix}__icon`}>
                <Icon name={tab.icon} />
                {typeof tab.badge === 'string' && tab.badge.length > 0 && (
                  <span className={`${classPrefix}__badge`} aria-hidden="true">{tab.badge}</span>
                )}
                {tab.dot === true && <span className={`${classPrefix}__dot`} aria-hidden="true" />}
              </span>
            )}
            <span className={`${classPrefix}__label`}>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
