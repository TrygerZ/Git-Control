/**
 * Sidebar header: three rows on Changes (frame 20), one compact row elsewhere
 * (frames 05, 08, 09, 11).
 *
 * Sidebar only. The Explorer keeps `ContextBar`. Owns no state beyond the More
 * menu: it reads the repo stores and renders `headerModel`. The compact row is a
 * class on the same element, not a second component, so the route decides the
 * shape and the branch, sync, and upstream rows simply unmount.
 *
 * The quick-create button belongs to the destination: Pull requests, Issues, and
 * Branches raise a focus target their view already consumes, while Actions opens
 * the GitHub page until P27 ships a form in the extension. The More menu
 * reuses the Explorer's `.gc-menu` keyboard pattern, copied rather than imported
 * so the two roots stay independent.
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
import { BranchSelector } from './BranchLegend';
import { bridge } from './bridge';
import { formatCount, headerModel, sanitizeGitText, type SyncBadge } from './format';
import type { IconName } from './icons';
import {
  toErrorBody,
  useActionsStore,
  useChangesStore,
  useGitHubStore,
  useIconThemeStore,
  useIssuesStore,
  useOperationStore,
  useRepoStore,
  useRouteStore,
  useSettingsStore,
} from './store';
import { Icon } from './ui';
import { useT } from './useT';

const SYNC_ICON: Record<SyncBadge, IconName> = {
  local: 'cloud',
  synced: 'check',
  ahead: 'arrow-up',
  behind: 'arrow-down',
  diverged: 'merge',
};

function isLightBodyTheme(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    document.body.classList.contains('vscode-light') ||
    document.body.classList.contains('vscode-high-contrast-light')
  );
}

/** One More menu row: an icon, label, optional right-aligned value hint, and the store call it runs. Rows never reach git. */
interface HeaderMenuRow {
  id: string;
  icon: IconName;
  label: string;
  hint?: string;
  run: () => void;
}

interface HeaderMenuGroup {
  id: string;
  heading?: string;
  rows: HeaderMenuRow[];
}

