/**
 * Pure Tab-trap maths shared by every modal dialog.
 *
 * No react, DOM, or vscode imports: the decision "where does Tab go" is data in,
 * index out, so it stays unit-testable under `node:test`.
 */

/**
 * `select:not([disabled])` on purpose: a disabled select cannot take focus, so
 * counting it as first or last item would make the wrap land on nothing.
 */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Index to focus when Tab is pressed, or null to let the browser move focus.
 * Wraps only at the edges: Shift+Tab on the first item goes to the last,
 * Tab on the last item goes to the first. `activeIndex` -1 (focus outside the
 * list) and an empty list return null.
 */
export function trapTabTarget(count: number, activeIndex: number, shiftKey: boolean): number | null {
  if (count === 0 || activeIndex < 0) return null;
  if (shiftKey && activeIndex === 0) return count - 1;
  if (!shiftKey && activeIndex === count - 1) return 0;
  return null;
}

/**
 * Where focus should land after an awaited connect attempt settles.
 *
 * The caller cannot decide this itself: the host input box resolves normally when
 * cancelled, so the only observable difference is whether the button is still in
 * the tree when the await returns. A button that unmounted must not take focus.
 */
export function restoreTarget(buttonStillMounted: boolean): 'connect' | 'none' {
  return buttonStillMounted ? 'connect' : 'none';
}
