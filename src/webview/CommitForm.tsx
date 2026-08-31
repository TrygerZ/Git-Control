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
 *
 * This is the one primary button on the panel. Everything in the toolbar above is
 * a step towards it, so it is the only control here drawn at full weight.
 */
import { useEffect, useRef, type JSX } from 'react';
import { formatCount } from './format';
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
  const changes = useChangesStore((s) => s.changes);
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
  const stagedCount = changes.filter((entry) => entry.staged).length;
  const hintId = 'gc-commit-hint';
  const errorId = 'gc-commit-error';
  const scopeId = 'gc-commit-scope';

  return (
    <form className="gc-commit" onSubmit={submit} aria-label="Buat commit">
      <h2 className="gc-commit__title">Simpan perubahan (commit)</h2>

      <div className="gc-commit__field-wrap">
        <textarea
          ref={textareaRef}
          className="gc-commit__message"
          value={message}
          rows={2}
          required
          minLength={COMMIT_MESSAGE_MIN}
          aria-invalid={messageError !== null}
          aria-label="Pesan commit"
          aria-describedby={messageError !== null ? `${errorId} ${hintId}` : hintId}
          placeholder="Pesan commit (minimal 3 karakter)..."
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>

      {messageError !== null && (
        <p className="gc-field__error" id={errorId} role="alert">
          <span aria-hidden="true">!</span>
          <span>{messageError}</span>
        </p>
      )}

      <details className="gc-commit__advanced">
        <summary className="gc-commit__advanced-toggle">
          Opsi lanjutan
        </summary>
        <div className="gc-commit__options">
          <label className="gc-checkbox" title="Commit langsung dikirim ke remote setelah berhasil dibuat.">
            <input
              type="checkbox"
              checked={pushAfter}
              disabled={busy}
              onChange={(e) => setPushAfter(e.target.checked)}
            />
            <span className="gc-checkbox__text">
              <span>Push ke remote setelah commit</span>
            </span>
          </label>

          <label className="gc-checkbox" title="File baru (untracked) akan otomatis diikutsertakan saat stage.">
            <input
              type="checkbox"
              checked={includeUntracked}
              disabled={busy}
              onChange={(e) => setIncludeUntracked(e.target.checked)}
            />
            <span className="gc-checkbox__text">
              <span>Sertakan file belum dilacak saat stage</span>
            </span>
          </label>
        </div>
      </details>

      <p className="gc-commit__scope" id={scopeId}>
        {stagedCount === 0
          ? 'Belum ada file di staging area.'
          : `${formatCount(stagedCount)} file siap di-commit.`}
      </p>

      <div className="gc-commit__actions">
        <button
          type="submit"
          className="gc-button gc-button--primary gc-button--lg"
          title="Simpan isi staging area sebagai satu commit di komputer ini."
          disabled={busy || stagedCount === 0}
          aria-describedby={tooShort ? `${hintId} ${scopeId}` : scopeId}
        >
          Commit
        </button>
        {busy && <Spinner label="Menyimpan commit…" />}
        {retryPush !== null && (
          <button
            type="button"
            className="gc-button"
            title="Kirim ulang commit yang sudah tersimpan ke remote."
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
