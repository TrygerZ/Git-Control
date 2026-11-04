/**
 * Merge confirmation dialog with merge commit toggle.
 *
 * Confirms merging target branch into current branch, offering an optional
 * toggle to create a dedicated merge commit (--no-ff).
 * Default behavior remains fast-forward (unchecked).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from 'react';
import { sanitizeGitText } from './format';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { useT } from './useT';

export interface MergeDialogProps {
  branch: string;
  currentBranch?: string | null;
  onSubmit: (noFf: boolean) => void;
  onCancel: () => void;
}

/** Pure helper calculating git merge action payload. */
export function mergeActionPayload(
  branch: string,
  noFf: boolean,
): { action: 'merge'; branch: string; noFf?: boolean } {
  return {
    action: 'merge',
    branch,
    ...(noFf ? { noFf: true } : {}),
  };
}

/** Pure helper calculating git merge-into action payload. */
export function mergeIntoActionPayload(
  target: string,
  source: string,
  noFf: boolean,
): { action: 'merge-into'; target: string; source: string; noFf?: boolean } {
  return {
    action: 'merge-into',
    target,
    source,
    ...(noFf ? { noFf: true } : {}),
  };
}

export function MergeDialog({
  branch,
  currentBranch,
  onSubmit,
  onCancel,
}: MergeDialogProps): JSX.Element {
  const strings = useT();
  const [noFf, setNoFf] = useState(false);
  const { dialogRef, onKeyDown } = useDialogFocusTrap(onCancel);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);

  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    returnFocus.current = document.activeElement;
    submitButtonRef.current?.focus();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    onSubmit(noFf);
  };

  const safeBranch = sanitizeGitText(branch);
  const safeCurrent = currentBranch ? sanitizeGitText(currentBranch) : undefined;

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
          {strings.mergeDialog.title}
        </h2>

        <form onSubmit={handleSubmit} className="gc-modal__body">
          <p id={descId}>
            {strings.mergeDialog.prompt(safeBranch, safeCurrent)}
          </p>

          <label className="gc-checkbox">
            <input
              type="checkbox"
              checked={noFf}
              onChange={(e) => setNoFf(e.target.checked)}
            />
            <span className="gc-checkbox__text">
              <span>{strings.mergeDialog.noFfLabel}</span>
              <span className="gc-checkbox__hint">
                {strings.mergeDialog.noFfHint}
              </span>
            </span>
          </label>

          <div className="gc-modal__actions">
            <button
              type="button"
              className="gc-button"
              onClick={onCancel}
            >
              {strings.mergeDialog.cancelButton}
            </button>
            <button
              ref={submitButtonRef}
              type="submit"
              className="gc-button gc-button--primary"
            >
              {strings.mergeDialog.submitButton}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
