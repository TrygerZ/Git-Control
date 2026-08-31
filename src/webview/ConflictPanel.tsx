/**
 * Conflict panel (FEAT-04/06).
 *
 * Every conflict code is explained in Indonesian, because "UU" means nothing to
 * someone who is avoiding the terminal. `Lanjutkan merge` stays disabled until
 * the conflict list is empty, and the reason is always visible — a disabled
 * button with no explanation is worse than no button.
 *
 * Accessibility: each row's buttons name the file they act on, so a ten-file
 * conflict list does not read as ten identical `Selesaikan` buttons.
 */
import { type JSX } from 'react';
import {
  conflictActionLabel,
  conflictLabel,
  formatCount,
  operationLabel,
  sanitizeGitText,
} from './format';
import { bridge } from './bridge';
import { toErrorBody, useChangesStore, useOperationStore } from './store';
import { EmptyState, InfoBanner } from './ui';
import type { ConflictEntry, OperationState, RepoStatus } from '../messages';

/** Banner shown above the canvas while any git operation is unfinished. */
export function OperationBanner({ status }: { status: RepoStatus | null }): JSX.Element | null {
  const runAction = useOperationStore((s) => s.runAction);
  if (status === null || status.operation === 'idle') return null;
  const resolved = status.conflicts.length === 0;
  const blockedId = 'gc-continue-blocked';

  return (
    <InfoBanner tone="warning" glyph="⚠">
      <strong>{operationLabel(status.operation)}</strong>
      <span>
        {resolved
          ? 'Semua konflik sudah selesai. Anda bisa melanjutkan.'
          : `Masih ada ${formatCount(status.conflicts.length)} file konflik.`}
      </span>
      <span className="gc-banner__buttons">
        <button
          type="button"
          className="gc-button gc-button--primary"
          disabled={!resolved}
          // The reason for the disabled state is announced, not only hovered.
          aria-describedby={resolved ? undefined : blockedId}
          title="Selesaikan operasi ini dan buat commit gabungannya. Hanya bisa setelah semua konflik beres."
          onClick={() => void runAction({ action: 'merge-continue' })}
        >
          Lanjutkan merge
        </button>
        <button
          type="button"
          className="gc-button"
          title="Kembalikan repository ke keadaan sebelum merge dimulai. Perubahan yang sudah di-commit tidak hilang."
          onClick={() => void runAction({ action: 'merge-abort' })}
        >
          Batalkan merge
        </button>
      </span>
      {!resolved && (
        <span className="gc-help-text" id={blockedId}>
          Selesaikan semua file konflik terlebih dahulu.
        </span>
      )}
    </InfoBanner>
  );
}

interface Props {
  conflicts: readonly ConflictEntry[];
  operation: OperationState;
}

export function ConflictPanel({ conflicts, operation }: Props): JSX.Element {
  const stage = useChangesStore((s) => s.stage);
  const busy = useChangesStore((s) => s.busy);
  const runAction = useOperationStore((s) => s.runAction);
  const pushToast = useOperationStore((s) => s.pushToast);
  const blockedId = 'gc-conflicts-blocked';

  const openMergeEditor = async (path: string): Promise<void> => {
    try {
      await bridge.request('actions/openDiff', { path });
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({ level: 'warning', message: body.message });
    }
  };

  if (conflicts.length === 0) {
    return (
      <EmptyState
        title="Tidak ada konflik."
        hint={
          operation === 'idle'
            ? 'Git bisa menggabungkan semua perubahan tanpa campur tangan Anda.'
            : 'Operasi git masih berjalan. Gunakan tombol lanjutkan di banner atas untuk menyelesaikannya.'
        }
      />
    );
  }

  return (
    <section className="gc-conflicts" aria-label="File konflik">
      <h3 className="gc-conflicts__title">
        <span className="gc-conflicts__badge" aria-hidden="true">
          U
        </span>
        {formatCount(conflicts.length)} file perlu diselesaikan
      </h3>
      <p className="gc-conflicts__hint">
        Git menemukan perubahan yang saling bertabrakan pada file berikut. Buka tiap file, pilih versi
        yang benar, lalu tandai selesai. Setelah daftar ini kosong, merge bisa dilanjutkan.
      </p>
      <ul className="gc-conflicts__list">
        {conflicts.map((entry) => {
          const safePath = sanitizeGitText(entry.path);
          return (
            <li key={entry.path} className="gc-conflicts__item">
              <span className="gc-conflicts__path" title={safePath}>
                {safePath}
              </span>
              <span className="gc-conflicts__code">{conflictLabel(entry.code)}</span>
              <span className="gc-conflicts__actions">
                <button
                  type="button"
                  className="gc-button gc-button--action"
                  aria-label={conflictActionLabel('Selesaikan konflik di', entry.path)}
                  title="Buka file ini di editor merge untuk memilih versi yang benar."
                  onClick={() => void openMergeEditor(entry.path)}
                >
                  Selesaikan
                </button>
                <button
                  type="button"
                  className="gc-button gc-button--quiet"
                  aria-label={conflictActionLabel('Tandai selesai', entry.path)}
                  title="Beri tahu git bahwa file ini sudah benar. Sama dengan git add pada file tersebut."
                  disabled={busy}
                  onClick={() => void stage([entry.path])}
                >
                  Tandai selesai
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="gc-conflicts__footer">
        {/*
          Tier deliberately NOT `--primary`: this button is permanently disabled and
          the live `Lanjutkan merge` lives in `OperationBanner` above. Two loud buttons
          with the same word, one of which never works, is worse than one — so this one
          keeps the neutral tier and exists only to state the gate that is blocking it.
        */}
        <button
          type="button"
          className="gc-button"
          disabled
          aria-describedby={blockedId}
          title="Selesaikan operasi ini dan buat commit gabungannya. Masih terkunci karena daftar konflik di atas belum kosong."
        >
          Lanjutkan merge
        </button>
        <button
          type="button"
          className="gc-button"
          title="Kembalikan repository ke keadaan sebelum merge dimulai. Perubahan yang sudah di-commit tidak hilang."
          onClick={() => void runAction({ action: 'merge-abort' })}
        >
          Batalkan merge
        </button>
        <span className="gc-help-text" id={blockedId}>
          Selesaikan semua file konflik terlebih dahulu.
        </span>
      </div>
    </section>
  );
}
