/**
 * Explorer header actions (P18): Help and the More menu, frames 01 and 17.
 *
 * These sit beside `ContextBar`, not inside it: the bar returns null until the
 * first status arrives, and Help must stay reachable in every state. Every row
 * navigates, opens the palette, refreshes, reveals the output channel, or
 * connects GitHub. No row can run a git mutation, and `explorerMenu.ts` decides
 * the rows, so the menu cannot grow into a command channel.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { bridge } from './bridge';
import {
  buildMoreMenu,
  quickActionsHint,
  type MenuGroupId,
  type MenuItemId,
  type MoreMenuItem,
} from './explorerMenu';
import { countByFilter } from './prFilters';
import { SHIPPED_ROUTES } from '../quickActions';
import {
  toErrorBody,
  useChangesStore,
  useGitHubStore,
  useOperationStore,
  useRepoStore,
} from './store';
import { Icon } from './ui';
import { useT } from './useT';
import type { RequestPayload } from '../messages';

/** The only requests this header may send; each carries a route or nothing. */
type HeaderRequest =
  | 'actions/openSidebarView'
  | 'actions/openQuickActions'
  | 'actions/pickRepository';

/** Which group a row belongs to, derived from its id so the model stays the source. */
function groupOf(item: MoreMenuItem): MenuGroupId {
  if (item.id === 'quick') return 'quick';
  if (item.id.startsWith('view.')) return 'views';
  if (item.id === 'refresh' || item.id === 'logs') return 'tools';
  if (item.id.startsWith('github.')) return 'github';
  return 'repo';
}

