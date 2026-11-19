/**
 * Review dialog (frame 107).
 *
 * One textarea and three events over it, because a review is one act: the form
 * the user fills in IS the explicit act, so there is no second confirmation
 * (X-02). Request changes and comment require text; approve may be sent empty.
 *
 * The dialog decides nothing beyond that: it hands the event and the body to the
 * store, which owns the request. Nothing here executes.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type JSX } from 'react';
import { sanitizeGitText } from './format';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import type { Catalog } from './i18n';
import type { ReviewEvent } from '../messages';
import { useT } from './useT';

export interface ReviewDialogProps {
  number: number;
  headRef: string;
  onConfirm(input: { event: ReviewEvent; body: string }): void;
  onCancel(): void;
}

/** Reading order, and the order frame 107 draws them in. */
const EVENTS: readonly ReviewEvent[] = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'];

function eventLabel(event: ReviewEvent, catalog: Catalog): string {
  switch (event) {
    case 'APPROVE':
      return catalog.prMerge.approve;
    case 'REQUEST_CHANGES':
      return catalog.prMerge.requestChanges;
    case 'COMMENT':
      return catalog.prMerge.comment;
  }
}

export function ReviewDialog({ number, headRef, onConfirm, onCancel }: ReviewDialogProps): JSX.Element {
  const strings = useT();
  const [event, setEvent] = useState<ReviewEvent>('APPROVE');
  const [body, setBody] = useState('');
  const { dialogRef, onKeyDown } = useDialogFocusTrap(onCancel);
  const submitRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();
  const noteId = useId();

  useEffect(() => {
    returnFocus.current = document.activeElement;
    submitRef.current?.focus();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  // Request changes and comment carry a message; approve may be empty. The host
  // re-checks this, so the disabled button and the refusal agree.
  const needsText = event !== 'APPROVE';
  const blocked = needsText && body.trim().length === 0;

  const handleSubmit = (submission: FormEvent<HTMLFormElement>): void => {
    submission.preventDefault();
    if (blocked) return;
    onConfirm({ event, body: body.trim() });
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
          {strings.prMerge.reviewTitle(String(number))}
        </h2>

        <form onSubmit={handleSubmit} className="gc-modal__body">
          <p id={descId} className="gc-help-text">
            {strings.prMerge.reviewRunsOnGitHub}
          </p>

          <div className="gc-prmerge__review-actions" role="radiogroup" aria-labelledby={noteId}>
            {EVENTS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={event === value}
                tabIndex={event === value ? 0 : -1}
                className={event === value ? 'gc-button gc-button--action' : 'gc-button gc-button--quiet'}
                onClick={() => setEvent(value)}
              >
                {eventLabel(value, strings)}
              </button>
            ))}
          </div>

          <label className="gc-prmerge__field">
            <span className="gc-field__label">{strings.prMerge.commitMessage}</span>
            <textarea
              value={body}
              placeholder={strings.prMerge.replyPlaceholder}
              aria-describedby={noteId}
              onChange={(change) => setBody(change.target.value)}
            />
          </label>

          <p className="gc-help-text" id={noteId}>
            {strings.prMerge.reviewNote}
          </p>

          <div className="gc-modal__actions">
            <button type="button" className="gc-button" onClick={onCancel}>
              {strings.prMerge.cancel}
            </button>
            <button
              ref={submitRef}
              type="submit"
              className="gc-button gc-button--primary"
              aria-describedby={blocked ? noteId : undefined}
              disabled={blocked}
            >
              {strings.prMerge.submitReview}
            </button>
          </div>

          <p className="gc-help-text">{sanitizeGitText(headRef)}</p>
        </form>
      </div>
    </div>
  );
}
