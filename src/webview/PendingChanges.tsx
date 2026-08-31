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
import { groupBySection, type ChangeSection } from './tree';
import {
  toErrorBody,
  useChangesStore,
  useOperationStore,
  useRepoStore,
  useSettingsStore,
  wireHostEvents,
} from './store';
import { ContextBar, EmptyState, ErrorBanner, FileListSkeleton, InfoBanner } from './ui';
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

/**
 * Letter badge per section, mirroring the Unity reference's `C` / `D` / `A` boxes.
 *
 * The letters are not decoration and they are not invented: `U` and `?` are the
 * porcelain codes those sections actually contain, and `S`/`M` stand for the two
 * halves of the staging split. They are a scan anchor only — the Indonesian title
 * next to each one carries the meaning, so a reader who does not know the letters
 * loses nothing.
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
        <InfoBanner tone="info" glyph="?">
          <strong>Jumlah baris tidak lengkap.</strong>
          <span>
            Perubahannya terlalu banyak untuk dihitung semua, jadi sebagian file menampilkan{' '}
            {UNKNOWN_CHURN} pada kolom + dan −. Itu bukan berarti file tersebut tidak berubah,
            hanya jumlah barisnya yang tidak dihitung.
          </span>
        </InfoBanner>
      )}

      {/*
        Primary actions (Stage, Unstage, Refresh) with secondary actions (Pilih semua, Kosongkan)
        grouped cleanly. Filter disclosure toggle keeps toolbar clean and uncluttered.
      */}
      <div
        className="gc-pending__bar gc-toolbar--actions"
        role="toolbar"
        aria-label="Tindakan perubahan"
        aria-orientation="horizontal"
      >
        <div className="gc-toolbar__primary-group">
          <button
            type="button"
            className="gc-button gc-button--action"
            aria-label={`Stage ${formatCount(stageable.length)} file terpilih`}
            title="Masukkan file terpilih ke staging area, supaya ikut pada commit berikutnya."
            disabled={busy || stageable.length === 0}
            onClick={() => void stage(stageablePaths())}
          >
            <span aria-hidden="true">↓ </span>Stage
          </button>
          <button
            type="button"
            className="gc-button gc-button--action"
            aria-label={`Unstage ${formatCount(selected.length)} file terpilih`}
            title="Keluarkan file terpilih dari staging area. Isi file tidak diubah, hanya tidak ikut di-commit."
            disabled={busy || selected.length === 0}
            onClick={() => void unstage(selected)}
          >
            <span aria-hidden="true">↑ </span>Unstage
          </button>
        </div>

        <div className="gc-toolbar__secondary-group">
          <button
            type="button"
            className="gc-button gc-button--quiet"
            title="Centang semua file di daftar. Belum ada yang di-stage sampai Anda menekan Stage."
            disabled={changes.length === 0}
            onClick={selectAll}
          >
            Pilih semua
          </button>
          <button
            type="button"
            className="gc-button gc-button--quiet"
            title="Hapus semua centang. Isi file dan staging area tidak berubah."
            disabled={selected.length === 0}
            onClick={clear}
          >
            Kosongkan
          </button>
        </div>

        <div className="gc-toolbar__end">
          <span className="gc-pending__count" aria-live="off">
            {formatCount(selected.length)} dipilih
          </span>
          <button
            type="button"
            className="gc-icon-button"
            aria-label="Muat ulang daftar perubahan"
            title="Baca ulang status repository dari git."
            disabled={loading}
            onClick={refresh}
          >
            <span aria-hidden="true">⟳</span>
          </button>
        </div>
      </div>

      {loading && changes.length === 0 ? (
        <FileListSkeleton rows={8} />
      ) : changes.length === 0 ? (
        <EmptyState
          title="Tidak ada perubahan."
          hint="Folder kerja bersih dan sinkron dengan commit terakhir."
        />
      ) : (
        <>
          {/*
            List header with integrated search filter disclosure.
          */}
          <div className="gc-listbar">
            <div className="gc-listbar__header">
              <h2 className="gc-listbar__title">
                Perubahan
                <span className="gc-listbar__total">{formatCount(changes.length)} file</span>
              </h2>
            </div>
            <div className="gc-listbar__search-wrap">
              <input
                type="search"
                className="gc-listbar__input"
                value={filter}
                maxLength={100}
                placeholder="Cari file..."
                aria-label="Saring berdasarkan nama file"
                aria-describedby={filterCountId}
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
            {needle.length > 0 && (
              <p className="gc-help-text gc-listbar__count" id={filterCountId} role="status" aria-live="polite">
                {formatCount(visible.length)} dari {formatCount(changes.length)} file cocok
              </p>
            )}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title="Tidak ada file yang cocok."
              hint={`Tidak ada file yang memuat “${sanitizeGitText(filter.trim())}”.`}
              action={
                <button
                  type="button"
                  className="gc-button gc-button--quiet"
                  title="Tampilkan kembali semua file."
                  onClick={() => setFilter('')}
                >
                  Kosongkan pencarian
                </button>
              }
            />
          ) : (
            <div
              className="gc-pending__sections"
              ref={scrollRef}
              onScroll={(event) => saveState({ scrollTop: event.currentTarget.scrollTop })}
            >
              {SECTION_ORDER.map((section) => {
                const entries = groups[section];
                if (entries.length === 0) return null;
                const badge = SECTION_BADGES[section];
                return (
                  <section className="gc-section" key={section} aria-label={SECTION_TITLES[section]}>
                    <h3 className="gc-section__title">
                      <span
                        className={`gc-section__badge gc-section__badge--${badge.tone}`}
                        aria-hidden="true"
                      >
                        {badge.letter}
                      </span>
                      <span className="gc-section__name">{SECTION_TITLES[section]}</span>
                      <span className="gc-section__count">{formatCount(entries.length)}</span>
                    </h3>
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
        </>
      )}

      <CommitForm />
      <GuardDialog />
      <ToastRegion />
    </div>
  );
}
