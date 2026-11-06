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
  /** Pre-formatted count drawn after the label, for tabs without an icon (sub-tabs). Decoration: the name carries it. */
  count?: string | null;
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
}): JSX.Element | null {
  const { tabs, activeId, onSelect, ariaLabel, idPrefix, classPrefix } = props;
  const ref = useRef<HTMLDivElement>(null);

  // A tablist with no tabs is a dead landmark and an empty track. The sidebar
  // passes an empty set on destinations that have no sub-tabs of their own.
  if (tabs.length === 0) return null;

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
            {typeof tab.count === 'string' && tab.count.length > 0 && (
              <span className={`${classPrefix}__count`} aria-hidden="true">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
