/**
 * Merge confirmation dialog with merge commit toggle.
 *
 * Confirms merging target branch into current branch, offering an optional
 * toggle to create a dedicated merge commit (--no-ff).
 * Default behavior remains fast-forward (unchecked).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type JSX, type KeyboardEvent } from 'react';
import { sanitizeGitText } from './format';
import { useT } from './useT';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

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

export function MergeDialog({
  branch,
  currentBranch,
  onSubmit,
  onCancel,
}: MergeDialogProps): JSX.Element {
  const strings = useT();
  const [noFf, setNoFf] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const node = dialogRef.current;
    if (node === null) return;
    const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

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
