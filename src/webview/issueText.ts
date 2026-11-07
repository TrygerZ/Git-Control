/**
 * Pure issue body preview (P08). No markdown parser, no HTML handling: the body
 * is text, and every byte of it reaches the screen escaped by React.
 */
import { sanitizeGitText } from './format';

export const EXCERPT_MAX = 200;

export function issueExcerpt(body: string | null, max: number = EXCERPT_MAX): string {
  if (body === null || max <= 0) return '';
  const collapsed = sanitizeGitText(body.replace(/\s+/g, ' ').trim());
  if (collapsed.length === 0) return '';
  if (collapsed.length > max) {
    return `${collapsed.slice(0, max - 1)}…`;
  }
  return collapsed;
}
