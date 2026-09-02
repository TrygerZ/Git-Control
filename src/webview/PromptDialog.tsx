/**
 * Single-field text prompt or dropdown selection modal (FEAT-04 / FIX-01).
 *
 * Collects a single string from the user, either freeform or constrained to a list of options.
 * Used for actions requiring user input (such as branch creation or merge destination selection)
 * in the sandboxed VS Code webview where window.prompt() is a no-op.
 *
 * Implements strict accessibility:
 * - Backdrop + dialog with role="dialog", aria-modal="true", aria-labelledby, aria-describedby
 * - Initial focus on input/select, focus restored to previous element on unmount
 * - Tab trapping inside modal and Escape key handling to cancel
 * - Form submission for Enter key activation
 * - Inline validation error presentation with aria-invalid + role="alert"
 */
import { useEffect, useId, useRef, useState, type FormEvent, type JSX, type KeyboardEvent } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

export interface PromptDialogProps {
  title: string;
  label: string;
  submitLabel: string;
  cancelLabel: string;
  initialValue?: string;
  placeholder?: string;
  hint?: string;
  options?: readonly string[];
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({
  title,
  label,
  submitLabel,
  cancelLabel,
  initialValue = '',
  placeholder,
  hint,
  options,
  validate,
  onSubmit,
  onCancel,
}: PromptDialogProps): JSX.Element {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const returnFocus = useRef<Element | null>(null);

  const titleId = useId();
  const descId = useId();
  const errorId = useId();
  const hintId = useId();

  useEffect(() => {
    returnFocus.current = document.activeElement;
    controlRef.current?.focus();
    if (controlRef.current instanceof HTMLInputElement) {
      controlRef.current.select();
    }
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
    const trimmed = value.trim();
    if (validate !== undefined) {
      const validationError = validate(trimmed);
      if (validationError !== null) {
        setError(validationError);
        return;
      }
    }
    onSubmit(trimmed);
  };

  const describedBy = [
    hint !== undefined ? hintId : null,
    error !== null ? errorId : null,
  ]
    .filter(Boolean)
    .join(' ') || undefined;

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
          {title}
        </h2>

        <form onSubmit={handleSubmit} className="gc-modal__body" id={descId}>
          <label className="gc-field">
            <span className="gc-field__label">{label}</span>
            {options !== undefined ? (
              <select
                ref={(node) => {
                  controlRef.current = node;
                }}
                value={value}
                aria-invalid={error !== null}
                aria-describedby={describedBy}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error !== null) setError(null);
                }}
              >
                {options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <input
                ref={(node) => {
                  controlRef.current = node;
                }}
                type="text"
                value={value}
                placeholder={placeholder}
                aria-invalid={error !== null}
                aria-describedby={describedBy}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error !== null) setError(null);
                }}
              />
            )}
          </label>

          {hint !== undefined && (
            <span className="gc-help-text" id={hintId}>
              {hint}
            </span>
          )}

          {error !== null && (
            <p className="gc-field__error" id={errorId} role="alert">
              <span aria-hidden="true">!</span>
              <span>{error}</span>
            </p>
          )}

          <div className="gc-modal__actions">
            <button
              type="button"
              className="gc-button"
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
            <button
              type="submit"
              className="gc-button gc-button--primary"
            >
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
