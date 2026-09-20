/**
 * Pending Changes panel (FEAT-02), VS Code Source Control anatomy.
 *
 * Sections in fixed order: Konflik first (it blocks everything else), then
 * Staged, Unstaged, Untracked. Selection is shared across sections so a bulk
 * action can act on a mixed pick.
 *
 * Per-file `discard` is wired to `runAction({ action: 'discard-file', path })`
 * for unstaged modifications only, gated behind the level 2 safety guard dialog.
 *
 * Layout, following VS Code: context breadcrumb, notifications, commit message
 * box with Commit/Push at the top, then a slim toolbar (branch, selection
 * helpers, view actions), then the grouped file list with its filter, then
 * sections with per-row and per-section staging only — no global Stage/Unstage.
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import { ChangeTree } from './ChangeTree';
import { BranchSelector } from './BranchLegend';
import { CommitForm } from './CommitForm';
import { ConflictPanel, OperationBanner } from './ConflictPanel';
import { GuardDialog } from './GuardDialog';
import { ToastRegion } from './Toast';
import { bridge, loadState, saveState } from './bridge';
import { baseName, formatCount, formatStashLabel, sanitizeGitText, shortHash, UNKNOWN_CHURN } from './format';
import { useT } from './useT';
import { groupBySection, isSectionBulkDisabled, stageableFrom, unstageableFrom, type ChangeSection } from './tree';
import {
  toErrorBody,
  useChangesStore,
  useIconThemeStore,
  useOperationStore,
  useRepoStore,
  useSettingsStore,
  wireHostEvents,
} from './store';
import { ContextBar, EmptyState, ErrorBanner, FileIcon, FileListSkeleton, Icon, InfoBanner, Spinner } from './ui';
import type { ChangeEntry, Lang, StashEntry } from '../messages';

/**
 * Letter badge per section, mirroring the Unity reference's `C` / `D` / `A` boxes.
 *
 * The letters are not decoration and they are not invented: `U` and `?` are the
 * porcelain codes those sections actually contain, and `S`/`M` stand for the two
 * halves of the staging split. They are a scan anchor only.
 *
 * `tone` names a `--gc-tone-*` token, never a colour.
 */
const SECTION_BADGES: Record<ChangeSection, { letter: string; tone: string }> = {
  conflicted: { letter: 'U', tone: 'removed' },
  staged: { letter: 'S', tone: 'added' },
  unstaged: { letter: 'M', tone: 'changed' },
  untracked: { letter: '?', tone: 'pending' },
};

const SECTION_ORDER: readonly ChangeSection[] = [
  'conflicted',
  'staged',
  'unstaged',
  'untracked',
] as const;

