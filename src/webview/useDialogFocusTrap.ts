/**
 * Keyboard containment for modal dialogs: Tab and Shift+Tab wrap inside the
 * dialog, Escape calls `onEscape`. Initial focus and return focus stay with the
 * dialog, because each one focuses a different control.
 */
import { useCallback, useRef, type KeyboardEvent } from 'react';
import { FOCUSABLE_SELECTOR, trapTabTarget } from './focusTrap';

export function useDialogFocusTrap(onEscape: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Read through a ref so `onKeyDown` keeps one identity while callers pass fresh closures.
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      escapeRef.current();
      return;
    }
    if (event.key !== 'Tab') return;
    const node = dialogRef.current;
    if (node === null) return;
    // `Array.from` rather than spread: the project's `lib` omits DOM.Iterable.
    const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const active = document.activeElement;
    const target = trapTabTarget(
      items.length,
      active instanceof HTMLElement ? items.indexOf(active) : -1,
      event.shiftKey,
    );
    if (target === null) return;
    event.preventDefault();
    items[target]?.focus();
  }, []);

  return { dialogRef, onKeyDown };
}
