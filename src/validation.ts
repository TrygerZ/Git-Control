/**
 * Pure input validation for every value that reaches a git argv array.
 * No vscode / node imports so this module is unit-testable in isolation.
 *
 * Threat model: all inputs originate from the webview (untrusted) and end up as
 * git command arguments. Even with `shell: false`, a value that begins with `-`
 * is parsed by git as an option, so validation is the primary defense against
 * argument injection, path traversal, and ref-name confusion.
 */

const HEX = /^[0-9a-fA-F]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Defends against: passing arbitrary strings where git expects an object id,
 * which could otherwise smuggle option-like or path-like values into argv.
 */
export function validateHash(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length < 7 || value.length > 40) return false;
  return HEX.test(value);
}

/**
 * Defends against: ambiguous abbreviated hashes when an exact object id is
 * required (e.g. comparing HEAD identity across a stale-status check).
 */
export function validateFullHash(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.length === 40 && HEX.test(value);
}

/**
 * Defends against: ref-name injection and refs git itself would reject.
 * Implements the practical subset of `git check-ref-format` rules.
 */
export function validateBranchName(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 255) return false;
  if (value === '@') return false;
  if (value.startsWith('-')) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  if (value.includes('//')) return false;
  if (value.includes('..')) return false;
  if (value.includes('@{')) return false;
  if (value.endsWith('.')) return false;
  if (CONTROL_CHARS.test(value)) return false;
  if (/[ ~^:?*[\\]/.test(value)) return false;
  for (const segment of value.split('/')) {
    if (segment.length === 0) return false;
    if (segment.startsWith('.')) return false;
    if (segment.endsWith('.lock')) return false;
  }
  return true;
}

/**
 * Defends against: a remote name that git would read as an option or a path,
 * e.g. `--upload-pack=...` smuggled through a push/fetch target.
 */
export function validateRemoteName(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 100) return false;
  if (value.startsWith('-')) return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Defends against: path traversal and absolute-path escapes when staging or
 * unstaging files. Paths must stay inside the repository working tree.
 */
export function validateRepoRelativePath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 4096) return false;
  if (CONTROL_CHARS.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  const segments = value.split(/[\\/]/);
  return !segments.includes('..');
}

/**
 * Defends against: empty or absurdly large commit messages reaching git and
 * against accidental commits with placeholder text. Message itself is passed on
 * stdin, so shell escaping is not a concern here — only sanity bounds are.
 */
export function validateCommitMessage(value: unknown): { ok: boolean; message?: string } {
  if (typeof value !== 'string') return { ok: false, message: 'Commit message must be a string.' };
  const trimmed = value.trim();
  if (trimmed.length < 3) return { ok: false, message: 'Commit message must be at least 3 characters.' };
  if (trimmed.length > 20000) return { ok: false, message: 'Commit message must be at most 20000 characters.' };
  return { ok: true, message: trimmed };
}

/**
 * Defends against: control characters corrupting the stash reflog and
 * unbounded values inflating `.git` metadata.
 */
export function validateStashMessage(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length > 100) return false;
  return !CONTROL_CHARS.test(value);
}

/**
 * Defends against: unbounded `git log` invocations used as a denial-of-service
 * against the extension host.
 */
export function validateLimit(value: unknown, max = 10000): boolean {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  return value >= 1 && value <= max;
}

/**
 * Defends against: argument injection. `shell: false` stops shell metacharacter
 * attacks but git still interprets a leading `-` as an option, which would let
 * a crafted ref enable things like `--force` or `--upload-pack`.
 *
 * @throws {Error} when the value would be parsed as a git option.
 */
export function sanitizeRefArg(value: string): string {
  if (value.startsWith('-')) {
    throw new Error(`Refusing git argument that looks like an option: ${value}`);
  }
  return value;
}