export function PendingChangesApp(): JSX.Element {
  const strings = useT();
  const changes = useChangesStore((s) => s.changes);
  const conflicts = useChangesStore((s) => s.conflicts);
  const selection = useChangesStore((s) => s.selection);
  const collapsed = useChangesStore((s) => s.collapsed);
  const collapsedSections = useChangesStore((s) => s.collapsedSections);
  const busy = useChangesStore((s) => s.busy);
  const loading = useChangesStore((s) => s.loading);
  const hasLoaded = useChangesStore((s) => s.hasLoaded);
  const error = useChangesStore((s) => s.error);
  const load = useChangesStore((s) => s.load);
  const toggle = useChangesStore((s) => s.toggle);
  const toggleFolder = useChangesStore((s) => s.toggleFolder);
  const toggleCollapsed = useChangesStore((s) => s.toggleCollapsed);
  const toggleSection = useChangesStore((s) => s.toggleSection);
  const selectAll = useChangesStore((s) => s.selectAll);
  const clear = useChangesStore((s) => s.clear);
  const stage = useChangesStore((s) => s.stage);
  const unstage = useChangesStore((s) => s.unstage);
  const stashes = useChangesStore((s) => s.stashes);
  const stashesCollapsed = useChangesStore((s) => s.stashesCollapsed);
  const toggleStashesCollapsed = useChangesStore((s) => s.toggleStashesCollapsed);
  const applyStash = useChangesStore((s) => s.applyStash);
  const dropStash = useChangesStore((s) => s.dropStash);

  const status = useRepoStore((s) => s.status);
  const graph = useRepoStore((s) => s.graph);
  const loadGraph = useRepoStore((s) => s.loadGraph);
  /**
   * Whether the host managed to count every file's lines. A row without numbers is
   * otherwise indistinguishable from an unchanged file, and one panel-level sentence
   * explains all of them at once instead of hiding the fact in per-row tooltips.
   */
  const churnTruncated = status?.churnTruncated === true;
  const loadStatus = useRepoStore((s) => s.loadStatus);
  const loadSettings = useSettingsStore((s) => s.load);
  const loadIconTheme = useIconThemeStore((s) => s.load);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const pushToast = useOperationStore((s) => s.pushToast);
  const showLogs = useOperationStore((s) => s.showLogs);
  const runAction = useOperationStore((s) => s.runAction);
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * Path filter for the list. Local, not in the store: it narrows what is drawn
   * and nothing else — no request, no persistence, nothing the host needs to know.
   */
  const [filter, setFilter] = useState('');
  const filterCountId = useId();

  // Restore persisted form state, then fetch. The view is rebuilt on every
  // reveal (`retainContextWhenHidden: false`), so this runs often and must be cheap.
  useEffect(() => {
    const persisted = loadState();
    useChangesStore.setState({
      selection: new Set(persisted.selectedPaths),
      collapsed: new Set(persisted.collapsedFolders),
      collapsedSections: new Set(persisted.collapsedSections),
      commitMessage: persisted.commitMessage,
      pushAfterCommit: persisted.pushAfterCommit,
    });
    // Scroll position is restored after the first paint, once rows exist.
    requestAnimationFrame(() => {
      if (scrollRef.current !== null) scrollRef.current.scrollTop = persisted.scrollTop;
    });
    const off = wireHostEvents('pending');
    // Icon theme pull must follow `wireHostEvents`: the race is closed by the
    // webview asking for the snapshot after its listeners exist.
    void loadIconTheme();
    void loadSettings();
    void load();
    void loadStatus();
    void loadGraph();
    return off;
  }, [load, loadIconTheme, loadSettings, loadStatus, loadGraph]);

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle.length === 0
        ? changes
        : changes.filter((entry) => entry.path.toLowerCase().includes(needle)),
    [changes, needle],
  );
  const groups = useMemo(() => groupBySection(visible), [visible]);
  const selected = [...selection];

  const sectionTitles: Record<ChangeSection, string> = {
    conflicted: strings.pending.sectionConflicted,
    staged: strings.pending.sectionStaged,
    unstaged: strings.pending.sectionUnstaged,
    untracked: strings.pending.sectionUntracked,
  };

  const refresh = (): void => {
    void load();
    void loadStatus();
    void loadGraph();
  };

  const openDiff = async (entry: ChangeEntry): Promise<void> => {
    try {
      await bridge.request('actions/openDiff', { path: entry.path });
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
        message: body.message,
      });
    }
  };

  const openStashDiff = async (index: number, path: string): Promise<void> => {
    try {
      await bridge.request('actions/openStashDiff', { index, path });
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
        message: body.message,
      });
    }
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

  /**
   * Untracked files are staged directly because explicit selection is user opt-in.
   * Ignored files ('!') are dropped because `git add` fails on ignored paths
   * with exit 1 and fails the entire batch.
   */
  const stagePaths = async (paths: readonly string[]): Promise<void> => {
    const valid = stageableFrom(paths, changes);
    if (valid.length < paths.length) {
      const skipped = paths.length - valid.length;
      pushToast({
        level: 'info',
        message: strings.pending.ignoredSkippedToast(formatCount(skipped, language)),
      });
    }
    if (valid.length > 0) {
      await stage(valid);
    }
  };

  /**
   * Only staged paths or conflicts can be unstaged. Untracked paths are dropped
   * so `git restore --staged` does not fail the batch.
   */
  const unstagePaths = async (paths: readonly string[]): Promise<void> => {
    const valid = unstageableFrom(paths, changes, conflicts);
    if (valid.length > 0) {
      await unstage(valid);
    }
  };

  return (
    <div className="gc-pending">
      <ContextBar status={status} />

      <div className="gc-pending__notifications">
        <OperationBanner status={status} />
        {error !== null && <ErrorBanner error={error} onShowLogs={showLogs} />}
        {conflicts.length > 0 && (
          <ConflictPanel conflicts={conflicts} operation={status?.operation ?? 'idle'} />
        )}
        {churnTruncated && (
          <InfoBanner tone="info" glyph="question">
            <strong>{strings.pending.churnTruncatedTitle}</strong>
            <span>
              {strings.pending.churnTruncatedDetail(UNKNOWN_CHURN)}
            </span>
          </InfoBanner>
        )}
      </div>

      <CommitForm />

      <div
        className="gc-pending__bar gc-toolbar--actions"
        role="toolbar"
        aria-label={strings.pending.toolbarLabel}
        aria-orientation="horizontal"
      >
        <div className="gc-toolbar__secondary-group">
          <BranchSelector
            currentBranch={status?.branch ?? null}
            refs={graph?.refs ?? []}
            busy={busy || (status !== null && status.operation !== 'idle')}
          />
          <div className="gc-selection-group" role="group" aria-label={strings.pending.selectionGroupAria}>
            <div className="gc-segmented gc-segmented--quiet">
              <button
                type="button"
                className="gc-button gc-button--quiet"
                title={strings.pending.selectAllTitle}
                disabled={changes.length === 0}
                onClick={selectAll}
              >
                <Icon name="check" />
                {strings.pending.selectAll}
              </button>
              <button
                type="button"
                className="gc-button gc-button--quiet"
                title={strings.pending.clearSelectionTitle}
                disabled={selected.length === 0}
                onClick={clear}
              >
                <Icon name="close" />
                {strings.pending.clearSelection}
              </button>
            </div>
            <span className="gc-pending__count" aria-live="off" aria-atomic="true">
              {strings.pending.selectedCount(formatCount(selected.length, language))}
            </span>
          </div>
        </div>

        <div className="gc-toolbar__end">
          <button
            type="button"
            className="gc-button gc-button--quiet gc-lang-toggle"
            aria-label={strings.pending.switchLanguageAria(language === 'en' ? 'Bahasa Indonesia' : 'English')}
            onClick={() => setLanguage(language === 'en' ? 'id' : 'en')}
          >
            {language.toUpperCase()}
          </button>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.pending.openGraphAria}
            onClick={() => void openExplorer()}
          >
            <Icon name="graph" />
          </button>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.pending.reloadAria}
            aria-busy={loading}
            onClick={refresh}
          >
            <Icon name="refresh" />
          </button>
        </div>
      </div>

      {!hasLoaded && loading && changes.length === 0 ? (
        <FileListSkeleton rows={8} />
      ) : changes.length === 0 ? (
        <>
          <EmptyState
            title={strings.pending.emptyTitle}
            hint={strings.pending.emptyHint}
          />
          <div className="gc-pending__sections" ref={scrollRef}>
            <StashSection
              stashes={stashes}
              isCollapsed={stashesCollapsed}
              busy={busy}
              language={language}
              onToggle={toggleStashesCollapsed}
              onApply={(i) => void applyStash(i)}
              onDrop={(i) => void dropStash(i)}
              onOpenDiff={(index, path) => void openStashDiff(index, path)}
            />
          </div>
        </>
      ) : (
        <>
          {/*
            List header: heading with a pill count, then a full-width search box
            with the leading glyph inside the field, and a quiet filter affordance
            beside it.
          */}
          <div className="gc-listbar">
            <div className="gc-listbar__header">
              <h2 className="gc-listbar__title">
                {strings.pending.changesHeader}
                <span className="gc-listbar__total">{formatCount(changes.length, language)}</span>
              </h2>
            </div>
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
                  placeholder={strings.pending.searchPlaceholder}
                  aria-label={strings.pending.searchAria}
                  aria-describedby={filterCountId}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
              {/*
                Visual affordance only: the input above is the filter, so this
                button is disabled and exists to signal that the row is the
                filter row. aria-hidden keeps a dead control out of the tab order
                and the accessibility tree.
              */}
              <button
                type="button"
                className="gc-icon-button gc-listbar__filter"
                aria-hidden="true"
                tabIndex={-1}
                disabled
              >
                <Icon name="filter" />
              </button>
            </div>
            {needle.length > 0 && (
              <p className="gc-help-text gc-listbar__count" id={filterCountId} role="status" aria-live="polite">
                {strings.pending.searchMatched(formatCount(visible.length, language), formatCount(changes.length, language))}
              </p>
            )}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title={strings.pending.searchEmptyTitle}
              action={
                <button
                  type="button"
                  className="gc-button gc-button--quiet"
                  onClick={() => setFilter('')}
                >
                  {strings.pending.clearSearch}
                </button>
              }
            />
          ) : (
            <div
              className="gc-pending__sections"
              ref={scrollRef}
              aria-busy={loading}
              onScroll={(event) => saveState({ scrollTop: event.currentTarget.scrollTop })}
            >
              {SECTION_ORDER.map((section) => {
                const entries = groups[section];
                if (entries.length === 0) return null;
                const badge = SECTION_BADGES[section];
                const title = sectionTitles[section];

                // Target semantics for section bulk action:
                // 1. If files in this section are selected in the global selection store, operate on those.
                // 2. Fallback to all files in this section if none are selected. This matches VS Code's
                //    "Stage All Changes" / "Unstage All Changes" behavior when no row checkbox is active,
                //    preventing dead buttons in default clean selection state while staging remains reversible.
                const sectionPaths = entries.map((e) => e.path);
                const sectionSelectedPaths = sectionPaths.filter((p) => selection.has(p));
                const isSelectionActive = sectionSelectedPaths.length > 0;
                const targetPaths = isSelectionActive ? sectionSelectedPaths : sectionPaths;

                const isStagedSection = section === 'staged';
                const validPaths = isStagedSection
                  ? unstageableFrom(targetPaths, changes, conflicts)
                  : stageableFrom(targetPaths, changes);

                const countStr = formatCount(validPaths.length, language);
                const sectionBtnAria = isStagedSection
                  ? isSelectionActive
                    ? strings.pending.unstageSectionSelectedAria(countStr, title)
                    : strings.pending.unstageSectionAllAria(countStr, title)
                  : isSelectionActive
                    ? strings.pending.stageSectionSelectedAria(countStr, title)
                    : strings.pending.stageSectionAllAria(countStr, title);

                const sectionBtnTitle = isStagedSection
                  ? isSelectionActive
                    ? strings.pending.unstageSectionSelectedTitle(countStr)
                    : strings.pending.unstageSectionAllTitle(countStr)
                  : isSelectionActive
                    ? strings.pending.stageSectionSelectedTitle(countStr)
                    : strings.pending.stageSectionAllTitle(countStr);

                const handleSectionBulk = (): void => {
                  if (isStagedSection) {
                    void unstagePaths(targetPaths);
                  } else {
                    void stagePaths(targetPaths);
                  }
                };

                const isCollapsed = collapsedSections.has(section);

                return (
                  <section className="gc-section" key={section} aria-label={title}>
                    <div className="gc-section__head">
                      {/* Toggle is a real button inside the heading (Enter/Space + aria-expanded come free); the bulk button and count badge stay outside it as siblings, so no button nests in a button and their labels stay out of the heading name. */}
                      <h3 className="gc-section__title">
                        <button
                          type="button"
                          className="gc-section__toggle"
                          aria-expanded={!isCollapsed}
                          aria-label={isCollapsed ? strings.pending.expandSectionAria(title) : strings.pending.collapseSectionAria(title)}
                          onClick={() => toggleSection(section)}
                        >
                          <span className="gc-section__twisty" aria-hidden="true">
                            <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
                          </span>
                          <span
                            className={`gc-section__badge gc-section__badge--${badge.tone}`}
                            aria-hidden="true"
                          >
                            {badge.letter}
                          </span>
                          <span className="gc-section__name">{title}</span>
                        </button>
                      </h3>
                      {/* Bulk staging a section whose rows are folded is an action on unseen files, so the button is disabled while collapsed to prevent action while keeping header composition stable. */}
                      <button
                        type="button"
                        className="gc-icon-button gc-section__bulk"
                        aria-label={sectionBtnAria}
                        title={sectionBtnTitle}
                        disabled={isSectionBulkDisabled(busy, validPaths.length, isCollapsed)}
                        onClick={handleSectionBulk}
                      >
                        <Icon name={isStagedSection ? 'dash' : 'add'} />
                      </button>
                      <span className="gc-section__count">{formatCount(entries.length, language)}</span>
                    </div>
                    {!isCollapsed && (
                      <ChangeTree
                        entries={entries}
                        selection={selection}
                        collapsed={collapsed}
                        busy={busy}
                        label={strings.pending.sectionAria(title, formatCount(entries.length, language))}
                        churnTruncated={churnTruncated}
                        onToggleFile={toggle}
                        onToggleFolder={toggleFolder}
                        onToggleCollapsed={toggleCollapsed}
                        onOpenDiff={(entry) => void openDiff(entry)}
                        fileAction={
                          section === 'staged'
                            ? { label: strings.changeTree.unstageLabel, icon: 'dash', ariaLabel: (p) => strings.changeTree.unstageFileAria(p), run: (e) => void unstage([e.path]) }
                            : { label: strings.changeTree.stageLabel, icon: 'add', ariaLabel: (p) => strings.changeTree.stageFileAria(p), run: (e) => void stage([e.path]) }
                        }
                        discardAction={
                          section === 'unstaged'
                            ? {
                                label: strings.changeTree.discardLabel,
                                icon: 'discard',
                                ariaLabel: (p) => strings.changeTree.discardFileAria(p),
                                run: (e) => void runAction({ action: 'discard-file', path: e.path }),
                              }
                            : null
                        }
                      />
                    )}
                  </section>
                );
              })}
              <StashSection
                stashes={stashes}
                isCollapsed={stashesCollapsed}
                busy={busy}
                language={language}
                onToggle={toggleStashesCollapsed}
                onApply={(i) => void applyStash(i)}
                onDrop={(i) => void dropStash(i)}
                onOpenDiff={(index, path) => void openStashDiff(index, path)}
              />
            </div>
          )}
        </>
      )}

      <GuardDialog />
      <ToastRegion />
    </div>
  );
}

