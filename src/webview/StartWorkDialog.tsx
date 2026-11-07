/**
 * "Start work on #n" dialog (P09).
 *
 * The name is a suggestion, not a decision: the field starts selected so typing
 * replaces it, the command preview shows the exact argv that will run, and a
 * duplicate or invalid name is refused here rather than by a host error round
 * trip. Everything the issue contributes is untrusted text, so it passes the
 * sanitizer before it is drawn.
 *
 * The dialog closes before it awaits the action. A host guard verdict then has an
 * empty stage to draw `GuardDialog` on, instead of two modals stacked.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from 'react';
import { gitCommandOf, sanitizeGitText } from './format';
import {
  branchNameProblem,
  startWorkRequest,
  suggestBranchName,
  type BranchNameProblem,
  type IssueRef,
} from './issueBranch';
import { useOperationStore } from './store';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { useT } from './useT';
import { Icon } from './ui';

export interface StartWorkDialogProps {
  issue: IssueRef;
  headHash: string | null;
  /** Local branch short names; a match blocks the name before it reaches git. */
  existingLocal: readonly string[];
  /** `status.dirty || status.staged`. The note only appears when it is true. */
  dirty: boolean;
  onCancel: () => void;
  /** Called after the action settles, whether it succeeded or not. */
  onDone: () => void;
}

export function StartWorkDialog({
  issue,
  headHash,
  existingLocal,
  dirty,
  onCancel,
  onDone,
}: StartWorkDialogProps): JSX.Element {
  const strings = useT();
  const runAction = useOperationStore((s) => s.runAction);
  const pushToast = useOperationStore((s) => s.pushToast);
  const [name, setName] = useState(() => suggestBranchName(issue));
  const [problem, setProblem] = useState<BranchNameProblem | null>(() =>
    branchNameProblem(suggestBranchName(issue), existingLocal),
  );
  const { dialogRef, onKeyDown } = useDialogFocusTrap(onCancel);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const titleId = useId();
  const hintId = useId();
  const problemId = useId();
  const commandLabelId = useId();
  const dirtyId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const title = sanitizeGitText(issue.title);
  const request = startWorkRequest(name, headHash);
  const command = request === null ? '' : gitCommandOf(request);
  const problemText =
    problem === null
      ? null
      : problem === 'empty'
        ? strings.startWork.problemEmpty
        : problem === 'invalid'
          ? strings.startWork.problemInvalid
          : strings.startWork.problemExists;

  const describedBy =
    [hintId, problem === null ? null : problemId, dirty ? dirtyId : null].filter(Boolean).join(' ') ||
    undefined;

  const change = (next: string): void => {
    setName(next);
    setProblem(branchNameProblem(next.trim(), existingLocal));
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (request === null) return;
    const created = name.trim();
    // Close first: a guard verdict then has an empty stage to draw on.
    onDone();
    void runAction(request).then((ok) => {
      // `runAction` reports a guard verdict through its own dialog and returns
      // false, so a "created" toast on that path would contradict what the user
      // just read. Only a real success gets one.
      if (ok) pushToast({ level: 'info', message: strings.startWork.doneToast(created) });
    });
  };

  return (
    <div className="gc-modal-backdrop">
      <div
        className="gc-modal gc-modal--start-work"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <header className="gc-start-work__header">
          <span className="gc-start-work__badge" aria-hidden="true">
            <Icon name="git-branch" />
          </span>
          <div className="gc-start-work__titles">
            <h2 className="gc-modal__title" id={titleId}>
              {strings.startWork.title(String(issue.number))}
            </h2>
            <p className="gc-start-work__subtitle">{strings.startWork.subtitle}</p>
            {title.length > 0 && <p className="gc-start-work__issue">#{issue.number} {title}</p>}
          </div>
          <button
            type="button"
            className="gc-icon-button"
            aria-label={strings.startWork.closeAria}
            title={strings.startWork.closeAria}
            onClick={onCancel}
          >
            <Icon name="close" />
          </button>
        </header>

        <form className="gc-start-work__body" onSubmit={submit}>
          <label className="gc-field">
            <span className="gc-field__label">{strings.startWork.fieldLabel}</span>
            <input
              ref={inputRef}
              type="text"
              value={name}
              maxLength={255}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={problem !== null}
              aria-describedby={describedBy}
              onChange={(event) => change(event.target.value)}
            />
          </label>
          <span className="gc-help-text" id={hintId}>
            {strings.startWork.fieldHint}
          </span>

          {problemText !== null && (
            <p className="gc-field__error" id={problemId} role="alert">
              <span aria-hidden="true">!</span>
              <span>{problemText}</span>
            </p>
          )}

          {dirty && (
            <p className="gc-help-text gc-start-work__dirty" id={dirtyId}>
              {strings.startWork.dirtyNote}
            </p>
          )}

          <div className="gc-start-work__command">
            <span className="gc-start-work__command-label" id={commandLabelId}>
              {strings.startWork.commandLabel}
            </span>
            <code aria-describedby={commandLabelId}>{command}</code>
          </div>

          <div className="gc-modal__actions">
            <button type="button" className="gc-button" onClick={onCancel}>
              {strings.guard.cancelButton}
            </button>
            <button
              type="submit"
              className="gc-button gc-button--primary"
              disabled={problem !== null}
              title={problemText ?? undefined}
            >
              <Icon name="add" />
              {strings.startWork.submit}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
