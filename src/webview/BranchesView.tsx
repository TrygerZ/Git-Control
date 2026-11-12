/**
 * Sidebar Branches destination (P11).
 *
 * Frames 11, 63, 64, 65, 87. Lists local branches, remote branches, and tags,
 * and runs checkout, merge, and create through the actions that already exist.
 *
 * Controls the design draws but later phases own stay out (R2): New tag (P28),
 * Compare and Add worktree (P29). No control ships without behaviour.
 *
 * Clean up (P20) is here: the banner counts what `selectCleanupCandidates`
 * offers, the footer button opens the dialog, and the row menu carries a single
 * delete. Nothing in this file deletes anything itself; every removal is a
 * guarded mutation through the store, so the guard dialog and git's own refusal
 * stay the only authorities.
 *
 * The sidebar owns its own prompt and merge hosts. `ExplorerApp` keeps its own
 * copies of that state; importing it would tie two roots together. The guard
 * dialog is not duplicated here: the sidebar shell already hosts one, and a
 * second host would render two modal dialogs for a single verdict.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { CleanupDialog } from './CleanupDialog';
import { MergeDialog, mergeActionPayload } from './MergeDialog';
import { PromptDialog } from './PromptDialog';
import { selectCleanupCandidates } from '../branchCleanup';
import { Tablist } from './Tablist';
import { checkoutActionPayload } from './BranchLegend';
import {
  BRANCH_SORTS,
  BRANCHES_TABS,
  branchRow,
  canCheckout,
  filterRows,
  groupRemotes,
  sortLocals,
  tagRows,
  visibleWorktrees,
  type BranchChip,
  type BranchRowModel,
  type BranchesSectionKey,
  type BranchesTab,
  type BranchSort,
  type RemoteGroupModel,
  type TagRowModel,
} from './branchesModel';
import { nextIndex } from './listNav';
import { parseRoute } from './route';
import { relativeTime, sanitizeGitText, shortHash } from './format';
import { useT } from './useT';
import {
  useBranchesStore,
  useOperationStore,
  useRepoStore,
  useRouteStore,
  useSettingsStore,
  wireHostEvents,
} from './store';
import { EmptyState, ErrorBanner, Icon, InfoBanner, Spinner } from './ui';
import type { BranchRef, Lang } from '../messages';

/** DOM id of the one tabpanel all three sub-tabs control. */
export const BRANCHES_PANEL_ID = 'gc-branches-panel';
/** `idPrefix` the sub-tab `Tablist` is mounted with. Mirrors the Changes pair. */
export const BRANCHES_TABS_PREFIX = 'gc-branches-tabs';
/** Frame 11 draws five tags before the fold; the Tags sub-tab shows them all. */
const RECENT_TAG_LIMIT = 5;
/** A floating menu stays this far from the viewport edge. */
const MENU_MARGIN = 8;

/** A local row plus the ref it came from, so the menu can read `kind` and `isHead`. */
interface LocalEntry {
  ref: BranchRef;
  row: BranchRowModel;
}

interface MenuAnchor {
  ref: BranchRef;
  x: number;
  y: number;
}