export function SidebarHeader(): JSX.Element | null {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const iconTheme = useIconThemeStore((s) => s.snapshot);
  void iconTheme;
  const lightTheme = isLightBodyTheme();
  const status = useRepoStore((s) => s.status);
  const graph = useRepoStore((s) => s.graph);
  const loadStatus = useRepoStore((s) => s.loadStatus);
  const loadGraph = useRepoStore((s) => s.loadGraph);
  const load = useChangesStore((s) => s.load);
  const loading = useChangesStore((s) => s.loading);
  const busy = useChangesStore((s) => s.busy);
  const pushToast = useOperationStore((s) => s.pushToast);
  const loadPullRequests = useGitHubStore((s) => s.loadPullRequests);
  const linkage = useGitHubStore((s) => s.linkage);
  const auth = useGitHubStore((s) => s.auth);
  const issuesDisabled = useIssuesStore((s) => s.issuesDisabled);
  const route = useRouteStore((s) => s.route);

  const [menuOpen, setMenuOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placed, setPlaced] = useState({ x: 0, y: 0 });
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Anchor under the trigger, clamped to the viewport like the Explorer menu, and
  // put focus on the first row so the keyboard path starts where the eye is.
  useLayoutEffect(() => {
    if (!menuOpen) return;
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
  }, [menuOpen]);

  // Any outside click closes; pointerdown beats the trigger's own click.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (moreRef.current?.contains(target) === true) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [menuOpen]);

  const model = headerModel(status, language);
  if (status === null || model === null) return null;
  const shell = strings.shell;
  const compact = route.id !== 'changes';

  // Frame 05, 08, 09, 11: the repository slug sits beside the name, and a remote
  // the parser could not read leaves it out rather than drawing a bare slash.
  const slug =
    linkage?.owner != null && linkage?.repo != null
      ? `${linkage.owner}/${linkage.repo}`
      : null;
  const webUrl = linkage?.webUrl ?? null;

  /**
   * The header reload is the only Reload the user has, so it covers whichever
   * list is on screen. On `prs` it asks the host to revalidate with
   * `If-None-Match`, which costs one conditional request instead of a full
   * payload and does not consume primary quota on a 304.
   */
  const refresh = (): void => {
    void load();
    void loadStatus();
    void loadGraph();
    if (route.id === 'prs') void loadPullRequests({ refresh: true });
    if (route.id === 'issues') {
      const issuesState = useIssuesStore.getState();
      void issuesState.load(issuesState.filter, issuesState.state, true);
    }
    if (route.id === 'actions') void useActionsStore.getState().load({ force: true });
  };

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

  const openQuickActions = async (): Promise<void> => {
    try {
      await bridge.request('actions/openQuickActions', {});
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
        message: body.message,
      });
    }
  };

  // Same shape as the Explorer's copy handler: success is information, a refused
  // clipboard is a warning the user can still retry by hand.
  const copyUrl = (url: string): void => {
    void navigator.clipboard
      .writeText(url)
      .then(() => pushToast({ level: 'info', message: strings.shell.menuCopied }))
      .catch(() => pushToast({ level: 'warning', message: strings.explorer.toastCopyFailed }));
  };

  const openUrl = (url: string): void => {
    void useGitHubStore.getState().openUrl(url);
  };

  const primaryRows: HeaderMenuRow[] = [
    { id: 'reload', icon: 'refresh', label: strings.shell.menuReload, hint: 'R', run: refresh },
  ];
  if (webUrl !== null) {
    primaryRows.push(
      { id: 'open-repo', icon: 'external', label: strings.shell.menuOpenRepo, run: () => openUrl(webUrl) },
      { id: 'copy-url', icon: 'copy', label: strings.shell.menuCopyUrl, run: () => copyUrl(webUrl) },
    );
  }
  const menuGroups: HeaderMenuGroup[] = [
    { id: 'primary', rows: primaryRows },
    {
      id: 'account',
      heading: strings.shell.menuGroupAccount,
      rows: [
        auth?.connected === true
          ? {
              id: 'disconnect',
              icon: 'github',
              label: strings.explorerMenu.disconnectGithub,
              hint: auth.login ?? undefined,
              run: () => void useGitHubStore.getState().disconnect(),
            }
          : {
              id: 'connect',
              icon: 'github',
              label: strings.explorerMenu.connectGithub,
              run: () => void useGitHubStore.getState().connect(),
            },
      ],
    },
    {
      id: 'preferences',
      heading: strings.shell.menuGroupPreferences,
      rows: [
        {
          id: 'language',
          icon: 'globe',
          label: strings.shell.menuLanguage,
          hint: strings.shell.menuLanguageValue,
          run: () => useSettingsStore.getState().setLanguage(language === 'id' ? 'en' : 'id'),
        },
        {
          id: 'color-theme',
          icon: 'theme',
          label: strings.shell.menuColorTheme,
          hint: lightTheme ? strings.shell.themeLight : strings.shell.themeDark,
          run: () => useSettingsStore.getState().toggleColorTheme(),
        },
      ],
    },
  ];

  const closeMenu = (returnFocus: boolean): void => {
    setMenuOpen(false);
    if (returnFocus) moreRef.current?.focus();
  };

  const menuItems = (): HTMLElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const move = (delta: number): void => {
    const items = menuItems();
    if (items.length === 0) return;
    const index = items.findIndex((item) => item === document.activeElement);
    const next = (index + delta + items.length) % items.length;
    setActive(next);
    items[next]?.focus();
  };

  const jump = (to: 'first' | 'last'): void => {
    const items = menuItems();
    const index = to === 'first' ? 0 : items.length - 1;
    setActive(index);
    items[index]?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        closeMenu(true);
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
        closeMenu(true);
        return;
      default:
    }
  };

  const syncLabel: Record<SyncBadge, string> = {
    local: shell.syncLocal,
    synced: shell.syncSynced,
    ahead: shell.syncAhead(formatCount(model.ahead, language)),
    behind: shell.syncBehind(formatCount(model.behind, language)),
    diverged: shell.syncDiverged,
  };

  return (
    <header
      className={
        compact
          ? 'gc-sidebar-header gc-sidebar-header--compact'
          : `gc-sidebar-header${model.detached ? ' gc-sidebar-header--detached' : ''}`
      }
      aria-label={shell.headerAria}
    >
      <div className="gc-sidebar-header__row">
        <span className="gc-sidebar-header__title" title={sanitizeGitText(status.repoRoot)}>
          {sanitizeGitText(model.title)}
        </span>
        {compact && slug !== null && <span className="gc-sidebar-header__slug">{slug}</span>}
        <div className="gc-sidebar-header__actions" role="group" aria-label={shell.titleRowAria}>
          {/*
            One quick-create control per destination. Pull requests and Branches
            raise a focus target their view already honors; Issues and Actions
            open the GitHub page, because no in-extension form exists yet (P26,
            P27). Each hides when the action cannot be performed.
          */}
          {route.id === 'prs' && slug !== null && (
            <button
              type="button"
              className="gc-icon-button"
              aria-label={strings.shell.addPr}
              title={strings.shell.addPr}
              onClick={() =>
                useRouteStore.getState().navigateWithFocus({ id: 'prs' }, 'create-pr')
              }
            >
              <Icon name="pr" />
            </button>
          )}
          {route.id === 'issues' &&
            slug !== null &&
            auth?.connected === true &&
            !issuesDisabled && (
              <button
                type="button"
                className="gc-icon-button"
                aria-label={strings.shell.addIssue}
                title={strings.shell.addIssue}
                onClick={() =>
                  useRouteStore.getState().navigateWithFocus({ id: 'issues' }, 'new-issue')
                }
              >
                <Icon name="issue" />
              </button>
            )}
          {route.id === 'actions' && slug !== null && auth?.connected === true && (
            <button
              type="button"
              className="gc-icon-button"
              aria-label={strings.shell.addWorkflow}
              title={strings.shell.addWorkflow}
              onClick={() =>
                useRouteStore.getState().navigateWithFocus({ id: 'actions' }, 'run-workflow')
              }
            >
              <Icon name="play" />
            </button>
          )}
          {route.id === 'branches' && (
            <button
              type="button"
              className="gc-icon-button"
              aria-label={strings.shell.addBranch}
              title={strings.shell.addBranch}
              onClick={() =>
                useRouteStore.getState().navigateWithFocus({ id: 'branches', sub: 'local' }, 'new-branch')
              }
            >
              <Icon name="branch-add" />
            </button>
          )}
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.pending.reloadAria}
            title={strings.pending.reloadAria}
            aria-busy={loading}
            onClick={refresh}
          >
            <Icon name="refresh" />
          </button>
          {!compact && (
            <button
              type="button"
              className="gc-icon-button"
              aria-label={strings.pending.openGraphAria}
              title={strings.pending.openGraphAria}
              onClick={() => void openExplorer()}
            >
              <Icon name="graph" />
            </button>
          )}
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.palette.openAria}
            title={strings.palette.openTitle}
            onClick={() => void openQuickActions()}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.help.openAria}
            title={strings.help.openTitle}
            data-help-open=""
            onClick={() => useRouteStore.getState().openHelp()}
          >
            <Icon name="info" />
          </button>
          <button
            ref={moreRef}
            type="button"
            className="gc-icon-button"
            aria-label={strings.shell.moreAria}
            title={strings.shell.moreTitle}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <Icon name="ellipsis" />
          </button>
        </div>
      </div>

      {!compact && (
        <>
          <div className="gc-sidebar-header__row gc-sidebar-header__branch">
            <BranchSelector
              currentBranch={status.branch}
              refs={graph?.refs ?? []}
              busy={busy || status.operation !== 'idle'}
            />
            <span
              className={`gc-chip gc-sidebar-header__sync gc-sidebar-header__sync--${model.syncBadge}`}
              title={model.syncBadge === 'local' ? shell.syncLocalTitle : model.upstreamLine}
            >
              <Icon name={SYNC_ICON[model.syncBadge]} />
              <span>{syncLabel[model.syncBadge]}</span>
            </span>
          </div>

          {/*
            The visible text is short; the full sentence and the "branch" wording stay in
            the visually hidden fallback so a screen reader hears the counts and the kind
            of name, as `ContextBar` did.
          */}
          <p className="gc-sidebar-header__upstream" title={model.upstreamLine}>
            <span className="gc-sidebar-header__upstream-visual" aria-hidden="true">
              <span className="gc-sidebar-header__upstream-text">{model.upstream ?? shell.notPublished}</span>
              {model.hash !== null && (
                <>
                  <span className="gc-sidebar-header__dot">·</span>
                  <code className="gc-sidebar-header__hash">{model.hash}</code>
                </>
              )}
            </span>
            <span className="gc-visually-hidden">
              {strings.ui.branchLabel(model.branchLabel)}. {model.upstreamLine}
              {model.hash !== null && ` ${strings.ui.headAtCommit(model.hash)}`}
            </span>
          </p>
        </>
      )}

      {menuOpen && (() => {
        let flatIndex = -1;
        return (
          <div
            id={menuId}
            ref={menuRef}
            className="gc-menu"
            role="menu"
            aria-orientation="vertical"
            aria-label={strings.shell.moreTitle}
            style={{ left: `${placed.x}px`, top: `${placed.y}px` }}
            onKeyDown={onMenuKeyDown}
          >
            {menuGroups.map((group, groupIndex) => (
              <div
                key={group.id}
                className="gc-menu__group"
                role="group"
                aria-label={group.heading}
              >
                {groupIndex > 0 && <span className="gc-menu__separator" aria-hidden="true" />}
                {group.heading !== undefined && (
                  <span className="gc-menu__group-title" aria-hidden="true">
                    {group.heading}
                  </span>
                )}
                {group.rows.map((row) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      role="menuitem"
                      className="gc-menu__item gc-menu__item--compact"
                      tabIndex={index === active ? 0 : -1}
                      onFocus={() => setActive(index)}
                      onClick={() => {
                        row.run();
                        closeMenu(true);
                      }}
                    >
                      <span className="gc-menu__icon" aria-hidden="true">
                        <Icon name={row.icon} />
                      </span>
                      <span className="gc-menu__label">{row.label}</span>
                      {row.hint !== undefined && <span className="gc-menu__hint">{row.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })()}
    </header>
  );
}
