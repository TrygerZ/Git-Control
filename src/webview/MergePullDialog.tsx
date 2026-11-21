/**
 * Merge pull request confirmation dialog (frame 50).
 *
 * The dialog decides nothing. It renders the method radiogroup, the squash
 * message, the delete-branch checkbox, and the exact list of calls that will
 * run; the store owns the request and the key. Nothing here executes: the
 * command list is a reading surface, which is the whole promise of the frame.
 *
 * Rebase is absent by construction (D-08), not by a flag.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type JSX, type KeyboardEvent } from 'react';
import { sanitizeGitText } from './format';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { defaultSquashMessage, mergeCommands, type MergeMethod } from './pullMerge';
import type { Catalog } from './i18n';
import type { PullDetail } from '../messages';
import { useT } from './useT';

export interface MergePullDialogProps {
  detail: PullDetail;
  owner: string;
  repo: string;
  /**
   * The head branch lives in a fork this clone does not have, so there is no
   * local branch to delete and the checkbox is not offered. Derived by the
   * panel from `detail.isFork` with the list row as a fallback.
   */
  isFork: boolean;
  initialMethod?: MergeMethod;
  initialDeleteBranch?: boolean;
  onConfirm(options: {
    method: MergeMethod;
    commitTitle?: string;
    commitMessage?: string;
    deleteBranch?: boolean;
  }): void;
  onCancel(): void;
}

const METHODS: readonly MergeMethod[] = ['merge', 'squash'];

export function MergePullDialog({
  detail,
  owner,
  repo,
  isFork,
  initialMethod = 'squash',
  initialDeleteBranch = false,
  onConfirm,
  onCancel,
}: MergePullDialogProps): JSX.Element {
  const strings = useT();
  const [method, setMethod] = useState<MergeMethod>(initialMethod);
  const [title, setTitle] = useState(() => defaultSquashMessage(detail));
  const [deleteBranch, setDeleteBranch] = useState(initialDeleteBranch);
  const { dialogRef, onKeyDown } = useDialogFocusTrap(onCancel);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();
  const methodId = useId();
  const deleteId = useId();

  useEffect(() => {
    returnFocus.current = document.activeElement;
    confirmRef.current?.focus();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const methodLabel = (value: MergeMethod, catalog: Catalog): string =>
    value === 'merge' ? catalog.prMerge.methodMerge : catalog.prMerge.methodSquash;

  const commands = mergeCommands(
    { owner, repo, number: detail.number, headRef: detail.headRef },
    { method, deleteBranch },
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onConfirm({
      method,
      ...(method === 'squash' && title.trim().length > 0 ? { commitTitle: title.trim() } : {}),
      ...(deleteBranch ? { deleteBranch: true } : {}),
    });
  };

  /**
   * A radiogroup moves with the arrow keys and keeps one tab stop (WAI-ARIA).
   * Left/Up goes back, Right/Down goes forward, and the ends do NOT wrap: there
   * are two options and a wrap hides which end the user is on.
   */
  const onMethodKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = METHODS.indexOf(method);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      setMethod(METHODS[Math.min(index + 1, METHODS.length - 1)] ?? method);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      setMethod(METHODS[Math.max(index - 1, 0)] ?? method);
    }
  };

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
          {strings.prMerge.dialogTitle(methodLabel(method, strings), String(detail.number))}
        </h2>

        <form onSubmit={handleSubmit} className="gc-modal__body">
          <p id={descId} className="gc-help-text">
            {strings.prMerge.runsOnGitHub}
          </p>

          <dl className="gc-modal__facts">
            <dt>{strings.prMerge.target}</dt>
            <dd>
              {`#${detail.number} ${sanitizeGitText(detail.headRef)} into ${sanitizeGitText(detail.baseRef)}`}
            </dd>
            <dt>{strings.prMerge.method}</dt>
            <dd>{methodLabel(method, strings)}</dd>
            <dt>{strings.prMerge.riskLevel}</dt>
            <dd className="gc-prmerge__risk">{strings.prMerge.risky}</dd>
          </dl>

          <div
            className="gc-prmerge__methods"
            role="radiogroup"
            aria-labelledby={methodId}
            onKeyDown={onMethodKeyDown}
          >
            <span id={methodId} className="gc-help-text">
              {strings.prMerge.method}
            </span>
            {METHODS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={method === value}
                tabIndex={method === value ? 0 : -1}
                className={method === value ? 'gc-button gc-button--action' : 'gc-button gc-button--quiet'}
                onClick={() => setMethod(value)}
              >
                {methodLabel(value, strings)}
              </button>
            ))}
          </div>

          {method === 'squash' && (
            <label className="gc-prmerge__field">
              <span className="gc-field__label">{strings.prMerge.commitMessage}</span>
              <input
                type="text"
                value={title}
                maxLength={256}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          )}

          {/*
            A fork's head branch lives in the fork, not in this clone, so there
            is nothing local to delete; offering the checkbox would promise a
            deletion the host cannot perform.
          */}
          {!isFork && detail.headRef.length > 0 && (
            <label className="gc-checkbox" htmlFor={deleteId}>
              <input
                id={deleteId}
                type="checkbox"
                checked={deleteBranch}
                onChange={(event) => setDeleteBranch(event.target.checked)}
              />
              <span className="gc-checkbox__text">
                <span>{strings.prMerge.deleteBranch}</span>
                <span className="gc-checkbox__hint">{strings.prMerge.deleteBranchNote}</span>
              </span>
            </label>
          )}

          {/* Read-only display: nothing inside this list is a control. */}
          <div className="gc-prmerge__commands">
            <span className="gc-prmerge__commands-heading">{strings.prMerge.commandsHeading}</span>
            {commands.map((command) => (
              <code key={command}>{sanitizeGitText(command)}</code>
            ))}
          </div>

          <div className="gc-modal__actions">
            <button type="button" className="gc-button" onClick={onCancel}>
              {strings.prMerge.cancel}
            </button>
            <button ref={confirmRef} type="submit" className="gc-button gc-button--primary">
              {methodLabel(method, strings)}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
