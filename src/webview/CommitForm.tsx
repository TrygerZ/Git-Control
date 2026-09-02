/**
 * Commit form (FEAT-02), at the top of the Source Control anatomy.
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
 * This is the one primary button on the panel. The toolbar with branch and
 * selection helpers sits below it, and the grouped file list below that, so the
 * message box is the first thing a hand reaches. The staged count that used to
 * live as a paragraph below the form now lives as the Commit button's title when
 * disabled, while the badge on the Staged Changes header carries the same number
 * visually.
 */
import { useEffect, useRef, type JSX } from 'react';
import { formatCount } from './format';
import { useT } from './useT';
import { COMMIT_MESSAGE_MIN, useChangesStore, useOperationStore, useRepoStore, useSettingsStore } from './store';
import { Spinner } from './ui';
import { firstRemoteName } from './NodeContextMenu';

export function CommitForm(): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((x) => x.language);
  const status = useRepoStore((st) => st.status);
  const graph = useRepoStore((st) => st.graph);
  const runAction = useOperationStore((st) => st.runAction);
  const opBusy = useOperationStore((st) => st.state === 'loading');
  const message = useChangesStore((st) => st.commitMessage);
  const setMessage = useChangesStore((st) => st.setCommitMessage);
  const pushAfter = useChangesStore((st) => st.pushAfterCommit);
  const setPushAfter = useChangesStore((st) => st.setPushAfterCommit);
  const changesBusy = useChangesStore((st) => st.busy);
  const busy = changesBusy || opBusy;
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

  const stagedCount = changes.filter((entry) => entry.staged).length;
  const errorId = 'gc-commit-error';

  // Scope sentence ("N staged files ready") used to live as a paragraph below the
  // form; it now lives on the Commit button's title so the disabled reason is still
  // perceivable without duplicating the badge already on the Staged Changes header.
  const commitButtonTitle =
    stagedCount === 0
      ? strings.commitForm.noStagedFiles
      : `${strings.commitForm.commitTitle} ${strings.commitForm.stagedFilesReady(formatCount(stagedCount, language))}`;

  // Remote derivation rule:
  // 1. If status.upstream is present, extract remote prefix (e.g. "origin/main" -> "origin").
  // 2. Otherwise fall back to first remote-tracking ref prefix in repo graph.
  // 3. If neither exists, remote is null and push button must not render.
  const remote =
    status?.upstream !== null && status?.upstream !== undefined
      ? status.upstream.split('/')[0] ?? null
      : firstRemoteName(graph?.refs ?? []);

  const branch = status?.branch ?? null;
  const hasUpstream = status?.upstream !== null && status?.upstream !== undefined;
  const setUpstream = !hasUpstream;

  let pushDisabled = false;
  let pushTitle = '';
  if (busy) {
    pushDisabled = true;
    pushTitle = strings.commitForm.pushDisabledBusy;
  } else if (status === null || branch === null) {
    pushDisabled = true;
    pushTitle = strings.commitForm.pushDisabledNoBranch;
  } else if (hasUpstream && (status.ahead ?? 0) === 0) {
    pushDisabled = true;
    pushTitle = strings.commitForm.pushDisabledInSync;
  } else if (remote !== null) {
    pushTitle = setUpstream
      ? strings.commitForm.publishTitle(remote, branch)
      : strings.commitForm.pushTitle(remote, branch);
  }

  const pushLabel = setUpstream
    ? strings.commitForm.publishButton
    : (status?.ahead ?? 0) > 0
      ? strings.commitForm.pushWithCountButton(formatCount(status?.ahead ?? 0, language))
      : strings.commitForm.pushButton;

  const handlePush = (): void => {
    if (remote === null || branch === null) return;
    void runAction({ action: 'push', remote, branch, setUpstream });
  };

  return (
    <form className="gc-commit" onSubmit={submit} aria-label={strings.commitForm.formAria}>
      <div className="gc-commit__field-wrap">
        {/*
          Only describe by errorId when present: minimum length rule is in placeholder,
          and failures are announced by role="alert" on the error block.
        */}
        <textarea
          ref={textareaRef}
          className="gc-commit__message"
          value={message}
          rows={3}
          required
          minLength={COMMIT_MESSAGE_MIN}
          aria-invalid={messageError !== null}
          aria-label={strings.commitForm.messageAria}
          aria-describedby={messageError !== null ? errorId : undefined}
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

      <div className="gc-commit__actions">
        <button
          type="submit"
          className="gc-button gc-button--primary"
          title={commitButtonTitle}
          disabled={busy || stagedCount === 0}
        >
          {strings.commitForm.commitButton}
        </button>
        {remote !== null && (
          <button
            type="button"
            className="gc-button gc-button--action"
            title={pushTitle}
            disabled={pushDisabled}
            onClick={handlePush}
          >
            {pushLabel}
          </button>
        )}
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
