/**
 * Commit form (FEAT-02), rendered as the pinned footer at the bottom of the
 * Pending Changes panel.
 *
 * The footer wrapper supplies the fill and the border-top; the file list above
 * scrolls internally, so the form stays visible. It is mounted on both sub-tabs
 * (Changes and Stashes), so a typed message survives a tab switch.
 *
 * Validation is inline and focus-managed: an empty message moves focus back to
 * the textarea and announces the error rather than silently refusing. The button
 * is disabled while a commit is in flight, on top of the host's idempotency -
 * belt and braces for PRD Kasus 2.
 *
 * The submit button is never disabled for a short message: a control that is off
 * for a reason the user cannot see is a dead end. It submits, fails validation,
 * and says why, which also keeps the reason reachable by keyboard.
 *
 * The staged count that used to live as a paragraph below the form now lives as
 * the Commit button's title when disabled, while the badge on the Staged Changes
 * header carries the same number visually.
 *
 * "Push after commit" used to hide behind an "Advanced options" disclosure. It is
 * a common toggle, so it now sits as a quiet always-visible checkbox row under
 * the textarea; the reserved count row beside it keeps the footer height stable.
 *
 * Amend follows the same rule the host enforces (`amendBlockedReason`): the host
 * stays the authority, and the UI mirrors the rule only so the reason arrives
 * before a failed request. A blocked toggle is never `disabled` - it stays
 * focusable and reveals the reason when activated, because a dead control
 * explains nothing. The subject in the note is repository-controlled text, so it
 * is sanitized at the render site.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { amendBlockedReason, formatCount, sanitizeGitText } from './format';
import { useT } from './useT';
import { COMMIT_MESSAGE_MIN, useChangesStore, useOperationStore, useRepoStore, useSettingsStore } from './store';
import { Icon, InfoBanner, Spinner } from './ui';
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
  const busyKind = useChangesStore((st) => st.busyKind);
  const busy = changesBusy || opBusy;
  const messageError = useChangesStore((st) => st.messageError);
  const amend = useChangesStore((st) => st.amend);
  const setAmend = useChangesStore((st) => st.setAmend);
  const amendBase = useChangesStore((st) => st.amendBase);
  const [showReason, setShowReason] = useState(false);
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

  // Amend mirrors the host rule so the reason arrives before a failed request.
  const amendReason = amendBlockedReason(status);
  const amendOn = amend && amendReason === null;
  const reasonId = 'gc-amend-reason';
  const remoteName = remote ?? status?.upstream?.split('/')[0] ?? 'remote';
  const reasonText =
    amendReason === 'no-head'
      ? strings.commitForm.amendBlockedNoCommit
      : amendReason === 'operation'
        ? strings.commitForm.amendBlockedOperation
        : amendReason === 'published'
          ? strings.commitForm.amendBlockedPublished(remoteName)
          : undefined;

  // A status change that blocks amend drops the stale flag; a fresh reason also
  // closes the note so a later block starts from the hidden state again.
  useEffect(() => {
    setShowReason(false);
  }, [amendReason]);
  useEffect(() => {
    if (amend && amendReason !== null) void setAmend(false);
  }, [amend, amendReason, setAmend]);

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

  let pullDisabled = false;
  let pullTitle = '';
  if (busy) {
    pullDisabled = true;
    pullTitle = strings.commitForm.pullDisabledBusy;
  } else if (status === null || branch === null) {
    pullDisabled = true;
    pullTitle = strings.commitForm.pullDisabledNoBranch;
  } else if (remote !== null) {
    pullTitle = strings.commitForm.pullTitle(remote, branch);
  }

  const pullLabel =
    (status?.behind ?? 0) > 0
      ? strings.commitForm.pullWithCountButton(formatCount(status?.behind ?? 0, language))
      : strings.commitForm.pullButton;

  const handlePull = (): void => {
    void runAction({ action: 'pull' });
  };

  // Label follows the operation marker, never the combined `busy` boolean:
  // `commit()` also raises the changes-store `busy`, so a boolean-based label
  // would claim "staging" during a commit. `busyKind === null` with `busy`
  // true means an operation-store action (push, fetch) is running; the only
  // truthful claim is the generic progress key `operationInProgress`, kept
  // separate from the push-scoped `pushDisabledBusy` button title.
  const statusLabel =
    busyKind === 'stage'
      ? strings.commitForm.stagingChanges
      : busyKind === 'commit'
        ? strings.commitForm.savingCommit
        : strings.commitForm.operationInProgress;

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

      {/*
        Meta row under the textarea: the common "push after commit" toggle stays
        always visible in quiet styling (no disclosure to open for one checkbox),
        and the message length hint sits at the trailing edge. The hint keeps a
        permanent empty slot when the textarea is empty so the card height never
        shifts on the first keystroke.
      */}
      <div className="gc-commit__meta">
        <div className="gc-commit__options">
          <label className="gc-checkbox gc-checkbox--inline">
            <input
              type="checkbox"
              className="gc-checkbox__input"
              checked={pushAfter}
              disabled={busy}
              onChange={(e) => setPushAfter(e.target.checked)}
            />
            <span className="gc-checkbox__text gc-checkbox__text--inline">
              {strings.commitForm.pushAfter}
            </span>
          </label>
          {/*
            A blocked amend stays focusable: `aria-disabled`, never `disabled`,
            so activating it can reveal the reason instead of doing nothing.
          */}
          <label className="gc-checkbox gc-checkbox--inline">
            <input
              type="checkbox"
              className="gc-checkbox__input"
              checked={amendOn}
              // Only while blocked: a dangling `aria-describedby` would point at
              // an element that is not in the DOM.
              {...(amendReason === null
                ? {}
                : { 'aria-disabled': true, 'aria-describedby': reasonId, title: reasonText })}
              onChange={() => {
                if (amendReason === null) void setAmend(!amendOn);
                else setShowReason(true);
              }}
            />
            <span className="gc-checkbox__text gc-checkbox__text--inline">
              {strings.commitForm.amendToggle}
            </span>
          </label>
        </div>
        {amendReason !== null && (
          <span id={reasonId} className="gc-visually-hidden">
            {reasonText}
          </span>
        )}
        <span
          className="gc-commit__count"
          aria-live="off"
          aria-atomic="true"
        >
          {message.length > 0
            ? strings.commitForm.messageLength(formatCount(message.length, language), COMMIT_MESSAGE_MIN)
            : ''}
        </span>
      </div>

      {/*
        One note at a time: a blocked toggle explains itself first, otherwise a
        live amend names the commit it replaces. The subject is repository text,
        so it is sanitized here, at the render site.
      */}
      {showReason && amendReason !== null ? (
        <div className="gc-commit__note">
          <InfoBanner tone="info" glyph="info">
            {reasonText}
          </InfoBanner>
        </div>
      ) : amendOn && amendBase !== null ? (
        <div className="gc-commit__note">
          <InfoBanner tone="info" glyph="info">
            {strings.commitForm.amendNote(
              amendBase.shortHash,
              sanitizeGitText(amendBase.subject),
              remote,
            )}
          </InfoBanner>
        </div>
      ) : null}

      <div className="gc-commit__actions">
        <button
          type="submit"
          className="gc-button gc-button--primary"
          title={amendOn ? strings.commitForm.amendTitle : commitButtonTitle}
          disabled={busy || (stagedCount === 0 && !amendOn)}
        >
          <Icon name="commit" />
          {amendOn ? strings.commitForm.amendButton : strings.commitForm.commitButton}
        </button>
        {remote !== null && (
          <button
            type="button"
            className="gc-button gc-button--action"
            title={pushTitle}
            disabled={pushDisabled}
            onClick={handlePush}
          >
            <Icon name="push" />
            {pushLabel}
          </button>
        )}
        {remote !== null && (
          <button
            type="button"
            className="gc-button gc-button--action"
            title={pullTitle}
            disabled={pullDisabled}
            onClick={handlePull}
          >
            <Icon name="pull" />
            {pullLabel}
          </button>
        )}
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

      {/*
        Progress slot stays permanently rendered to reserve exactly one text row.
        In-flow mount/unmount would alter parent height and shift elements below.
      */}
      <p
        className="gc-commit__status"
        // Full label in title: the row ellipsis-clips in narrow sidebars, so
        // low-vision users need a hover reveal. Only while busy: an idle row
        // has no text and must not show an empty tooltip.
        {...(busy ? { title: statusLabel } : {})}
      >
        {busy && <Spinner label={statusLabel} />}
      </p>
    </form>
  );
}
