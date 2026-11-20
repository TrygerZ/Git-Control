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
 * Defends against: deleting the branch the user is standing on or the
 * repository's default branch, and against every ref-name shape `git branch -d`
 * would misread.
 *
 * The rule is the phase file's: "Never delete HEAD, the default branch, or a
 * branch with unmerged commits". Git supplies the last half itself (`-d`
 * refuses a branch whose work is not merged); this function supplies the first
 * two. A `null` or empty `current` / `defaultBranch` means "unknown" and can
 * never match, because a valid branch name is never empty.
 *
 * Both halves live here rather than in the guard because two layers ask the
 * same question: the guard before the request is accepted, and the bridge again
 * against freshly read status. A disagreement between them would be a path that
 * deletes the checked-out or default branch.
 */
export function validateDeletableBranch(
  value: unknown,
  current: string | null,
  defaultBranch: string | null = null,
): boolean {
  if (!validateBranchName(value)) return false;
  return value !== current && value !== defaultBranch;
}

/**
 * A pull request number, as the only variable part of a refspec.
 *
 * Threat model: the number is composed into `pull/<n>/head` and `pr/<n>` before
 * git sees either, so it must be an integer git itself can hold in a ref. The
 * upper bound is git's own signed 32-bit limit, which keeps the composed name
 * inside what `git check-ref-format` accepts. A string `'1'` is refused: the
 * caller that sends one is a caller whose type is wrong, and the number is never
 * taken from webview text.
 */
export function validatePullRequestNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

/** The local branch a pull request is checked out to. Derived from the number only. */
export function prBranchName(number: number): string {
  if (!validatePullRequestNumber(number)) throw new Error(`invalid pull request number: ${String(number)}`);
  return `pr/${number}`;
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

/**
 * Defends against: non-integer, negative, or excessively large stash indices
 * forming invalid or out-of-range stash refspecs.
 */
export function validateStashIndex(value: unknown, max = 999): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  return value >= 0 && value <= max;
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
 * Defends against: empty, oversized, or control-char polluted email strings reaching the GitHub API.
 * RFC 5321 limits an email address path to 254 octets.
 */
export function validateEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  if (CONTROL_CHARS.test(trimmed)) return false;
  return true;
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
 * Defends against: non-positive, non-integer, or out-of-range parent selectors
 * when reverting merge commits via `-m <mainline>`. Parent indexes in Git are
 * 1-based integers (usually 1 or 2).
 */
export function validateMainline(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  return value >= 1 && Number.isSafeInteger(value);
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

/** Shared assertion boundaries preserve each caller's existing error type and message. */
export function assertValidBranchName(value: string, onInvalid: () => never): void {
  if (!validateBranchName(value)) onInvalid();
}

export function assertValidHash(value: string, onInvalid: () => never): void {
  if (!validateHash(value)) onInvalid();
}

export function assertValidRepoPaths(paths: string[], onInvalid: (path?: string) => never): string[] {
  if (paths.length === 0) onInvalid();
  for (const path of paths) {
    if (!validateRepoRelativePath(path)) onInvalid(path);
  }
  return paths;
}

/** Build literal root-anchored pathspecs after shared path validation. */
export function buildRepoPathspecs(
  paths: string[],
  onInvalid: (path?: string) => never,
): string[] {
  return assertValidRepoPaths(paths, onInvalid).map((path) => `:(top,literal)${path.replace(/\\/g, '/')}`);
}

/**
 * Defends against: a rebase merge reaching the API at all (D-08). The allowlist
 * is the guarantee, not the UI: rebase merge is permanently out of scope, and a
 * request that never carries the value cannot perform it.
 */
export function validateMergeMethod(value: unknown): value is 'merge' | 'squash' {
  return value === 'merge' || value === 'squash';
}

/**
 * Defends against: an unknown review event reaching the reviews endpoint, where
 * GitHub would reject it or apply a state the UI never offered.
 */
export function validateReviewEvent(value: unknown): value is 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
  return value === 'APPROVE' || value === 'REQUEST_CHANGES' || value === 'COMMENT';
}

/**
 * Defends against: a squash title that is blank, unbounded, or spans more than
 * one line. The title becomes the squash commit's subject, so a newline would
 * split it into a subject and an unintended body.
 */
export function validateCommitTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  return !CONTROL_CHARS.test(trimmed);
}

/**
 * Defends against: an empty or unbounded comment body reaching the API. NUL is
 * refused because it truncates downstream text handling; newlines are expected,
 * since a comment body is multi-line Markdown. Content is not policed here: the
 * extension never renders the body, GitHub does.
 */
export function validateCommentBody(value: unknown, max = 65536): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return false;
  return !trimmed.includes('\u0000');
}

/**
 * An issue number, used as the path segment of `/issues/{n}`. Same positive
 * 32-bit integer bound as pull request numbers.
 */
export function validateIssueNumber(value: unknown): value is number {
  return validatePullRequestNumber(value);
}

/**
 * Defends against: an issue title that is blank, unbounded, or carries control
 * characters (including newlines, which would break single-line headings).
 */
export function validateIssueTitle(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (CONTROL_CHARS.test(value)) return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 256;
}

/**
 * Defends against: an oversized or NUL-containing issue description body.
 * Unlike a comment, an issue description may be empty.
 */
export function validateIssueBody(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length > 65_536) return false;
  return !value.includes('\u0000');
}

/**
 * Defends against: an empty, oversized, or control-character-bearing label name.
 */
export function validateLabelName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length > 50 || CONTROL_CHARS.test(value)) return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 50;
}

/**
 * Defends against: non-array label lists, duplicate label names, or more than
 * 10 labels on a single issue write.
 */
export function validateLabelList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 10) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!validateLabelName(item)) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const FORBIDDEN_INPUT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Positive safe integer identifier for a GitHub Actions workflow.
 * Defends against: floats, non-positive values, and path-segment injection in
 * `/actions/workflows/{id}/...` requests.
 */
export function validateWorkflowId(value: unknown): value is number {
  return isPositiveSafeInt(value);
}

/**
 * Positive safe integer identifier for a GitHub Actions run.
 * Defends against: floats, non-positive values, and path-segment injection in
 * `/actions/runs/{id}/...` requests.
 */
export function validateRunId(value: unknown): value is number {
  return isPositiveSafeInt(value);
}

/**
 * Workflow dispatch input name: starts with letter or underscore, up to 100 chars,
 * and excludes prototype-polluting keys.
 * Defends against: malformed input identifiers and prototype pollution via
 * `__proto__`, `constructor`, or `prototype` keys.
 */
export function validateInputName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (FORBIDDEN_INPUT_KEYS.has(value)) return false;
  return INPUT_NAME.test(value);
}

/**
 * Workflow dispatch input value: string of at most 1024 chars without NUL.
 * Defends against: oversized dispatch payloads and NUL truncation downstream.
 */
export function validateInputValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024 && !value.includes('\u0000');
}

/**
 * Workflow dispatch inputs map: plain object with at most 10 valid name/value entries.
 * Defends against: prototype-polluted objects, non-plain prototypes, symbol keys,
 * and unbounded input maps reaching the workflow dispatch endpoint.
 */
export function validateDispatchInputs(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) return false;
  const entries = Object.entries(value);
  if (entries.length > 10) return false;
  for (const [key, entryValue] of entries) {
    if (!validateInputName(key) || !validateInputValue(entryValue)) return false;
  }
  return true;
}

/** Shared assertion primitives for callers that must preserve their own error type. */
