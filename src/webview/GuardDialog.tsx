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
 *
 * Emphasis, deliberately inverted from a normal dialog
 * ---------------------------------------------------
 * On every other surface the loud `--primary --lg` button is the one that gets the
 * work done. Here it is `Batal`. This dialog's entire job is to stop a press that
 * was already made once, so the button drawn at full weight is the one that undoes
 * that press; the remedies that change the repository reversibly (`Fetch`, `Stash`)
 * sit in the `--action` tier, and `Konfirmasi` stays `--danger` — visible, nameable,
 * and quieter than the way out. It is the only surface where the primary button is
 * an exit, and that is the point.
 *
 * This does not break the "one `--primary --lg` per surface" rule even while `Commit`
 * is mounted behind it: the backdrop covers the panel and `aria-modal` makes
 * everything under it inert, so there is exactly one live surface and exactly one
 * loud button on it. When the dialog closes, `Commit` is loud again.
 *
 * Level 2 additionally gets its own frame (`--severe`) accented with
 * `--gc-tone-removed`, because "you cannot get this back" is a different KIND of
 * warning from "this will take a while" and a sentence alone does not say so before
 * it is read.
 */
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import {
  actionTarget,
  actionTitle,
  consequenceOf,
  gitCommandOf,
  orderedRemedies,
  presentError,
  remedyConsequence,
  remedyLabel,
  riskLabel,
  sanitizeGitText,
} from './format';
import { useOperationStore, type PendingGuard } from './store';
import { Icon } from './ui';
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
  const detailId = useId();
  const command = gitCommandOf(request);
  /**
   * Level 2 is the only case where a mistake cannot be undone by git itself, so it
   * gets a visual tier of its own rather than one more paragraph. Level 1 keeps the
   * plain frame: making every guard look catastrophic teaches the user to ignore the
   * frame, which costs exactly the warning that mattered.
   */
  const severe = level === 2;
  /**
   * Buttons in safety order, not host order: see `orderedRemedies`. The confirmation
   * moves off the bottom-right corner so a reflex press lands on `Batal` instead.
   */
  const remedies = orderedRemedies(view.remedies);

  return (
    <div className="gc-modal-backdrop">
      <div
        className={severe ? 'gc-modal gc-modal--severe' : 'gc-modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <h2 className="gc-modal__title" id={titleId}>
          {/*
            The severity marker is a glyph plus the word `Permanen`, not a colour: the
            frame around this dialog is the fourth channel, and in a forced-colours
            theme it is the only one that disappears. `aria-hidden` on the glyph alone
            — the word is real text and is meant to be announced with the title.
          */}
          {severe && (
            <span className="gc-modal__severity">
              <Icon name="warning" />
              {' '}Permanen
            </span>
          )}
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
                  <Icon name="warning" />
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
              <Icon name="warning" />
              <span>
                Konfirmasi kedua diperlukan. Perubahan yang dibuang tidak dapat dikembalikan, termasuk
                oleh Git sendiri.
              </span>
            </p>
          )}
        </div>

        {/*
          The command block is a teaching surface, not a technical footnote.

          A newcomer who never opens a terminal still benefits from seeing the one
          line their button press stands for: it is how "Reset hard" stops being a
          label on a button and becomes a thing that exists outside this extension.
          The framing sentence says it is safe to read and that nothing has run yet,
          because an unexplained command box next to a destructive button reads as a
          command box that is already running.
        */}
        <div className="gc-modal__command">
          <span className="gc-modal__command-label" id={commandId}>
            Perintah git yang akan dijalankan
          </span>
          <code aria-describedby={commandId}>{command}</code>
          <span className="gc-modal__command-note">
            Ini perintah yang setara dengan tombol di bawah. Belum ada yang dijalankan. Baris ini hanya
            untuk dibaca, supaya Anda tahu apa yang sebenarnya terjadi di git.
          </span>
        </div>

        {guard.error.detail !== undefined && (
          // Hook output reaches `detail` verbatim, so a hook can choose these bytes.
          // The heading matters: without it this block reads as a message from the
          // extension, and the user looks for the bug in the wrong place.
          <div className="gc-modal__detail-group">
            <span className="gc-modal__command-label" id={detailId}>
              Pesan dari repository Anda
            </span>
            <pre className="gc-modal__detail" aria-describedby={detailId}>
              {sanitizeGitText(guard.error.detail)}
            </pre>
          </div>
        )}

        {level === 2 && stage === 2 && (
          <label className="gc-checkbox">
            <input
              ref={ackRef}
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            {/*
              Two lines, matching the commit form: the statement being agreed to, then
              the concrete loss. "Hilang permanen" is abstract until it names the files
              — a newcomer ticking this box is usually picturing an undo they do not
              have.
            */}
            <span className="gc-checkbox__text">
              <span>Saya mengerti perubahan ini hilang permanen.</span>
              <span className="gc-checkbox__hint">
                File yang sudah Anda ubah tapi belum di-commit akan kembali ke isi commit tujuan. Tidak
                ada perintah git, tombol undo, atau Recycle Bin yang bisa mengembalikannya.
              </span>
            </span>
          </label>
        )}

        <div className="gc-modal__actions">
          {remedies.map((remedy) => {
            const isConfirm = remedy === 'confirm';
            // Stage 1 of a level-2 flow does not run anything: it opens stage 2. The
            // label says `Lanjutkan`, so the title has to say the same thing, or the
            // hover contradicts the button.
            const staging = isConfirm && level === 2 && stage === 1;
            const label = staging ? 'Lanjutkan' : remedyLabel(remedy);
            return (
              <button
                key={remedy}
                type="button"
                ref={remedy === 'cancel' ? cancelRef : undefined}
                /*
                 * Tiers, inverted on purpose (see the file header): the safe exit is
                 * the loud one, reversible remedies are tier two, and the
                 * irreversible confirmation stays `--danger`.
                 */
                className={
                  isConfirm
                    ? 'gc-button gc-button--danger'
                    : remedy === 'cancel'
                      ? 'gc-button gc-button--primary gc-button--lg'
                      : 'gc-button gc-button--action'
                }
                // The confirm button names what it will do, not just "Konfirmasi":
                // this is the last stop before an irreversible command runs.
                aria-label={isConfirm ? `${label}: ${command}` : undefined}
                aria-describedby={isConfirm && confirmDisabled ? ackHintId : undefined}
                title={
                  staging
                    ? 'Membuka tahap konfirmasi terakhir. Belum menjalankan perintah apa pun.'
                    : isConfirm
                      ? `Menjalankan ${command} sekarang. ${consequenceOf(request)}`
                      : remedyConsequence(remedy)
                }
                disabled={isConfirm ? confirmDisabled : busy}
                onClick={() => void handleRemedy(remedy)}
              >
                {label}
              </button>
            );
          })}
          {!remedies.includes('cancel') && (
            <button
              type="button"
              className="gc-button gc-button--primary gc-button--lg"
              ref={cancelRef}
              title={remedyConsequence('cancel')}
              onClick={close}
            >
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
