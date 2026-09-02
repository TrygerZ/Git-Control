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
import { useT } from './useT';
import { COMMIT_MESSAGE_MIN, useChangesStore, useSettingsStore } from './store';
import { Spinner } from './ui';

export function CommitForm(): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((x) => x.language);
  const message = useChangesStore((st) => st.commitMessage);
  const setMessage = useChangesStore((st) => st.setCommitMessage);
  const pushAfter = useChangesStore((st) => st.pushAfterCommit);
  const setPushAfter = useChangesStore((st) => st.setPushAfterCommit);
  const busy = useChangesStore((st) => st.busy);
  const messageError = useChangesStore((st) => st.messageError);
  const commit = useChangesStore((st) => st.commit);
  const retryPush = useChangesStore((st) => st.retryPush);
  const changes = useChangesStore((st) => st.changes);
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
    <form className="gc-commit" onSubmit={submit} aria-label={strings.commitForm.formAria}>
      <h2 className="gc-commit__title">{strings.commitForm.title}</h2>

      <div className="gc-commit__field-wrap">
        <textarea
          ref={textareaRef}
          className="gc-commit__message"
          value={message}
          rows={2}
          required
          minLength={COMMIT_MESSAGE_MIN}
          aria-invalid={messageError !== null}
          aria-label={strings.commitForm.messageAria}
          aria-describedby={messageError !== null ? `${errorId} ${hintId}` : hintId}
          placeholder={strings.commitForm.placeholder}
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
          {strings.commitForm.advancedOptions}
        </summary>
        <div className="gc-commit__options">
          <label className="gc-checkbox">
            <input
              type="checkbox"
              checked={pushAfter}
              disabled={busy}
              onChange={(e) => setPushAfter(e.target.checked)}
            />
            <span className="gc-checkbox__text">
              <span>{strings.commitForm.pushAfter}</span>
            </span>
          </label>
        </div>
      </details>

      <p className="gc-commit__scope" id={scopeId}>
        {stagedCount === 0
          ? strings.commitForm.noStagedFiles
          : strings.commitForm.stagedFilesReady(formatCount(stagedCount, language))}
      </p>

      <div className="gc-commit__actions">
        <button
          type="submit"
          className="gc-button gc-button--primary gc-button--lg"
          title={strings.commitForm.commitTitle}
          disabled={busy || stagedCount === 0}
          aria-describedby={tooShort ? `${hintId} ${scopeId}` : scopeId}
        >
          {strings.commitForm.commitButton}
        </button>
        {busy && <Spinner label={strings.commitForm.savingCommit} />}
        {retryPush !== null && (
          <button
            type="button"
            className="gc-button"
            title={strings.commitForm.retryPushTitle}
            disabled={busy}
            onClick={() => void retryPush()}
          >
            {strings.commitForm.retryPush}
          </button>
        )}
      </div>
    </form>
  );
}