function parseStashIndex(ref: string): number | null {
  const match = /^stash@\{(\d+)\}$/.exec(ref);
  return match !== null && match[1] !== undefined ? parseInt(match[1], 10) : null;
}

function StashSection({
  stashes,
  isCollapsed,
  busy,
  language,
  onToggle,
  onApply,
  onDrop,
  onOpenDiff,
}: {
  stashes: readonly StashEntry[];
  isCollapsed: boolean;
  busy: boolean;
  language: Lang;
  onToggle(): void;
  onApply(index: number): void;
  onDrop(index: number): void;
  onOpenDiff(index: number, path: string): void;
}): JSX.Element {
  const strings = useT();
  const title = strings.pending.stashesHeader;
  const toggleAria = isCollapsed
    ? strings.pending.expandSectionAria(title)
    : strings.pending.collapseSectionAria(title);

  return (
    <section className="gc-section" aria-label={title}>
      <div className="gc-section__head">
        <h3 className="gc-section__title">
          <button
            type="button"
            className="gc-section__toggle"
            aria-expanded={!isCollapsed}
            aria-label={toggleAria}
            onClick={onToggle}
          >
            <span className="gc-section__twisty" aria-hidden="true">
              <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} />
            </span>
            <span
              className="gc-section__badge gc-section__badge--special"
              aria-hidden="true"
            >
              <Icon name="archive" />
            </span>
            <span className="gc-section__name">{title}</span>
          </button>
        </h3>
        <span className="gc-section__count">{formatCount(stashes.length, language)}</span>
      </div>
      {!isCollapsed && (
        <StashList
          stashes={stashes}
          busy={busy}
          language={language}
          onApply={onApply}
          onDrop={onDrop}
          onOpenDiff={onOpenDiff}
        />
      )}
    </section>
  );
}

