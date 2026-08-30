/**
 * Safety guard modal (FEAT-04).
 *
 * Rendered whenever a mutation is blocked by the guard or declares
 * `requiresConfirmation`. It shows the target, the plain-Indonesian consequence,
 * and the exact git command — the command is read-only and exists purely so the
 * user learns what the button does.
 *
 * Level 2 (`reset --hard`) is a two-stage flow: the first pane explains, the
 * second requires an explicit acknowledgement checkbox before `Konfirmasi`
 * enables. Force push is never offered anywhere; a `REMOTE_AHEAD` block only
 * ever leads to Fetch.
 */
import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import {
  actionTarget,
  actionTitle,
  consequenceOf,
  gitCommandOf,
  presentError,
  remedyLabel,
  riskLabel,
  sanitizeGitText,
} from './format';
import { useOperationStore, type PendingGuard } from './store';
import type { GitActionRequest, Remedy } from '../messages';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export function GuardDialog(): JSX.Element | null {
  const guard = useOperationStore((s) => s.pendingGuard);
  if (guard === null) return null;
  return <GuardDialogBody guard={guard} />;
}

function GuardDialogBody({ guard }: { guard: PendingGuard }): JSX.Element {
  const dismiss = useOperationStore((s) => s.dismissGuard);
  const confirm = useOperationStore((s) => s.confirmGuard);
  const runAction = useOperationStore((s) => s.runAction);
  const view = presentError(guard.error);
  const level = guard.error.confirmationLevel ?? 1;
  const [stage, setStage] = useState<1 | 2>(1);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const ackRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<Element | null>(null);

  /**
   * Move focus in on open, restore it on close.
   *
   * Focus goes to Cancel, not to the first focusable child: the first child is
   * whichever remedy the host listed first, and for a level-2 `reset --hard` that
   * can be `Konfirmasi`. Landing on the destructive button and pressing Enter out of
   * habit is exactly the accident this dialog exists to prevent.
   */
  useEffect(() => {
    returnFocus.current = document.activeElement;
    const node = dialogRef.current;
    const target = cancelRef.current ?? node?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
    target?.focus();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  // Entering the second stage moves focus to the acknowledgement box, which is the
  // only thing that can unblock the flow from there.
  useEffect(() => {
    if (stage === 2) ackRef.current?.focus();
  }, [stage]);

  const close = (): void => {
    dismiss();
  };

  /** Trap Tab inside the dialog; Escape always cancels. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const node = dialogRef.current;
    if (node === null) return;
    // `Array.from` rather than spread: the project's `lib` omits DOM.Iterable.
    const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleRemedy = async (remedy: Remedy): Promise<void> => {
    if (remedy === 'cancel') {
      close();
      return;
    }
    setBusy(true);
    try {
      if (remedy === 'confirm') {
        if (level === 2 && stage === 1) {
          setStage(2);
          return;
        }
        await confirm(level === 2 ? { confirm: true, forceAcknowledgement: true } : { confirm: true });
        return;
      }
      if (remedy === 'fetch') {
        close();
        await runAction({ action: 'fetch', prune: true });
        return;
      }
      if (remedy === 'stash') {
        close();
        await runAction({ action: 'stash', message: 'Git Control auto stash', includeUntracked: true });
        return;
      }
      if (remedy === 'commit') {
        close();
        useOperationStore.getState().pushToast({
          level: 'info',
          message: 'Buka panel Pending Changes untuk commit perubahan Anda.',
        });
        return;
      }
      if (remedy === 'resolve-conflicts') {
        close();
        useOperationStore.getState().pushToast({
          level: 'info',
          message: 'Selesaikan file konflik di panel Konflik, lalu lanjutkan.',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const request: GitActionRequest = guard.request;
  const risk = guard.error.risk;
  const confirmDisabled = busy || (level === 2 && stage === 2 && !acknowledged);
  const titleId = 'gc-guard-title';
  const descId = 'gc-guard-desc';
  const commandId = 'gc-guard-command';
  const ackHintId = 'gc-guard-ack-hint';

  return (
    <div className="gc-modal-backdrop">
      <div
        className="gc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <h2 className="gc-modal__title" id={titleId}>
          {actionTitle(request)}
        </h2>

        {/*
          Target, problem, and — for a two-stage flow — where the user is in it. The
          stage line is a fact about the dialog, so it belongs with the other facts
          rather than buried in the prose.
        */}
        <dl className="gc-modal__facts">
          <dt>Target</dt>
          <dd>{actionTarget(request)}</dd>
          <dt>Masalah</dt>
          <dd>{view.title}</dd>
          {risk !== undefined && (
            <>
              <dt>Tingkat risiko</dt>
              <dd className="gc-risk">
                <span className="gc-risk__glyph" aria-hidden="true">
                  ⚠
                </span>
                <span>{riskLabel(risk)}</span>
              </dd>
            </>
          )}
          {level === 2 && (
            <>
              <dt>Konfirmasi</dt>
              <dd>Tahap {stage} dari 2</dd>
            </>
          )}
        </dl>

        <div className="gc-modal__body" id={descId}>
          <p>{view.explanation}</p>
          {/* The consequence is the sentence that must not be skimmed, so it is
              set apart rather than run in with the explanation. */}
          <p className="gc-modal__consequence">{consequenceOf(request)}</p>
          {stage === 2 && (
            <p className="gc-modal__warning">
              <span aria-hidden="true">⚠</span>
              <span>
                Konfirmasi kedua diperlukan. Perubahan yang dibuang tidak dapat dikembalikan, termasuk
                oleh Git sendiri.
              </span>
            </p>
          )}
        </div>

        <div className="gc-modal__command">
          <span className="gc-modal__command-label" id={commandId}>
            Perintah git yang akan dijalankan
          </span>
          <code aria-describedby={commandId}>{gitCommandOf(request)}</code>
        </div>

        {guard.error.detail !== undefined && (
          // Hook output reaches `detail` verbatim, so a hook can choose these bytes.
          <pre className="gc-modal__detail">{sanitizeGitText(guard.error.detail)}</pre>
        )}

        {level === 2 && stage === 2 && (
          <label className="gc-checkbox">
            <input
              ref={ackRef}
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>Saya mengerti perubahan ini hilang permanen.</span>
          </label>
        )}

        <div className="gc-modal__actions">
          {view.remedies.map((remedy) => {
            const isConfirm = remedy === 'confirm';
            const label =
              isConfirm && level === 2 && stage === 1 ? 'Lanjutkan' : remedyLabel(remedy);
            return (
              <button
                key={remedy}
                type="button"
                ref={remedy === 'cancel' ? cancelRef : undefined}
                className={
                  isConfirm
                    ? 'gc-button gc-button--danger'
                    : remedy === 'cancel'
                      ? 'gc-button'
                      : 'gc-button gc-button--primary'
                }
                // The confirm button names what it will do, not just "Konfirmasi":
                // this is the last stop before an irreversible command runs.
                aria-label={isConfirm ? `${label}: ${gitCommandOf(request)}` : undefined}
                aria-describedby={isConfirm && confirmDisabled ? ackHintId : undefined}
                disabled={isConfirm ? confirmDisabled : busy}
                onClick={() => void handleRemedy(remedy)}
              >
                {label}
              </button>
            );
          })}
          {!view.remedies.includes('cancel') && (
            <button type="button" className="gc-button" ref={cancelRef} onClick={close}>
              Batal
            </button>
          )}
        </div>

        {/* A disabled button with no stated reason is worse than no button. */}
        {confirmDisabled && !busy && (
          <p className="gc-help-text" id={ackHintId}>
            Centang pernyataan di atas untuk mengaktifkan tombol konfirmasi.
          </p>
        )}
      </div>
    </div>
  );
}
