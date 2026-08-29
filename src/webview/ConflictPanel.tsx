/**
 * Conflict panel (FEAT-04/06).
 *
 * Every conflict code is explained in Indonesian, because "UU" means nothing to
 * someone who is avoiding the terminal. `Lanjutkan merge` stays disabled until
 * the conflict list is empty, and the reason is always visible — a disabled
 * button with no explanation is worse than no button.
 */
import { type JSX } from 'react';
import { conflictLabel, formatCount, operationLabel } from './format';
import { bridge } from './bridge';
import { toErrorBody, useChangesStore, useOperationStore } from './store';
import { EmptyState, InfoBanner } from './ui';
import type { ConflictEntry, OperationState, RepoStatus } from '../messages';

/** Banner shown above the canvas while any git operation is unfinished. */
export function OperationBanner({ status }: { status: RepoStatus | null }): JSX.Element | null {
  const runAction = useOperationStore((s) => s.runAction);
  if (status === null || status.operation === 'idle') return null;
  const resolved = status.conflicts.length === 0;

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
          title={resolved ? undefined : 'Selesaikan semua file konflik terlebih dahulu.'}
          onClick={() => void runAction({ action: 'merge-continue' })}
        >
          Lanjutkan merge
        </button>
        <button
          type="button"
          className="gc-button"
          onClick={() => void runAction({ action: 'merge-abort' })}
        >
          Batalkan merge
        </button>
      </span>
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

  const openMergeEditor = async (path: string): Promise<void> => {
    try {
      await bridge.request('actions/openDiff', { path });
    } catch (err) {
      const body = toErrorBody(err);
      pushToast({
        level: 'warning',
        message:
          body.code === 'UNAVAILABLE'
            ? 'Membuka merge editor belum tersedia pada versi ini.'
            : body.message,
      });
    }
  };

  if (conflicts.length === 0) {
    return (
      <EmptyState
        title="Tidak ada konflik."
        hint={
          operation === 'idle'
            ? undefined
            : 'Operasi git masih berjalan. Gunakan tombol lanjutkan di banner atas.'
        }
      />
    );
  }

  return (
    <section className="gc-conflicts" aria-label="File konflik">
      <h3 className="gc-conflicts__title">
        {formatCount(conflicts.length)} file perlu diselesaikan
      </h3>
      <ul className="gc-conflicts__list">
        {conflicts.map((entry) => (
          <li key={entry.path} className="gc-conflicts__item">
            <span className="gc-conflicts__path" title={entry.path}>
              {entry.path}
            </span>
            <span className="gc-conflicts__code">{conflictLabel(entry.code)}</span>
            <span className="gc-conflicts__actions">
              <button
                type="button"
                className="gc-button gc-button--primary"
                onClick={() => void openMergeEditor(entry.path)}
              >
                Selesaikan
              </button>
              <button
                type="button"
                className="gc-button"
                disabled={busy}
                onClick={() => void stage([entry.path])}
              >
                Tandai selesai
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="gc-conflicts__footer">
        <button
          type="button"
          className="gc-button gc-button--primary"
          disabled
          title="Selesaikan semua file konflik terlebih dahulu."
        >
          Lanjutkan merge
        </button>
        <button
          type="button"
          className="gc-button"
          onClick={() => void runAction({ action: 'merge-abort' })}
        >
          Batalkan merge
        </button>
      </div>
    </section>
  );
}
