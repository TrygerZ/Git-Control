/**
 * Pending Changes panel (FEAT-02), Unity-style.
 *
 * Sections in fixed order: Konflik first (it blocks everything else), then
 * Staged, Unstaged, Untracked. Selection is shared across sections so a single
 * `Stage` press can act on a mixed pick.
 *
 * `discard` is deliberately absent: it destroys work and the contract offers no
 * guarded path for it. Adding it without a guard dialog would violate the PRD's
 * safety rule.
 *
 * Layout, following the Unity reference: a quiet context breadcrumb, then one
 * toolbar of few loud actions, then the grouped file list with its own filter box,
 * then the commit form. Nothing else competes for attention.
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import { ChangeTree } from './ChangeTree';
import { CommitForm } from './CommitForm';
import { ConflictPanel, OperationBanner } from './ConflictPanel';
import { GuardDialog } from './GuardDialog';
import { ToastRegion } from './Toast';
import { bridge, loadState, saveState } from './bridge';
import { formatCount, sanitizeGitText, UNKNOWN_CHURN } from './format';
import { useT } from './useT';
import { groupBySection, type ChangeSection } from './tree';
import {
  toErrorBody,
  useChangesStore,
  useOperationStore,
  useRepoStore,
  useSettingsStore,
  wireHostEvents,
} from './store';
import { ContextBar, EmptyState, ErrorBanner, FileListSkeleton, Icon, InfoBanner } from './ui';
import type { ChangeEntry } from '../messages';

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
  const busy = useChangesStore((s) => s.busy);
  const loading = useChangesStore((s) => s.loading);
  const hasLoaded = useChangesStore((s) => s.hasLoaded);
  const error = useChangesStore((s) => s.error);
  const includeUntracked = useChangesStore((s) => s.includeUntracked);
  const load = useChangesStore((s) => s.load);
  const toggle = useChangesStore((s) => s.toggle);
  const toggleFolder = useChangesStore((s) => s.toggleFolder);
  const toggleCollapsed = useChangesStore((s) => s.toggleCollapsed);
  const selectAll = useChangesStore((s) => s.selectAll);
  const clear = useChangesStore((s) => s.clear);
  const stage = useChangesStore((s) => s.stage);
  const unstage = useChangesStore((s) => s.unstage);

  const status = useRepoStore((s) => s.status);
  /**
   * Whether the host managed to count every file's lines. A row without numbers is
   * otherwise indistinguishable from an unchanged file, and one panel-level sentence
   * explains all of them at once instead of hiding the fact in per-row tooltips.
   */
  const churnTruncated = status?.churnTruncated === true;
  const loadStatus = useRepoStore((s) => s.loadStatus);
  const loadSettings = useSettingsStore((s) => s.load);
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const pushToast = useOperationStore((s) => s.pushToast);
  const showLogs = useOperationStore((s) => s.showLogs);
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
      commitMessage: persisted.commitMessage,
      pushAfterCommit: persisted.pushAfterCommit,
      includeUntracked: persisted.includeUntracked,
    });
    // Scroll position is restored after the first paint, once rows exist.
    requestAnimationFrame(() => {
      if (scrollRef.current !== null) scrollRef.current.scrollTop = persisted.scrollTop;
    });
    const off = wireHostEvents('pending');
    void loadSettings();
    void load();
    void loadStatus();
    return off;
  }, [load, loadSettings, loadStatus]);

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

  /** Untracked files are only staged when the user opted in. */
  const stageablePaths = (): string[] =>
    selected.filter((path) => {
      const entry = changes.find((c) => c.path === path);
      if (entry === undefined) return false;
      return includeUntracked || !entry.untracked;
    });

  const stageable = stageablePaths();

  return (
    <div className="gc-pending">
      <ContextBar status={status} />

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

      {/*
        Primary actions (Stage, Unstage, Refresh) with secondary actions (Select all, Clear)
        grouped cleanly. Filter disclosure toggle keeps toolbar clean and uncluttered.
      */}
      <div
        className="gc-pending__bar gc-toolbar--actions"
        role="toolbar"
        aria-label={strings.pending.toolbarLabel}
        aria-orientation="horizontal"
      >
        <div className="gc-toolbar__primary-group gc-segmented">
          <button
            type="button"
            className="gc-button gc-button--action gc-button--stage"
            aria-label={strings.pending.stageAria(formatCount(stageable.length, language))}
            title={strings.pending.stageTitle}
            disabled={busy || stageable.length === 0}
            onClick={() => void stage(stageablePaths())}
          >
            <Icon name="arrow-down" />{strings.pending.stageButton}
          </button>
          <button
            type="button"
            className="gc-button gc-button--action gc-button--unstage"
            aria-label={strings.pending.unstageAria(formatCount(selected.length, language))}
            title={strings.pending.unstageTitle}
            disabled={busy || selected.length === 0}
            onClick={() => void unstage(selected)}
          >
            <Icon name="arrow-up" />{strings.pending.unstageButton}
          </button>
        </div>

        <div className="gc-toolbar__secondary-group">
          <button
            type="button"
            className="gc-button gc-button--quiet"
            title={strings.pending.selectAllTitle}
            disabled={changes.length === 0}
            onClick={selectAll}
          >
            {strings.pending.selectAll}
          </button>
          <button
            type="button"
            className="gc-button gc-button--quiet"
            title={strings.pending.clearSelectionTitle}
            disabled={selected.length === 0}
            onClick={clear}
          >
            {strings.pending.clearSelection}
          </button>
        </div>

        <div className="gc-toolbar__end">
          <span className="gc-pending__count" aria-live="off">
            {strings.pending.selectedCount(formatCount(selected.length, language))}
          </span>
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
        <EmptyState
          title={strings.pending.emptyTitle}
          hint={strings.pending.emptyHint}
        />
      ) : (
        <>
          {/*
            List header with integrated search filter disclosure.
          */}
          <div className="gc-listbar">
            <div className="gc-listbar__header">
              <h2 className="gc-listbar__title">
                {strings.pending.changesHeader}
                <span className="gc-listbar__total">{strings.pending.changesTotal(formatCount(changes.length, language))}</span>
              </h2>
            </div>
            <div className="gc-listbar__search-wrap">
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
                return (
                  <section className="gc-section" key={section} aria-label={title}>
                    <h3 className="gc-section__title">
                      <span
                        className={`gc-section__badge gc-section__badge--${badge.tone}`}
                        aria-hidden="true"
                      >
                        {badge.letter}
                      </span>
                      <span className="gc-section__name">{title}</span>
                      <span className="gc-section__count">{formatCount(entries.length, language)}</span>
                    </h3>
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
                          ? { label: 'Unstage', run: (e) => void unstage([e.path]) }
                          : { label: 'Stage', run: (e) => void stage([e.path]) }
                      }
                    />
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}

      <CommitForm />
      <GuardDialog />
      <ToastRegion />
    </div>
  );
}
