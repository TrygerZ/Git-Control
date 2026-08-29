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
 */
import { useEffect, useMemo, useRef, type JSX } from 'react';
import { ChangeTree } from './ChangeTree';
import { CommitForm } from './CommitForm';
import { ConflictPanel, OperationBanner } from './ConflictPanel';
import { GuardDialog } from './GuardDialog';
import { ToastRegion } from './Toast';
import { bridge, loadState, saveState } from './bridge';
import { formatCount } from './format';
import { groupBySection, type ChangeSection } from './tree';
import {
  toErrorBody,
  useChangesStore,
  useOperationStore,
  useRepoStore,
  useSettingsStore,
  wireHostEvents,
} from './store';
import { EmptyState, ErrorBanner, FileListSkeleton } from './ui';
import type { ChangeEntry } from '../messages';

const SECTION_TITLES: Record<ChangeSection, string> = {
  conflicted: 'Konflik',
  staged: 'Siap di-commit',
  unstaged: 'Belum disiapkan',
  untracked: 'Belum dilacak',
};

export function PendingChangesApp(): JSX.Element {
  const changes = useChangesStore((s) => s.changes);
  const conflicts = useChangesStore((s) => s.conflicts);
  const selection = useChangesStore((s) => s.selection);
  const collapsed = useChangesStore((s) => s.collapsed);
  const busy = useChangesStore((s) => s.busy);
  const loading = useChangesStore((s) => s.loading);
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
  const loadStatus = useRepoStore((s) => s.loadStatus);
  const loadSettings = useSettingsStore((s) => s.load);
  const pushToast = useOperationStore((s) => s.pushToast);
  const showLogs = useOperationStore((s) => s.showLogs);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const groups = useMemo(() => groupBySection(changes), [changes]);
  const selected = [...selection];

  const openDiff = async (entry: ChangeEntry): Promise<void> => {
    try {
      await bridge.request('actions/openDiff', { path: entry.path });
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: body.code === 'UNAVAILABLE' ? 'warning' : 'error',
        message:
          body.code === 'UNAVAILABLE'
            ? 'Membuka diff belum tersedia pada versi ini.'
            : body.message,
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

  return (
    <div className="gc-pending">
      <OperationBanner status={status} />

      {error !== null && <ErrorBanner error={error} onShowLogs={showLogs} />}

      {conflicts.length > 0 && (
        <ConflictPanel conflicts={conflicts} operation={status?.operation ?? 'idle'} />
      )}

      <div className="gc-pending__bar" role="toolbar" aria-label="Tindakan perubahan">
        <button type="button" className="gc-button gc-button--quiet" onClick={selectAll}>
          Pilih semua
        </button>
        <button type="button" className="gc-button gc-button--quiet" onClick={clear}>
          Kosongkan pilihan
        </button>
        <button
          type="button"
          className="gc-button"
          disabled={busy || stageablePaths().length === 0}
          onClick={() => void stage(stageablePaths())}
        >
          Stage
        </button>
        <button
          type="button"
          className="gc-button"
          disabled={busy || selected.length === 0}
          onClick={() => void unstage(selected)}
        >
          Unstage
        </button>
        <span className="gc-pending__count">{formatCount(selected.length)} dipilih</span>
      </div>

      {loading && changes.length === 0 ? (
        <FileListSkeleton rows={8} />
      ) : changes.length === 0 ? (
        <EmptyState
          title="Tidak ada perubahan."
          hint="Semua file sudah sesuai dengan commit terakhir."
        />
      ) : (
        <div
          className="gc-pending__sections"
          ref={scrollRef}
          onScroll={(event) => saveState({ scrollTop: event.currentTarget.scrollTop })}
        >
          {(['conflicted', 'staged', 'unstaged', 'untracked'] as ChangeSection[]).map((section) => {
            const entries = groups[section];
            if (entries.length === 0) return null;
            return (
              <section className="gc-section" key={section} aria-label={SECTION_TITLES[section]}>
                <h3 className="gc-section__title">
                  {SECTION_TITLES[section]}
                  <span className="gc-section__count">{formatCount(entries.length)}</span>
                </h3>
                <ChangeTree
                  entries={entries}
                  selection={selection}
                  collapsed={collapsed}
                  busy={busy}
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

      <CommitForm />
      <GuardDialog />
      <ToastRegion />
    </div>
  );
}