function StashList({
  stashes,
  busy,
  language,
  onApply,
  onDrop,
  onOpenDiff,
}: {
  stashes: readonly StashEntry[];
  busy: boolean;
  language: Lang;
  onApply(index: number): void;
  onDrop(index: number): void;
  onOpenDiff(index: number, path: string): void;
}): JSX.Element {
  const strings = useT();
  const stashesExpanded = useChangesStore((s) => s.stashesExpanded);
  const stashContents = useChangesStore((s) => s.stashContents);
  const stashContentsLoading = useChangesStore((s) => s.stashContentsLoading);
  const toggleStashExpanded = useChangesStore((s) => s.toggleStashExpanded);

  if (stashes.length === 0) {
    return (
      <div className="gc-stash__empty">
        <p className="gc-help-text">{strings.pending.stashesEmptyHint}</p>
      </div>
    );
  }

  const handleRevealCommit = async (hash: string) => {
    try {
      await bridge.request('graph/revealCommit', { hash });
    } catch {
      // Ignore
    }
  };

  return (
    <ul className="gc-tree gc-stash-list" role="list">
      {stashes.map((stash, index) => {
        const parsedIndex = parseStashIndex(stash.ref) ?? index;
        const stashNumber = parsedIndex + 1;
        const isExpanded = stashesExpanded.has(parsedIndex);
        const files = stashContents[parsedIndex];
        const isLoading = stashContentsLoading.has(parsedIndex);
        return (
          <li key={stash.ref} className="gc-stash-entry" role="listitem">
            <div className="gc-tree__row gc-stash-item">
              <button
                type="button"
                className="gc-icon-button gc-stash-item__twisty"
                aria-expanded={isExpanded}
                aria-label={
                  isExpanded
                    ? strings.pending.stashCollapseAria(stashNumber)
                    : strings.pending.stashExpandAria(stashNumber)
                }
                onClick={() => void toggleStashExpanded(parsedIndex)}
              >
                <span className="gc-tree__twisty" aria-hidden="true">
                  <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} />
                </span>
              </button>
              <span className="gc-stash-item__title">
                {formatStashLabel(parsedIndex, language)}
              </span>
              <button
                type="button"
                className="gc-stash-item__hash-btn"
                aria-label={strings.pending.stashOpenCommitAria}
                title={strings.pending.stashOpenCommitTitle}
                onClick={() => void handleRevealCommit(stash.hash)}
              >
                {shortHash(stash.hash)}
              </button>
              <div className="gc-stash-item__actions">
                <button
                  type="button"
                  className="gc-icon-button gc-stash-item__action"
                  aria-label={strings.pending.stashApplyAria(stash.ref)}
                  title={strings.pending.stashApplyTitle}
                  disabled={busy}
                  onClick={() => onApply(parsedIndex)}
                >
                  <Icon name="add" />
                </button>
                <button
                  type="button"
                  className="gc-icon-button gc-stash-item__action"
                  aria-label={strings.pending.stashDropAria(stash.ref)}
                  title={strings.pending.stashDropTitle}
                  disabled={busy}
                  onClick={() => onDrop(parsedIndex)}
                >
                  <Icon name="dash" />
                </button>
              </div>
            </div>
            {isExpanded && (
              <div className="gc-stash-item__details">
                {isLoading && (
                  <div className="gc-stash-files__loading">
                    <Spinner label={strings.pending.stashFilesLoading} />
                  </div>
                )}
                {!isLoading && files !== undefined && files.length === 0 && (
                  <div className="gc-stash-files__empty">
                    <span className="gc-help-text">{strings.pending.stashFilesEmpty}</span>
                  </div>
                )}
                {!isLoading && files !== undefined && files.length > 0 && (
                  <ul className="gc-tree gc-stash-files" role="list">
                    {files.map((file) => {
                      const isBinary = file.additions === null && file.deletions === null;
                      const churn = isBinary
                        ? strings.changeTree.binaryLabel
                        : strings.changeTree.churnSummary(file.additions ?? 0, file.deletions ?? 0);
                      return (
                        <li key={file.path} className="gc-stash-file" role="listitem">
                          <button
                            type="button"
                            className="gc-tree__row gc-stash-file__button"
                            aria-label={strings.pending.stashFileOpenDiffAria(file.path, churn)}
                            title={file.path}
                            onClick={() => onOpenDiff(parsedIndex, file.path)}
                          >
                            <FileIcon kind="file" name={baseName(file.path)} />
                            <span className="gc-stash-file__path">
                              {file.path}
                            </span>
                            {isBinary ? (
                              <span
                                className="gc-tree__binary"
                                aria-hidden="true"
                              >
                                {strings.changeTree.binaryLabel}
                              </span>
                            ) : (
                              <span
                                className="gc-tree__stats gc-stat-group"
                                aria-hidden="true"
                              >
                                <span className="gc-stat gc-stat--add">+{file.additions ?? 0}</span>
                                <span className="gc-stat gc-stat--del">−{file.deletions ?? 0}</span>
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
