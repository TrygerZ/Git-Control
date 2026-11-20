/**
 * Close pull request confirmation dialog (Level 1 confirmation).
 *
 * The dialog decides nothing. It renders the target PR, the low risk tier, and
 * the exact PATCH endpoint preview from `closeCommand`; the store owns the
 * request and the idempotency key. Focus lands on Cancel on mount so an
 * accidental Enter never closes a pull request on GitHub.
 */
import { useEffect, useId, useRef, type JSX } from 'react';
import { sanitizeGitText } from './format';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { closeCommand } from './pullMerge';
import type { PullDetail } from '../messages';
import { useT } from './useT';

export interface ClosePullDialogProps {
  detail: PullDetail;
  owner: string;
  repo: string;
  onConfirm(): void;
  onCancel(): void;
}

export function ClosePullDialog({
  detail,
  owner,
  repo,
  onConfirm,
  onCancel,
}: ClosePullDialogProps): JSX.Element {
  const strings = useT();
  const { dialogRef, onKeyDown } = useDialogFocusTrap(onCancel);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();

  // Focus Cancel on mount so a reflex Enter dismisses instead of closing the PR.
  useEffect(() => {
    returnFocus.current = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

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
          {strings.prMerge.closeDialogTitle(String(detail.number))}
        </h2>

        <div className="gc-modal__body">
          <p id={descId} className="gc-help-text">
            {strings.prMerge.closeRunsOnGitHub}
          </p>

          <dl className="gc-modal__facts">
            <dt>{strings.prMerge.target}</dt>
            <dd>{`#${detail.number} ${sanitizeGitText(detail.title)}`}</dd>
            <dt>{strings.prMerge.riskLevel}</dt>
            <dd className="gc-prmerge__risk">{strings.prMerge.closeRiskLow}</dd>
          </dl>

          {/* Read-only display: nothing inside this box is a control. */}
          <div className="gc-prmerge__commands">
            <span className="gc-prmerge__commands-heading">{strings.prMerge.commandsHeading}</span>
            <code>{closeCommand({ owner, repo, number: detail.number })}</code>
          </div>

          <div className="gc-modal__actions">
            <button
              ref={cancelRef}
              type="button"
              className="gc-button gc-button--primary"
              onClick={onCancel}
            >
              {strings.prMerge.cancel}
            </button>
            <button
              type="button"
              className="gc-button gc-button--danger"
              onClick={onConfirm}
            >
              {strings.prMerge.closeConfirmButton}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
