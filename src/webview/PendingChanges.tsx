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

/**
 * One line explaining what each section means, shown under its heading.
 *
 * The panel's whole job is making git legible, and "staged" versus "unstaged" is
 * the single concept newcomers get wrong most often. A sentence per section costs
 * one line and removes the guesswork.
 */
const SECTION_HINTS: Record<ChangeSection, string> = {
  conflicted: 'Git tidak bisa menggabungkan otomatis. Selesaikan dulu sebelum melanjutkan.',
  staged: 'Sudah masuk staging area. Hanya bagian ini yang akan ikut pada commit berikutnya.',
  unstaged: 'Sudah diubah tapi belum masuk staging area. Tekan Stage agar ikut di-commit.',
  untracked: 'File baru yang belum pernah dicatat git. Stage dulu agar mulai dilacak.',
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
  /**
   * Whether the host managed to count every file's lines. A row without numbers is
   * otherwise indistinguishable from an unchanged file, and one panel-level sentence
   * explains all of them at once instead of hiding the fact in per-row tooltips.
   */
  const churnTruncated = status?.churnTruncated === true;
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
      <OperationBanner status={status} />

      {error !== null && <ErrorBanner error={error} onShowLogs={showLogs} />}

      {conflicts.length > 0 && (
        <ConflictPanel conflicts={conflicts} operation={status?.operation ?? 'idle'} />
      )}

      <div className="gc-pending__bar" role="toolbar" aria-label="Tindakan perubahan" aria-orientation="horizontal">
        <button
          type="button"
          className="gc-button gc-button--quiet"
          disabled={changes.length === 0}
          onClick={selectAll}
        >
          Pilih semua
        </button>
        <button
          type="button"
          className="gc-button gc-button--quiet"
          disabled={selected.length === 0}
          onClick={clear}
        >
          Kosongkan pilihan
        </button>
        {/*
          The count rides in the accessible name rather than only in the adjacent
          span: a screen reader user who tabs straight to the button otherwise hears
          `Stage` with no idea how many files it will touch.
        */}
        <button
          type="button"
          className="gc-button"
          aria-label={`Stage ${formatCount(stageable.length)} file terpilih`}
          disabled={busy || stageable.length === 0}
          onClick={() => void stage(stageablePaths())}
        >
          Stage
        </button>
        <button
          type="button"
          className="gc-button"
          aria-label={`Unstage ${formatCount(selected.length)} file terpilih`}
          disabled={busy || selected.length === 0}
          onClick={() => void unstage(selected)}
        >
          Unstage
        </button>
        {/* `aria-live` stays off: this changes on every checkbox tick, and the
            checkbox itself already announces its own new state. */}
        <span className="gc-pending__count" aria-live="off">
          {formatCount(selected.length)} dipilih
        </span>
      </div>

      {loading && changes.length === 0 ? (
        <FileListSkeleton rows={8} />
      ) : changes.length === 0 ? (
        <EmptyState
          title="Tidak ada perubahan."
          hint="Semua file di folder kerja sudah sama dengan commit terakhir. Ubah sebuah file, lalu ia akan muncul di sini siap untuk di-stage."
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
                <p className="gc-help-text">{SECTION_HINTS[section]}</p>
                <ChangeTree
                  entries={entries}
                  selection={selection}
                  collapsed={collapsed}
                  busy={busy}
                  label={`${SECTION_TITLES[section]}: ${formatCount(entries.length)} file`}
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

      <CommitForm />
      <GuardDialog />
      <ToastRegion />
    </div>
  );
}
