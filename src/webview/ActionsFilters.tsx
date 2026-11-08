import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { branchesWithRuns } from './actionsModel';
import { sanitizeGitText } from './format';
import { Icon } from './ui';
import { useActionsStore, useRepoStore } from './store';
import { useT } from './useT';

export function ActionsFilters(): JSX.Element {
  const strings = useT();
  const runs = useActionsStore((s) => s.runs);
  const workflows = useActionsStore((s) => s.workflows);
  const branch = useActionsStore((s) => s.branch);
  const workflowId = useActionsStore((s) => s.workflowId);
  const selectBranch = useActionsStore((s) => s.selectBranch);
  const selectWorkflow = useActionsStore((s) => s.selectWorkflow);
  const status = useRepoStore((s) => s.status);

  const currentBranch = status?.branch ?? null;
  const branchList = useMemo(() => branchesWithRuns(runs, currentBranch), [runs, currentBranch]);

  const [openMenu, setOpenMenu] = useState<'branch' | 'workflow' | null>(null);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });

  const branchButtonRef = useRef<HTMLButtonElement>(null);
  const workflowButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedWorkflow = workflows.find((w) => w.id === workflowId);
  const branchValue = branch !== null ? sanitizeGitText(branch) : strings.actions.allBranches;
  const workflowValue =
    workflowId !== null && selectedWorkflow !== undefined
      ? sanitizeGitText(selectedWorkflow.name)
      : strings.actions.allWorkflows;

  useLayoutEffect(() => {
    if (openMenu === null) return;
    const trigger = openMenu === 'branch' ? branchButtonRef.current : workflowButtonRef.current;
    if (trigger === null) return;
    const box = trigger.getBoundingClientRect();
    const width = menuRef.current?.offsetWidth ?? 240;
    const height = menuRef.current?.offsetHeight ?? 0;
    const margin = 8;
    const x = Math.max(margin, Math.min(box.right - width, window.innerWidth - width - margin));
    const y = Math.min(box.bottom + 4, Math.max(margin, window.innerHeight - height - margin));
    setMenuPos({ x, y });
  }, [openMenu]);

  useEffect(() => {
    if (openMenu === null) return undefined;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [openMenu]);

  const closeMenu = (): void => {
    const trigger = openMenu === 'branch' ? branchButtonRef.current : workflowButtonRef.current;
    setOpenMenu(null);
    trigger?.focus();
  };

  const menuItems = (): HTMLElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

  const moveMenuFocus = (delta: number): void => {
    const items = menuItems();
    if (items.length === 0) return;
    const index = items.findIndex((item) => item === document.activeElement);
    items[(index + delta + items.length) % items.length]?.focus();
  };

  const jumpMenuFocus = (to: 'first' | 'last'): void => {
    const items = menuItems();
    items[to === 'first' ? 0 : items.length - 1]?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
      case 'ArrowLeft':
      case 'Tab':
        event.preventDefault();
        closeMenu();
        return;
      case 'ArrowDown':
        event.preventDefault();
        moveMenuFocus(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveMenuFocus(-1);
        return;
      case 'Home':
        event.preventDefault();
        jumpMenuFocus('first');
        return;
      case 'End':
        event.preventDefault();
        jumpMenuFocus('last');
        return;
      default:
    }
  };

  return (
    <div className="gc-actions__filters" aria-label={strings.actions.filterMenuAria}>
      <button
        ref={branchButtonRef}
        type="button"
        className="gc-actions__filter"
        aria-haspopup="menu"
        aria-expanded={openMenu === 'branch'}
        aria-label={`${strings.actions.branchLabel}: ${branchValue}`}
        onClick={() => setOpenMenu((v) => (v === 'branch' ? null : 'branch'))}
      >
        <span className="gc-actions__filter-label">{strings.actions.branchLabel}</span>
        <span className="gc-actions__filter-value">{branchValue}</span>
        <span className="gc-actions__filter-caret" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </button>

      <button
        ref={workflowButtonRef}
        type="button"
        className="gc-actions__filter"
        aria-haspopup="menu"
        aria-expanded={openMenu === 'workflow'}
        aria-label={`${strings.actions.workflowLabel}: ${workflowValue}`}
        onClick={() => setOpenMenu((v) => (v === 'workflow' ? null : 'workflow'))}
      >
        <span className="gc-actions__filter-label">{strings.actions.workflowLabel}</span>
        <span className="gc-actions__filter-value">{workflowValue}</span>
        <span className="gc-actions__filter-caret" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </button>

      {openMenu === 'branch' && (
        <div
          ref={menuRef}
          className="gc-menu"
          role="menu"
          aria-label={strings.actions.branchMenuTitle}
          style={{ left: `${menuPos.x}px`, top: `${menuPos.y}px` }}
          onKeyDown={onMenuKey}
        >
          <div className="gc-menu__group" role="group">
            <div className="gc-menu__group-title">{strings.actions.branchMenuTitle}</div>
            {branchList.map((b) => (
              <button
                key={b}
                type="button"
                className="gc-menu__item"
                role="menuitemradio"
                aria-checked={branch === b}
                onClick={() => {
                  selectBranch(b);
                  closeMenu();
                }}
              >
                <span className="gc-menu__icon" aria-hidden="true">
                  {branch === b ? <Icon name="check" /> : null}
                </span>
                <span className="gc-menu__body">
                  <span className="gc-menu__label">
                    <span>{sanitizeGitText(b)}</span>
                    {b === currentBranch && (
                      <span className="gc-actions__filter-label" aria-hidden="true">
                        {' '}({strings.actions.currentTag})
                      </span>
                    )}
                  </span>
                </span>
              </button>
            ))}
            <div className="gc-menu__separator" />
            <button
              type="button"
              className="gc-menu__item"
              role="menuitemradio"
              aria-checked={branch === null}
              onClick={() => {
                selectBranch(null);
                closeMenu();
              }}
            >
              <span className="gc-menu__icon" aria-hidden="true">
                {branch === null ? <Icon name="check" /> : null}
              </span>
              <span className="gc-menu__body">
                <span className="gc-menu__label">{strings.actions.allBranches}</span>
              </span>
            </button>
          </div>
        </div>
      )}

      {openMenu === 'workflow' && (
        <div
          ref={menuRef}
          className="gc-menu"
          role="menu"
          aria-label={strings.actions.workflowLabel}
          style={{ left: `${menuPos.x}px`, top: `${menuPos.y}px` }}
          onKeyDown={onMenuKey}
        >
          <div className="gc-menu__group" role="group">
            <div className="gc-menu__group-title">{strings.actions.workflowLabel}</div>
            <button
              type="button"
              className="gc-menu__item"
              role="menuitemradio"
              aria-checked={workflowId === null}
              onClick={() => {
                selectWorkflow(null);
                closeMenu();
              }}
            >
              <span className="gc-menu__icon" aria-hidden="true">
                {workflowId === null ? <Icon name="check" /> : null}
              </span>
              <span className="gc-menu__body">
                <span className="gc-menu__label">{strings.actions.allWorkflows}</span>
              </span>
            </button>
            {workflows.length === 0 ? (
              <div className="gc-menu__item" role="menuitem" aria-disabled="true" tabIndex={-1}>
                <span className="gc-menu__body">
                  <span className="gc-menu__label">{strings.actions.noWorkflows}</span>
                </span>
              </div>
            ) : (
              workflows.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className="gc-menu__item"
                  role="menuitemradio"
                  aria-checked={workflowId === w.id}
                  onClick={() => {
                    selectWorkflow(w.id);
                    closeMenu();
                  }}
                >
                  <span className="gc-menu__icon" aria-hidden="true">
                    {workflowId === w.id ? <Icon name="check" /> : null}
                  </span>
                  <span className="gc-menu__body">
                    <span className="gc-menu__label">{sanitizeGitText(w.name)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
