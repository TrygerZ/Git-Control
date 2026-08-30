/**
 * Commit form (FEAT-02).
 *
 * Validation is inline and focus-managed: an empty message moves focus back to
 * the textarea and announces the error rather than silently refusing. The button
 * is disabled while a commit is in flight, on top of the host's idempotency —
 * belt and braces for PRD Kasus 2.
 *
 * The submit button is never disabled for a short message: a control that is off
 * for a reason the user cannot see is a dead end. It submits, fails validation,
 * and says why — which also keeps the reason reachable by keyboard.
 */
import { useEffect, useRef, type JSX } from 'react';
import { COMMIT_MESSAGE_MIN, useChangesStore } from './store';
import { Spinner } from './ui';

export function CommitForm(): JSX.Element {
  const message = useChangesStore((s) => s.commitMessage);
  const setMessage = useChangesStore((s) => s.setCommitMessage);
  const pushAfter = useChangesStore((s) => s.pushAfterCommit);
  const setPushAfter = useChangesStore((s) => s.setPushAfterCommit);
  const includeUntracked = useChangesStore((s) => s.includeUntracked);
  const setIncludeUntracked = useChangesStore((s) => s.setIncludeUntracked);
  const busy = useChangesStore((s) => s.busy);
  const messageError = useChangesStore((s) => s.messageError);
  const commit = useChangesStore((s) => s.commit);
  const retryPush = useChangesStore((s) => s.retryPush);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Pull focus back to the field the moment validation fails.
  useEffect(() => {
    if (messageError !== null) textareaRef.current?.focus();
  }, [messageError]);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    void commit();
  };

  const tooShort = message.trim().length < COMMIT_MESSAGE_MIN;
  const hintId = 'gc-commit-hint';
  const errorId = 'gc-commit-error';

  return (
    <form className="gc-commit" onSubmit={submit} aria-label="Buat commit">
      <label className="gc-field">
        <span className="gc-field__label">Pesan commit</span>
        <textarea
          ref={textareaRef}
          className="gc-commit__message"
          value={message}
          rows={3}
          required
          minLength={COMMIT_MESSAGE_MIN}
          aria-invalid={messageError !== null}
          aria-describedby={messageError !== null ? `${errorId} ${hintId}` : hintId}
          placeholder="Jelaskan singkat apa yang Anda ubah"
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>

      <p className="gc-commit__hint" id={hintId}>
        Minimal {COMMIT_MESSAGE_MIN} karakter. Tulis apa yang berubah dan mengapa — pesan ini yang akan
        Anda baca lagi berbulan-bulan kemudian.
      </p>

      {messageError !== null && (
        <p className="gc-field__error" id={errorId} role="alert">
          <span aria-hidden="true">!</span>
          <span>{messageError}</span>
        </p>
      )}

      <label className="gc-checkbox">
        <input
          type="checkbox"
          checked={pushAfter}
          disabled={busy}
          onChange={(e) => setPushAfter(e.target.checked)}
        />
        <span>Push ke remote setelah commit berhasil</span>
      </label>

      <label className="gc-checkbox">
        <input
          type="checkbox"
          checked={includeUntracked}
          disabled={busy}
          onChange={(e) => setIncludeUntracked(e.target.checked)}
        />
        <span>Sertakan file yang belum dilacak saat stage</span>
      </label>

      <div className="gc-commit__actions">
        <button
          type="submit"
          className="gc-button gc-button--primary"
          disabled={busy}
          aria-describedby={tooShort ? hintId : undefined}
        >
          Commit
        </button>
        {busy && <Spinner label="Menjalankan commit…" />}
        {retryPush !== null && (
          <button
            type="button"
            className="gc-button"
            disabled={busy}
            onClick={() => void retryPush()}
          >
            Coba push lagi
          </button>
        )}
      </div>
    </form>
  );
}