export function BranchesView(): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const route = useRouteStore((s) => s.route);
  const status = useRepoStore((s) => s.status);

  const refs = useBranchesStore((s) => s.refs);
  const base = useBranchesStore((s) => s.base);
  const deleteBranches = useBranchesStore((s) => s.deleteBranches);
  const worktrees = useBranchesStore((s) => s.worktrees);
  const sort = useBranchesStore((s) => s.sort);
  const filter = useBranchesStore((s) => s.filter);
  const collapsed = useBranchesStore((s) => s.collapsed);
  const loading = useBranchesStore((s) => s.loading);
  const error = useBranchesStore((s) => s.error);
  const load = useBranchesStore((s) => s.load);
  const setSort = useBranchesStore((s) => s.setSort);
  const setFilter = useBranchesStore((s) => s.setFilter);
  const toggleSection = useBranchesStore((s) => s.toggleSection);

  const runAction = useOperationStore((s) => s.runAction);
  const pushToast = useOperationStore((s) => s.pushToast);
  const showLogs = useOperationStore((s) => s.showLogs);

  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [mergeFor, setMergeFor] = useState<string | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [singleDelete, setSingleDelete] = useState<string | null>(null);

  /*
   * The sidebar shell already wired the host events, so this call is a no-op
   * there. It returns no cleanup on purpose: the subscription is process-wide,
   * and unsubscribing on route change would tear down the shell's own wiring.
   */
  useEffect(() => {
    wireHostEvents('pending');
  }, []);

  const sub: BranchesTab = route.id === 'branches' ? route.sub : 'local';

  useEffect(() => {
    if (route.id !== 'branches') return;
    void load();
  }, [route.id, load]);

  const currentBranch = status?.branch ?? null;

  const locals = useMemo(() => refs.filter((ref) => ref.kind === 'local'), [refs]);
  const currentRef = useMemo(
    () => locals.find((ref) => ref.shortName === currentBranch) ?? null,
    [locals, currentBranch],
  );
  const otherLocals = useMemo(
    () => locals.filter((ref) => ref.shortName !== currentBranch),
    [locals, currentBranch],
  );

  const localEntries = useMemo<LocalEntry[]>(() => {
    const byKey = new Map(otherLocals.map((ref) => [ref.refName, ref]));
    const rows = sortLocals(otherLocals.map(branchRow), sort);
    return filterRows(rows, filter).flatMap((row) => {
      const ref = byKey.get(row.key);
      return ref === undefined ? [] : [{ ref, row }];
    });
  }, [otherLocals, sort, filter]);

  /*
   * The filter narrows the active sub-tab's list. Groups whose rows all drop
   * out disappear, so a remote with nothing left does not render an empty
   * section header.
   */
  const remoteGroups = useMemo(
    () =>
      groupRemotes(refs).flatMap((group) => {
        const rows = filterRows(group.rows, filter);
        return rows.length === 0 ? [] : [{ remote: group.remote, rows }];
      }),
    [refs, filter],
  );
  const allTags = useMemo(() => filterRows(tagRows(refs), filter), [refs, filter]);
  const recentTags = useMemo(() => tagRows(refs, RECENT_TAG_LIMIT), [refs]);
  const shownWorktrees = useMemo(() => visibleWorktrees(worktrees), [worktrees]);

  /*
   * The cleanup banner and dialog read the same selection, so the count in the
   * banner can never promise a row the dialog does not list.
   */
  const cleanupCandidates = useMemo(
    () => selectCleanupCandidates(refs, currentBranch, base ?? ''),
    [refs, currentBranch, base],
  );
  /**
   * The remote a cleanup may also delete on. Taken from the first candidate that
   * has one rather than requiring unanimity: a single local-only branch among five
   * must not hide the checkbox for the other four. Candidates without a tracking
   * ref are skipped by the store, never sent as a delete the host would refuse.
   */
  const cleanupRemote = useMemo(() => {
    for (const candidate of cleanupCandidates) {
      if (candidate.remote !== null) return candidate.remote;
    }
    return null;
  }, [cleanupCandidates]);

  const runAndReload = async (request: Parameters<typeof runAction>[0]): Promise<void> => {
    const ok = await runAction(request);
    // A guard rejection parks the request in the dialog; the dialog's own retry
    // refetches, so only a completed action needs the list reloaded here.
    if (ok) await load();
  };

  /**
   * One cleanup run. The store does the sequencing and the tally; this only
   * decides what the user is told, and it reports partial success as a warning
   * rather than a success, because some branches are still there.
   */
  const runCleanup = async (names: readonly string[], remote: string | null): Promise<void> => {
    const result = await deleteBranches(names, remote);
    const ops = useOperationStore.getState();

    /*
     * Criterion 9: every branch that was not removed is named, including on a run
     * where nothing was. A total failure returns silently here only if the guard
     * dialog is already showing the reason; otherwise the run would look like it
     * did nothing at all.
     */
    if (result.failed.length > 0) {
      const skipped = result.failed.map((name) => sanitizeGitText(name)).join(', ');
      ops.appendProgress(`${strings.cleanup.deleteFailed}: ${skipped}`);
      // A parked verdict owns the screen. A second modal over it would hide the
      // first, and the user is about to answer it anyway.
      if (ops.pendingGuard === null) {
        pushToast({
          level: 'warning',
          message: strings.cleanup.partial(String(result.ok), String(result.failed.length)),
          detail: skipped,
          showLogs: true,
        });
      }
    } else if (result.ok > 0) {
      pushToast({ level: 'info', message: strings.cleanup.doneToast(String(result.ok)) });
    }

    /*
     * Local delete done, remote delete not: the branch is gone here and still on
     * the server. Saying "Deleted N" alone would be a half-truth, so the count
     * and the names are stated separately.
     */
    if (result.remoteFailed.length > 0) {
      const stuck = result.remoteFailed.map((name) => sanitizeGitText(name)).join(', ');
      ops.appendProgress(`${strings.cleanup.remoteFailed}: ${stuck}`);
      pushToast({
        level: 'warning',
        message: strings.cleanup.remoteFailedToast(String(result.remoteFailed.length)),
        detail: stuck,
        showLogs: true,
      });
    }
  };

  /**
   * One copy path for every row, so a worktree path reports the same success and
   * failure a branch name does. `message` is what the toast says on success.
   */
  const copyText = (text: string, message: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => pushToast({ level: 'info', message }))
      .catch(() => pushToast({ level: 'warning', message: strings.explorer.toastCopyFailed }));
  };
  const copyName = (name: string): void => copyText(name, strings.branches.copied);

  const checkout = (name: string): void => {
    const payload = checkoutActionPayload(name, currentBranch, false);
    if (payload !== null) void runAndReload(payload);
  };

  const selectSub = (id: string): void => {
    const next = parseRoute({ id: 'branches', sub: id });
    if (next !== null) useRouteStore.getState().navigate(next);
  };

  const tabLabel = (id: BranchesTab): string =>
    id === 'local' ? strings.branches.tabLocal : id === 'remote' ? strings.branches.tabRemote : strings.branches.tabTags;

  const tabs = BRANCHES_TABS.map((id) => ({
    id,
    label: tabLabel(id),
    ariaLabel: tabLabel(id),
    panelId: BRANCHES_PANEL_ID,
  }));

  const filterPlaceholder =
    sub === 'local'
      ? strings.branches.filterLocal
      : sub === 'remote'
        ? strings.branches.filterRemote
        : strings.branches.filterTags;

  /*
   * Identity of the row whose menu is open, compared against `BranchRowModel.key`.
   * Kept out of the JSX so the value never appears in a render position.
   */
  const openMenuKey = menu === null ? null : menu.ref.refName;

  const remoteRowCount = remoteGroups.reduce((n, group) => n + group.rows.length, 0);
  const visibleCount = sub === 'local' ? localEntries.length : sub === 'remote' ? remoteRowCount : allTags.length;
  const nothingMatches = filter.trim().length > 0 && visibleCount === 0;

  return (
    <div className="gc-branches">
      <Tablist
        tabs={tabs}
        activeId={sub}
        onSelect={selectSub}
        ariaLabel={strings.branches.tabsAria}
        idPrefix={BRANCHES_TABS_PREFIX}
        classPrefix="gc-subtabs"
      />

      <div className="gc-listbar">
        <div className="gc-listbar__controls">
          <div className="gc-listbar__search-wrap">
            <span className="gc-listbar__search-icon" aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              type="search"
              className="gc-listbar__input"
              value={filter}
              maxLength={100}
              placeholder={filterPlaceholder}
              aria-label={strings.branches.filterAria}
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
        </div>
      </div>

      {error !== null && <ErrorBanner error={error} onShowLogs={showLogs} />}

      {/*
        Frame 63: the banner appears only when there is something to clean, and
        disappears on its own when the last candidate goes. It names the count and
        the safe command, so the offer is legible before the dialog opens.
      */}
      {cleanupCandidates.length > 0 && (
        <InfoBanner tone="info" glyph="trash">
          <div className="gc-cleanup__banner">
            <span>
              <strong>{strings.cleanup.banner(String(cleanupCandidates.length))}</strong>
              <span className="gc-cleanup__banner-hint">{strings.cleanup.bannerHint}</span>
            </span>
            <button
              type="button"
              className="gc-button gc-button--quiet"
              aria-label={strings.cleanup.openAria(String(cleanupCandidates.length))}
              onClick={() => setCleanupOpen(true)}
            >
              <Icon name="trash" />
              {strings.cleanup.openButton}
            </button>
          </div>
        </InfoBanner>
      )}

      <div role="tabpanel" id={BRANCHES_PANEL_ID} aria-label={tabLabel(sub)} className="gc-branches__panel">
        {loading && refs.length === 0 ? (
          <Spinner label={strings.branches.tabsAria} />
        ) : nothingMatches ? (
          <EmptyState
            title={strings.branches.emptyFilter}
            action={
              <button type="button" className="gc-button gc-button--quiet" onClick={() => setFilter('')}>
                {strings.pending.clearSearch}
              </button>
            }
          />
        ) : sub === 'remote' ? (
          <RemoteList groups={remoteGroups} language={language} onCopy={copyName} />
        ) : sub === 'tags' ? (
          <TagList tags={allTags} language={language} empty={strings.branches.emptyTags} />
        ) : (
          <LocalList
            currentRef={currentRef}
            entries={localEntries}
            recentTags={recentTags}
            worktrees={shownWorktrees}
            sort={sort}
            collapsed={collapsed}
            language={language}
            openMenuKey={openMenuKey}
            onCopy={copyName}
            onToggleSection={toggleSection}
            onSort={setSort}
            onMenu={setMenu}
          />
        )}
      </div>

      <div className="gc-branches__footer">
        <button
          type="button"
          className="gc-button gc-button--primary"
          aria-label={strings.branches.newBranchAria}
          onClick={() => setCreateOpen(true)}
        >
          <Icon name="branch-add" />
          {strings.branches.newBranch}
        </button>
        <span className="gc-branches__fetched">
          {status?.lastFetchAt == null
            ? strings.branches.neverFetched
            : strings.branches.fetchedAgo(
                relativeTime(new Date(status.lastFetchAt).toISOString(), Date.now(), language),
              )}
        </span>
      </div>

      {menu !== null && (
        <BranchRowMenu
          ref_={menu.ref}
          anchor={menu}
          currentBranch={currentBranch}
          onClose={() => setMenu(null)}
          onCheckout={(name) => {
            setMenu(null);
            checkout(name);
          }}
          onMerge={(name) => {
            setMenu(null);
            setMergeFor(name);
          }}
          onCopy={(name) => {
            setMenu(null);
            copyName(name);
          }}
          onDelete={(name) => {
            setMenu(null);
            setSingleDelete(name);
          }}
          deletable={cleanupCandidates.some((c) => c.name === menu.ref.shortName)}
        />
      )}

      {cleanupOpen && (
        <CleanupDialog
          candidates={cleanupCandidates}
          remote={cleanupRemote}
          onCancel={() => setCleanupOpen(false)}
          onDelete={(names, remote) => {
            setCleanupOpen(false);
            void runCleanup(names, remote);
          }}
        />
      )}

      {/*
        One branch from the row menu goes through the same dialog, so the command
        preview and the guard flow are identical whether the user arrived from the
        banner or from a row.
      */}
      {singleDelete !== null && (
        <CleanupDialog
          candidates={cleanupCandidates.filter((c) => c.name === singleDelete)}
          remote={cleanupRemote}
          onCancel={() => setSingleDelete(null)}
          onDelete={(names, remote) => {
            setSingleDelete(null);
            void runCleanup(names, remote);
          }}
        />
      )}

      {createOpen && (
        <PromptDialog
          title={strings.explorer.createBranchTitle}
          label={strings.explorer.newBranchPrompt}
          submitLabel={strings.explorer.createBranchTitle}
          cancelLabel={strings.guard.cancelButton}
          validate={(value) => (value.length === 0 ? strings.explorer.branchNameRequired : null)}
          onSubmit={(name) => {
            setCreateOpen(false);
            void runAndReload({ action: 'create-branch', name, startPoint: currentBranch ?? 'HEAD' });
          }}
          onCancel={() => setCreateOpen(false)}
        />
      )}

      {mergeFor !== null && (
        <MergeDialog
          branch={mergeFor}
          currentBranch={currentBranch}
          onSubmit={(noFf) => {
            const source = mergeFor;
            setMergeFor(null);
            void runAndReload(mergeActionPayload(source, noFf));
          }}
          onCancel={() => setMergeFor(null)}
        />
      )}

      {/*
        No GuardDialog here: the sidebar shell mounts one for every route, and a
        second host would render two modal dialogs for a single guard verdict.
      */}
    </div>
  );
}