export function ExplorerHeaderActions(): JSX.Element {
  const strings = useT();
  const pushToast = useOperationStore((s) => s.pushToast);
  const changes = useChangesStore((s) => s.changes.length);
  const auth = useGitHubStore((s) => s.auth);
  const linkage = useGitHubStore((s) => s.linkage);
  const pullRequests = useGitHubStore((s) => s.pullRequests);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placed, setPlaced] = useState({ x: 0, y: 0 });
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  /** Same failure shape as `SidebarHeader`: the host explains, the toast repeats it. */
  async function send<K extends HeaderRequest>(
    kind: K,
    payload: RequestPayload<K>,
  ): Promise<void> {
    try {
      await bridge.request(kind, payload);
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
        message: body.message,
      });
    }
  }

  const viewerLogin = auth?.login ?? null;
  const groups = buildMoreMenu({
    available: SHIPPED_ROUTES,
    quickActionsAvailable: true,
    counts: { changes, prs: countByFilter(pullRequests, { viewerLogin }).open },
    github: {
      linked: linkage !== null && linkage.available,
      connected: auth?.connected === true,
      login: viewerLogin,
    },
  });

  const labels: Record<MenuItemId, string> = {
    quick: strings.explorerMenu.quickActions,
    'view.changes': strings.nav.changes,
    'view.prs': strings.nav.prs,
    'view.issues': strings.nav.issues,
    'view.actions': strings.nav.actions,
    'view.branches': strings.nav.branches,
    refresh: strings.explorerMenu.refreshGraph,
    logs: strings.explorerMenu.showGitOutput,
    'github.connect': strings.explorerMenu.connectGithub,
    'github.disconnect': strings.explorerMenu.disconnectGithub,
    repository: strings.explorerMenu.pickRepository,
  };

  /*
   * Frame 17 names two groups. The other three are separated by rules only, so
   * they stay unnamed: borrowing an unrelated catalog string would make a screen
   * reader announce the wrong group name, which is worse than none.
   */
  const groupLabels: Partial<Record<MenuGroupId, string>> = {
    views: strings.explorerMenu.groupViews,
    github: strings.explorerMenu.groupGithub,
  };

  // First open only, never on mount: the counts and the login need this slice.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current && useGitHubStore.getState().auth === null) {
      void useGitHubStore.getState().load();
    }
    wasOpen.current = open;
  }, [open]);

  // Anchor under the trigger, clamped to the viewport like the commit menu, and
  // put focus on the first row so the keyboard path starts where the eye is.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = moreRef.current;
    const menu = menuRef.current;
    if (trigger === null || menu === null) return;
    const anchor = trigger.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const margin = 8;
    const x = Math.max(
      margin,
      Math.min(anchor.right - box.width, window.innerWidth - box.width - margin),
    );
    const y = Math.max(
      margin,
      Math.min(anchor.bottom + 4, window.innerHeight - box.height - margin),
    );
    setPlaced({ x, y });
    setActive(0);
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  // Any outside click closes; pointerdown beats the trigger's own click.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (moreRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const runItem = (item: MoreMenuItem): void => {
    switch (item.id) {
      case 'quick':
        void send('actions/openQuickActions', {});
        return;
      case 'refresh':
        void useRepoStore.getState().refresh();
        return;
      case 'logs':
        useOperationStore.getState().showLogs();
        return;
      case 'github.connect':
        void useGitHubStore.getState().connect();
        return;
      case 'github.disconnect':
        void useGitHubStore.getState().disconnect();
        return;
      case 'repository':
        void send('actions/pickRepository', {});
        return;
      default:
        if (item.route !== null) void send('actions/openSidebarView', { route: item.route });
    }
  };

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) moreRef.current?.focus();
  };

  const move = (delta: number): void => {
    const menu = menuRef.current;
    if (menu === null) return;
    const buttons = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = buttons.findIndex((b) => b === document.activeElement);
    const nextIndex = (index + delta + buttons.length) % buttons.length;
    setActive(nextIndex);
    buttons[nextIndex]?.focus();
  };

  const jump = (to: 'first' | 'last'): void => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const index = to === 'first' ? 0 : buttons.length - 1;
    setActive(index);
    buttons[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close(true);
        return;
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Home':
        event.preventDefault();
        jump('first');
        return;
      case 'End':
        event.preventDefault();
        jump('last');
        return;
      case 'Tab':
        // A menu is not part of the tab ring: close, hand focus to the trigger,
        // and let the browser's default move on from there.
        close(true);
        return;
      default:
    }
  };

  let flatIndex = -1;

  return (
    <div className="gc-explorer__actions">
      <button
        type="button"
        className="gc-icon-button"
        aria-label={strings.help.openAria}
        title={strings.help.openTitle}
        data-help-open=""
        onClick={() =>
          void send('actions/openSidebarView', { route: { id: 'help', tab: 'features' } })
        }
      >
        <Icon name="info" />
      </button>
      <button
        ref={moreRef}
        type="button"
        className="gc-icon-button"
        aria-label={strings.explorerMenu.moreAria}
        title={strings.explorerMenu.moreTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(!open)}
      >
        <Icon name="ellipsis" />
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          className="gc-menu"
          role="menu"
          aria-orientation="vertical"
          aria-label={strings.explorerMenu.menuAria}
          style={{ left: `${placed.x}px`, top: `${placed.y}px` }}
          onKeyDown={onKeyDown}
        >
          {groups.map((members, groupIndex) => {
            const first = members[0];
            if (first === undefined) return null;
            const group = groupOf(first);
            return (
              <div key={group} role="group" aria-label={groupLabels[group] ?? undefined}>
                {groupIndex > 0 && <span className="gc-menu__separator" aria-hidden="true" />}
                {members.map((item) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  const label = labels[item.id];
                  const hint =
                    item.count !== null
                      ? String(item.count)
                      : item.hint === 'shortcut'
                        ? quickActionsHint()
                        : item.hint === 'login'
                          ? (item.login ?? '')
                          : '';
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      className="gc-menu__item"
                      tabIndex={index === active ? 0 : -1}
                      aria-label={
                        item.count !== null
                          ? strings.explorerMenu.itemWithCount(label, String(item.count))
                          : undefined
                      }
                      onFocus={() => setActive(index)}
                      onClick={() => {
                        runItem(item);
                        close(true);
                      }}
                    >
                      <span className="gc-menu__label">{label}</span>
                      {hint !== '' && <span className="gc-menu__hint">{hint}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
