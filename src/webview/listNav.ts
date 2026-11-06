/**
 * Roving-focus key model for the PR list (P07).
 *
 * The list is one `ul` of buttons with a single tab stop, so the arrow keys are
 * the only way to reach the other rows. Issues (P08) and Actions (P13) reuse it.
 */

export function nextIndex(key: string, index: number, length: number): number {
  if (length <= 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return Math.min(index + 1, length - 1);
    case 'ArrowUp':
      return Math.max(index - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return -1;
  }
}