// ------------------------------------------------------------------ local tab

function LocalList(props: {
  currentRef: BranchRef | null;
  entries: readonly LocalEntry[];
  recentTags: readonly TagRowModel[];
  worktrees: readonly { path: string; head: string | null; branch: string | null; isCurrent: boolean }[];
  sort: BranchSort;
  collapsed: ReadonlySet<BranchesSectionKey>;
  language: Lang;
  /** `refName` of the row whose menu is open, so its trigger can report `aria-expanded`. */
  openMenuKey: string | null;
  onToggleSection(key: BranchesSectionKey): void;
  onSort(sort: BranchSort): void;
  onMenu(anchor: MenuAnchor): void;
  onCopy(text: string, message: string): void;
}): JSX.Element {
  const strings = useT();
  const {
    currentRef,
    entries,
    recentTags,
    worktrees,
    sort,
    collapsed,
    language,
    onToggleSection,
    onSort,
    onMenu,
    onCopy,
  } = props;

  const [sortOpen, setSortOpen] = useState(false);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const [sortPos, setSortPos] = useState({ x: 0, y: 0 });

  /*
   * `.gc-branches` clips its overflow, so the menu is `position: fixed` (from
   * `.gc-menu`) and placed from the trigger rect, the same way the Issues
   * filter menu is.
   */
  useLayoutEffect(() => {
    if (!sortOpen) return;
    const trigger = sortButtonRef.current;
    if (trigger === null) return;
    const box = trigger.getBoundingClientRect();
    const menuElement = sortMenuRef.current;
    const width = menuElement?.offsetWidth ?? 220;
    const height = menuElement?.offsetHeight ?? 0;
    const x = Math.max(MENU_MARGIN, Math.min(box.right - width, window.innerWidth - width - MENU_MARGIN));
    const y = Math.min(box.bottom + 4, Math.max(MENU_MARGIN, window.innerHeight - height - MENU_MARGIN));
    setSortPos({ x, y });
  }, [sortOpen]);

  useEffect(() => {
    if (!sortOpen) return undefined;
    sortMenuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onClickOutside = (event: MouseEvent): void => {
      if (sortMenuRef.current !== null && !sortMenuRef.current.contains(event.target as Node)) setSortOpen(false);
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [sortOpen]);

  const sortName =
    sort === 'recent'
      ? strings.branches.sortRecent
      : sort === 'name'
        ? strings.branches.sortName
        : strings.branches.sortAheadBehind;

  const onSortKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      setSortOpen(false);
      sortButtonRef.current?.focus();
      return;
    }
    const items = Array.from(sortMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const next = nextIndex(event.key, items.findIndex((el) => el === document.activeElement), items.length);
    if (next === -1) return;
    event.preventDefault();
    items[next]?.focus();
  };

  const sectionHead = (key: BranchesSectionKey, title: string, count: number, trailing?: JSX.Element): JSX.Element => {
    const isCollapsed = collapsed.has(key);
    return (
      <div className="gc-section__head">
        <h3 className="gc-section__title">
          <button
            type="button"
            className="gc-section__toggle"
            aria-expanded={!isCollapsed}
            aria-label={
              isCollapsed ? strings.pending.expandSectionAria(title) : strings.pending.collapseSectionAria(title)
            }
            onClick={() => onToggleSection(key)}
          >
            <span className="gc-section__twisty" aria-hidden="true">
              <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
            </span>
            <span className="gc-section__name">{title}</span>
          </button>
        </h3>
        <span className="gc-section__count">{count}</span>
        {trailing}
      </div>
    );
  };

  const section = (
    key: BranchesSectionKey,
    title: string,
    count: number,
    body: JSX.Element,
    trailing?: JSX.Element,
  ): JSX.Element => (
    <section className="gc-section gc-branches__section" aria-label={title} key={key}>
      {sectionHead(key, title, count, trailing)}
      {!collapsed.has(key) && body}
    </section>
  );

  return (
    <div className="gc-branches__sections">
      {currentRef !== null &&
        section(
          'current',
          strings.branches.sectionCurrent,
          1,
          <ul className="gc-branches__list" role="list">
            <BranchRowItem
              row={branchRow(currentRef)}
              ref_={currentRef}
              isCurrent
              expanded={props.openMenuKey === currentRef.refName}
              language={language}
              onMenu={onMenu}
            />
          </ul>,
        )}

      {section(
        'local',
        strings.branches.sectionLocal,
        entries.length,
        entries.length === 0 ? (
          <p className="gc-branches__empty">{strings.branches.emptyLocal}</p>
        ) : (
          <ul className="gc-branches__list" role="list">
            {entries.map((entry) => (
              <BranchRowItem
                key={entry.row.key}
                row={entry.row}
                ref_={entry.ref}
                expanded={props.openMenuKey === entry.ref.refName}
                language={language}
                onMenu={onMenu}
              />
            ))}
          </ul>
        ),
        <button
          ref={sortButtonRef}
          type="button"
          className="gc-branches__sort"
          aria-haspopup="menu"
          aria-expanded={sortOpen}
          title={strings.branches.sortAria}
          onClick={() => setSortOpen((open) => !open)}
        >
          {strings.branches.sortLabel(sortName)}
        </button>,
      )}

      {worktrees.length > 0 &&
        section(
          'worktrees',
          strings.branches.sectionWorktrees,
          worktrees.length,
          <ul className="gc-branches__list" role="list">
            {worktrees.map((worktree) => {
              // A worktree path comes from git, so it is sanitised everywhere it
              // reaches the DOM, the tooltip included.
              const safePath = sanitizeGitText(worktree.path);
              return (
                <li key={worktree.path} className="gc-branches__row gc-branches__row--worktree">
                  <Icon name="folder" />
                  <span className="gc-branches__name" title={safePath}>
                    {sanitizeGitText(worktree.branch ?? shortHash(worktree.head ?? ''))}
                  </span>
                  {worktree.isCurrent && (
                    <span className="gc-branches__muted">{strings.branches.currentWorktree}</span>
                  )}
                  <button
                    type="button"
                    className="gc-icon-button gc-branches__more"
                    aria-label={strings.branches.worktreePathAria(safePath)}
                    title={safePath}
                    onClick={() => onCopy(worktree.path, strings.branches.copiedPath)}
                  >
                    <Icon name="copy" />
                  </button>
                </li>
              );
            })}
          </ul>,
        )}

      {section(
        'tags',
        strings.branches.sectionTags,
        recentTags.length,
        recentTags.length === 0 ? (
          <p className="gc-branches__empty">{strings.branches.emptyTags}</p>
        ) : (
          <ul className="gc-branches__list" role="list">
            {recentTags.map((tag) => (
              <TagRow key={tag.key} tag={tag} language={language} />
            ))}
          </ul>
        ),
      )}

      {sortOpen && (
        <div
          ref={sortMenuRef}
          className="gc-menu gc-branches__sortmenu"
          role="menu"
          aria-label={strings.branches.sortMenuTitle}
          style={{ left: `${sortPos.x}px`, top: `${sortPos.y}px` }}
          onKeyDown={onSortKey}
        >
          <div className="gc-menu__group" role="group" aria-label={strings.branches.sortMenuTitle}>
            <span className="gc-menu__group-title" aria-hidden="true">
              {strings.branches.sortMenuTitle}
            </span>
            {BRANCH_SORTS.map((id) => {
              const label =
                id === 'recent'
                  ? strings.branches.sortRecent
                  : id === 'name'
                    ? strings.branches.sortName
                    : strings.branches.sortAheadBehind;
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sort === id}
                  className="gc-menu__item"
                  onClick={() => {
                    onSort(id);
                    setSortOpen(false);
                    sortButtonRef.current?.focus();
                  }}
                >
                  <span className="gc-menu__icon" aria-hidden="true">
                    {sort === id ? <Icon name="check" /> : null}
                  </span>
                  <span className="gc-menu__body">
                    <span className="gc-menu__label">
                      <span>{label}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- remote tab

function RemoteList(props: {
  groups: readonly RemoteGroupModel[];
  language: Lang;
  onCopy(name: string): void;
}): JSX.Element {
  const strings = useT();
  const language = props.language;
  if (props.groups.length === 0) {
    return <p className="gc-branches__empty">{strings.branches.emptyRemote}</p>;
  }
  return (
    <div className="gc-branches__sections">
      {props.groups.map((group) => (
        <section key={group.remote} className="gc-section gc-branches__section" aria-label={group.remote}>
          <div className="gc-section__head">
            <h3 className="gc-section__title">
              <span className="gc-section__name">{sanitizeGitText(group.remote)}</span>
            </h3>
            <span className="gc-section__count">{group.rows.length}</span>
          </div>
          <ul className="gc-branches__list" role="list">
            {group.rows.map((row) => (
              <li key={row.key} className="gc-branches__row">
                <Icon name="cloud" />
                <span className="gc-branches__name" title={sanitizeGitText(row.shortName)}>
                  {sanitizeGitText(row.shortName)}
                </span>
                <span className="gc-branches__age">
                  {row.committedAt === null ? '' : relativeTime(row.committedAt, Date.now(), language)}
                </span>
                <button
                  type="button"
                  className="gc-icon-button gc-branches__more"
                  aria-label={strings.branches.menuCopyName}
                  title={strings.branches.menuCopyName}
                  onClick={() => props.onCopy(row.shortName)}
                >
                  <Icon name="copy" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- tags tab

function TagRow({ tag, language }: { tag: TagRowModel; language: Lang }): JSX.Element {
  return (
    <li className="gc-branches__row">
      <Icon name="tag" />
      <span className="gc-branches__name">{sanitizeGitText(tag.name)}</span>
      <span className="gc-branches__hash">{tag.shortHash}</span>
      <span className="gc-branches__age">
        {tag.committedAt === null ? '' : relativeTime(tag.committedAt, Date.now(), language)}
      </span>
    </li>
  );
}

function TagList({ tags, language, empty }: { tags: readonly TagRowModel[]; language: Lang; empty: string }): JSX.Element {
  if (tags.length === 0) return <p className="gc-branches__empty">{empty}</p>;
  return (
    <div className="gc-branches__sections">
      <ul className="gc-branches__list" role="list">
        {tags.map((tag) => (
          <TagRow key={tag.key} tag={tag} language={language} />
        ))}
      </ul>
    </div>
  );
}

// -------------------------------------------------------------------- one row

const CHIP_LABEL: Record<BranchChip, 'chipMerged' | 'chipLocalOnly' | 'chipUpstreamGone'> = {
  merged: 'chipMerged',
  localOnly: 'chipLocalOnly',
  upstreamGone: 'chipUpstreamGone',
};

const CHIP_HINT: Record<BranchChip, 'chipMergedHint' | 'chipLocalOnlyHint' | 'chipUpstreamGoneHint'> = {
  merged: 'chipMergedHint',
  localOnly: 'chipLocalOnlyHint',
  upstreamGone: 'chipUpstreamGoneHint',
};

function BranchRowItem(props: {
  row: BranchRowModel;
  ref_: BranchRef;
  isCurrent?: boolean;
  expanded: boolean;
  language: Lang;
  onMenu(anchor: MenuAnchor): void;
}): JSX.Element {
  const strings = useT();
  const { row, ref_ } = props;
  const language = props.language;
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  /*
   * Every row gets a menu, because Copy name is offered on every row. The menu
   * itself gates Checkout and Merge behind `canCheckout` and the current-branch
   * check, so a remote or current row can never grow a control this phase does
   * not support (D-P11-3).
   */
  const openMenu = (): void => {
    const box = menuButtonRef.current?.getBoundingClientRect();
    if (box === undefined) return;
    props.onMenu({ ref: ref_, x: box.right, y: box.bottom + 4 });
  };

  return (
    <li
      className={props.isCurrent === true ? 'gc-branches__row gc-branches__row--current' : 'gc-branches__row'}
      role="listitem"
    >
      {props.isCurrent === true && (
        <span className="gc-branches__check" aria-hidden="true">
          <Icon name="check" />
        </span>
      )}
      <Icon name={props.isCurrent === true ? 'git-branch' : 'circle-filled'} />
      <span className="gc-branches__name" title={sanitizeGitText(row.shortName)}>
        {sanitizeGitText(row.shortName)}
      </span>
      {row.ahead > 0 && (
        <span className="gc-branches__ahead" title={strings.branches.aheadAria(String(row.ahead))}>
          <Icon name="arrow-up" />
          {row.ahead}
        </span>
      )}
      {row.behind > 0 && (
        <span className="gc-branches__behind" title={strings.branches.behindAria(String(row.behind))}>
          <Icon name="arrow-down" />
          {row.behind}
        </span>
      )}
      {row.chips.map((chip) => (
        <span
          key={chip}
          className={`gc-branches__chip gc-branches__chip--${chip}`}
          title={strings.branches[CHIP_HINT[chip]]}
        >
          {strings.branches[CHIP_LABEL[chip]]}
        </span>
      ))}
      <span className="gc-branches__age">
        {row.committedAt === null ? '' : relativeTime(row.committedAt, Date.now(), language)}
      </span>
      <button
        ref={menuButtonRef}
        type="button"
        className="gc-icon-button gc-branches__more"
        aria-label={strings.branches.rowMenuAria(sanitizeGitText(row.shortName))}
        aria-haspopup="menu"
        aria-expanded={props.expanded}
        onClick={openMenu}
      >
        <Icon name="ellipsis" />
      </button>
    </li>
  );
}

// -------------------------------------------------------------------- row menu

function BranchRowMenu(props: {
  ref_: BranchRef;
  anchor: MenuAnchor;
  currentBranch: string | null;
  onClose(): void;
  onCheckout(name: string): void;
  onMerge(name: string): void;
  onCopy(name: string): void;
  onDelete(name: string): void;
  /** `true` when this branch is in the cleanup selection, so Delete is offered. */
  deletable: boolean;
}): JSX.Element {
  const strings = useT();
  const { ref_, anchor } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const [placed, setPlaced] = useState({ x: anchor.x, y: anchor.y });

  useEffect(() => {
    returnFocus.current = document.activeElement;
    listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  // A row near the bottom edge would otherwise open a menu past the viewport.
  useLayoutEffect(() => {
    const element = listRef.current;
    if (element === null) return;
    const box = element.getBoundingClientRect();
    const x = Math.max(MENU_MARGIN, Math.min(anchor.x, window.innerWidth - box.width - MENU_MARGIN));
    const y = Math.max(MENU_MARGIN, Math.min(anchor.y, window.innerHeight - box.height - MENU_MARGIN));
    if (x !== placed.x || y !== placed.y) setPlaced({ x, y });
  }, [anchor.x, anchor.y, placed.x, placed.y]);

  // Any outside click closes; pointerdown beats the next menu opening.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (listRef.current !== null && !listRef.current.contains(event.target as Node)) props.onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [props]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      props.onClose();
      return;
    }
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const next = nextIndex(event.key, items.findIndex((el) => el === document.activeElement), items.length);
    if (next === -1) return;
    event.preventDefault();
    items[next]?.focus();
  };

  const name = sanitizeGitText(ref_.shortName);
  const isCurrent = ref_.shortName === props.currentBranch;
  const mutable = canCheckout(ref_) && !isCurrent;

  const item = (
    label: string,
    icon: 'git-branch' | 'merge' | 'copy' | 'trash',
    run: () => void,
    hint?: string,
  ): JSX.Element => (
    <button type="button" role="menuitem" className="gc-menu__item" onClick={run}>
      <span className="gc-menu__icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="gc-menu__body">
        <span className="gc-menu__label">
          <span>{label}</span>
        </span>
        {hint !== undefined && <span className="gc-menu__hint">{hint}</span>}
      </span>
    </button>
  );

  return (
    <div
      ref={listRef}
      className="gc-menu gc-branches__rowmenu"
      role="menu"
      aria-label={strings.branches.rowMenuAria(name)}
      style={{ left: `${placed.x}px`, top: `${placed.y}px` }}
      onKeyDown={onKeyDown}
    >
      <div className="gc-menu__group" role="group">
        {mutable && item(strings.branches.menuCheckout, 'git-branch', () => props.onCheckout(ref_.shortName))}
        {mutable && item(strings.branches.menuMerge, 'merge', () => props.onMerge(ref_.shortName))}
        {item(strings.branches.menuCopyName, 'copy', () => props.onCopy(ref_.shortName))}
        {/*
          Frame 63: Delete branch, merged only. The menu offers it exactly when the
          cleanup selection would list the branch, so a row that cannot be safely
          deleted has no dead entry. The hint is a word, not a colour.
        */}
        {props.deletable && (
          <button
            type="button"
            role="menuitem"
            className="gc-menu__item gc-menu__item--danger"
            onClick={() => props.onDelete(ref_.shortName)}
          >
            <span className="gc-menu__icon" aria-hidden="true">
              <Icon name="trash" />
            </span>
            <span className="gc-menu__body">
              <span className="gc-menu__label">
                <span>{strings.branches.menuDelete}</span>
                <span className="gc-menu__hint">{strings.branches.menuDeleteHint}</span>
              </span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
