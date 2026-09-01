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
 * Windows reserved device names. `CON`, `NUL`, and friends resolve to a device
 * rather than a file at ANY directory depth and with any extension, so
 * `a/b/NUL.txt` still opens the null device. Git never tracks such a path.
 */
const WINDOWS_DEVICE_NAMES =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

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
 *
 * A fully qualified `refs/...` name is rejected by default. `git for-each-ref`
 * lists pseudo-refs such as `refs/stash` alongside branches, and a value like
 * `refs/stash` passed where a branch is expected makes git fail with
 * `fatal: a branch is expected, got 'refs/stash'`. Callers that legitimately need
 * the qualified form — only the fast-forward probe, which asks about
 * `refs/remotes/<remote>/<branch>` — opt in with `allowQualified`.
 */
export function validateBranchName(
  value: unknown,
  opts: { allowQualified?: boolean } = {},
): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 255) return false;
  if (value === '@') return false;
  if (value.startsWith('-')) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  if (value.startsWith('refs/')) {
    if (opts.allowQualified !== true) return false;
    if (!value.startsWith('refs/remotes/')) return false;
    const parts = value.split('/');
    if (parts.length < 4) return false;
  }
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
 * `true` when the host filesystem gives `:` and the reserved device names their
 * Windows meaning.
 *
 * Read from `process` rather than imported so this module stays free of `node:`
 * imports; guarded with `typeof` so it also evaluates to `false` if the bundle is
 * ever loaded in a browser context. Every consumer may override it per call,
 * which is how the tests exercise both platforms deterministically.
 */
export const WINDOWS_PATH_SEMANTICS: boolean =
  typeof process !== 'undefined' && process.platform === 'win32';

/**
 * Defends against: path traversal and absolute-path escapes when staging or
 * unstaging files. Paths must stay inside the repository working tree.
 *
 * Platform difference, decided deliberately: `a.txt:stream` is an NTFS alternate
 * data stream on Windows and an ordinary — if unusual — filename on Linux and
 * macOS. The same holds for `con.txt`, a normal word in several languages and a
 * reserved device on Windows. Rejecting either unconditionally would make files
 * a Linux user legitimately tracks unstageable and undiffable through this
 * extension, so both rules apply only under {@link WINDOWS_PATH_SEMANTICS}.
 * Everything that is an escape or a lie on *every* platform — traversal, an
 * absolute or UNC path, a drive-qualified or drive-relative path, a control
 * character, a `.` segment that would make the validated string differ from what
 * the filesystem sees — is rejected everywhere.
 */
export function validateRepoRelativePath(
  value: unknown,
  opts: { windows?: boolean } = {},
): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 4096) return false;
  if (CONTROL_CHARS.test(value)) return false;
  // Absolute POSIX path, and `\\server\share` UNC, which starts with `\`.
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  // `C:\x` and `C:/x`: drive-qualified absolute.
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  // `C:foo`: drive-RELATIVE. Resolves against the process's per-drive current
  // directory on Windows, so it is not a repository-relative path at all, and
  // nothing legitimate in a git index looks like this on any platform.
  if (/^[A-Za-z]:/.test(value)) return false;
  const windows = opts.windows ?? WINDOWS_PATH_SEMANTICS;
  // NTFS alternate data stream: `a.txt:$DATA` names a hidden stream, never a
  // file git tracks. Also a second line of defence for the drive-relative form.
  if (windows && value.includes(':')) return false;
  const segments = value.split(/[\\/]/);
  if (segments.includes('..')) return false;
  if (segments.includes('.')) return false;
  if (windows && segments.some((s) => WINDOWS_DEVICE_NAMES.test(s))) return false;
  return true;
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

export function parseCommitTimestamp(val?: string | number | null): number {
  if (typeof val === 'number') return Number.isFinite(val) && !Number.isNaN(val) && val > 0 ? val : 0;
  if (typeof val === 'string' && val.length > 0) {
    const parsed = Date.parse(val);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
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
