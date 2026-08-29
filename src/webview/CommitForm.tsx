/**
 * Commit form (FEAT-02).
 *
 * Validation is inline and focus-managed: an empty message moves focus back to
 * the textarea and announces the error rather than silently refusing. The button
 * is disabled while a commit is in flight, on top of the host's idempotency —
 * belt and braces for PRD Kasus 2.
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

  return (
    <form className="gc-commit" onSubmit={submit}>
      <label className="gc-field">
        <span className="gc-field__label">Pesan commit</span>
        <textarea
          ref={textareaRef}
          className="gc-commit__message"
          value={message}
          rows={3}
          required
          aria-invalid={messageError !== null}
          aria-describedby={messageError !== null ? 'gc-commit-error' : undefined}
          placeholder="Jelaskan singkat apa yang Anda ubah"
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>

      {messageError !== null && (
        <p className="gc-field__error" id="gc-commit-error" role="alert">
          {messageError}
        </p>
      )}

      <label className="gc-checkbox">
        <input
          type="checkbox"
          checked={pushAfter}
          disabled={busy}
          onChange={(e) => setPushAfter(e.target.checked)}
        />
        <span>Push setelah commit</span>
      </label>

      <label className="gc-checkbox">
        <input
          type="checkbox"
          checked={includeUntracked}
          disabled={busy}
          onChange={(e) => setIncludeUntracked(e.target.checked)}
        />
        <span>Include untracked</span>
      </label>

      <div className="gc-commit__actions">
        <button type="submit" className="gc-button gc-button--primary" disabled={busy || tooShort}>
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
            Coba Push Lagi
          </button>
        )}
      </div>
    </form>
  );
}
