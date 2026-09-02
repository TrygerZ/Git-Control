/**
 * Pure presentation helpers. No DOM, no React, no bridge — so every rule below
 * is unit-testable under `node:test`.
 *
 * User-facing strings are sourced from the i18n catalog (`src/webview/i18n.ts`).
 */
import { parseCommitTimestamp } from '../validation';
import type {
  ChangeEntry,
  ConflictEntry,
  ErrorBody,
  ErrorCode,
  GitActionRequest,
  GitHubRateLimit,
  GraphNode,
  OperationState,
  PullRequestInfo,
  Remedy,
} from '../messages';
import type { IconName } from './icons';
import { t, type Lang } from './i18n';

// --------------------------------------------------------------------- hashes

const SHORT_HASH_LENGTH = 7;

/** First 7 characters of a hash, or the whole thing when it is shorter. */
export function shortHash(hash: string, length: number = SHORT_HASH_LENGTH): string {
  return hash.slice(0, Math.max(1, length));
}

// merge-into.source can be a branch name or a 40-character hash; only shorten hashes,
// because shortHash would make a branch name unreadable.
function refOrShortHash(source: string): string {
  return /^[0-9a-f]{40}$/i.test(source) ? shortHash(source) : sanitizeGitText(source);
}

// ------------------------------------------------------------ untrusted text

/**
 * Characters that change how text READS without changing what it IS.
 *
 * All of them are attacker-controlled in any repository a user clones, because a
 * commit subject, an author name, a branch name, a file path, and a PR title are
 * all just bytes somebody else chose.
 *
 *  - `\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f` — C0 and C1 controls.
 *    `\t`, `\n`, and `\r` are excluded: a commit body is legitimately multi-line
 *    and `<pre>` renders it as written.
 *  - `\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069` — ARABIC LETTER MARK, LRM/RLM,
 *    the bidi embeddings and overrides, and the bidi isolates. U+202E
 *    (RIGHT-TO-LEFT OVERRIDE) reverses the visual order of everything after it,
 *    which is how one commit renders as another.
 *  - `\u200b\u200c\ufeff` — zero-width space, zero-width non-joiner, and BOM. All
 *    invisible, so `ma\u200bin` reads as `main` and is a different ref.
 *
 * U+200D ZERO WIDTH JOINER is handled separately by {@link ZWJ_OUTSIDE_EMOJI},
 * because it is load-bearing inside emoji sequences.
 *
 * Deliberately NOT included: U+00AD SOFT HYPHEN (a rendering hint inside ordinary
 * words) and U+2060-U+2064 (invisible mathematical operators, not a spoofing
 * vector in the strings this extension renders).
 *
 * Known cost, accepted: U+200C is orthographically required in Persian, Urdu, and
 * several Indic scripts, so a commit subject written in those languages gains a
 * visible marker where a joiner was. That is the deliberate trade — the marker
 * says "an invisible character was here", which is a legible imperfection, whereas
 * an unmarked zero-width character in a ref name or a path is a spoof the user
 * cannot see at all. The bytes git acts on are never modified.
 */
const UNSAFE_DISPLAY_CHARS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * U+200D ZERO WIDTH JOINER that is NOT joining two emoji.
 *
 * Inside an emoji sequence the joiner is the sequence: `👨\u200d💻` is one glyph,
 * and replacing the joiner would break ordinary text in a commit subject. Outside
 * one it is just another invisible character, so `main\u200dx` still gets marked.
 * The lookarounds test for Extended_Pictographic on both sides, tolerating an
 * intervening variation selector (U+FE0F) and skin-tone modifier.
 */
const ZWJ_OUTSIDE_EMOJI =
  /(?<![\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}][\uFE0F\u{1F3FB}-\u{1F3FF}]?)\u200D|\u200D(?![\p{Extended_Pictographic}])/gu;

/**
 * Visible stand-in. U+FFFD REPLACEMENT CHARACTER rather than deletion, because
 * deletion is itself a lie: `ma\u200bin` would render as `main`, and the user
 * would read a branch name that does not exist. A visible mark says "something was
 * here that you cannot see", which is the only honest rendering.
 */
export const SANITIZED_MARKER = '\ufffd';

/**
 * Neutralise display-spoofing characters in any string that came from git or from
 * the GitHub API.
 *
 * React escapes HTML, so there is no XSS at these render sites and this is not an
 * XSS control. What React does not do is stop U+202E from reversing the visual
 * order of a commit subject, or a zero-width space from making two distinct refs
 * look identical. The guard dialog is the sharpest case: its whole purpose is to
 * show the exact command and the exact target, and a bidi override in a branch
 * name misrepresents both — the user then approves an operation on an object other
 * than the one they read.
 *
 * Ordinary text is untouched, including every non-ASCII character real prose
 * needs: accented Latin (`é`), Indonesian, CJK, Arabic and Hebrew letters
 * themselves, and emoji up to and including ZWJ sequences.
 *
 * Idempotent: U+FFFD is not in either replaced set.
 */
export function sanitizeGitText(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(UNSAFE_DISPLAY_CHARS, SANITIZED_MARKER)
    .replace(ZWJ_OUTSIDE_EMOJI, SANITIZED_MARKER);
}

// ------------------------------------------------------------------- duration

/** Format a date bucket timestamp to natural localized label, e.g. "23 Aug 2026" or "23 Agu 2026". */
export function formatDateLabel(timestamp?: number | string | null, lang: Lang = 'en'): string {
  const num = parseCommitTimestamp(timestamp);
  const strings = t(lang).format;
  if (num <= 0) {
    return strings.unknownDate;
  }
  const d = new Date(num);
  const day = d.getDate();
  const month = strings.months[d.getMonth()] ?? '';
  const year = d.getFullYear();
  return `${day} ${month} ${year}`;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Calendar-free approximations: good enough for "2 months ago". */
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
/** Anything fresher than this reads as "just now" / "baru saja". */
const JUST_NOW_MS = 10 * SECOND_MS;

/**
 * Relative time. Boundaries are inclusive at the lower unit, so
 * exactly 60 s reads `1m ago` / `1 menit lalu` and exactly 24 h reads `1d ago` / `1 hari lalu`.
 * A timestamp in the future is clamped to `just now` rather than going negative.
 */
export function relativeTime(iso: string, now: number = Date.now(), lang: Lang = 'en'): string {
  const at = Date.parse(iso);
  const strings = t(lang).format;
  if (Number.isNaN(at)) return strings.unknownTime;
  const delta = now - at;
  if (delta < JUST_NOW_MS) return strings.justNow;
  if (delta < MINUTE_MS) return strings.secondsAgo(Math.floor(delta / SECOND_MS));
  if (delta < HOUR_MS) return strings.minutesAgo(Math.floor(delta / MINUTE_MS));
  if (delta < DAY_MS) return strings.hoursAgo(Math.floor(delta / HOUR_MS));
  if (delta < MONTH_MS) return strings.daysAgo(Math.floor(delta / DAY_MS));
  if (delta < YEAR_MS) return strings.monthsAgo(Math.floor(delta / MONTH_MS));
  return strings.yearsAgo(Math.floor(delta / YEAR_MS));
}

/** Absolute timestamp, stable enough to read in a tooltip. */
export function absoluteTime(iso: string, lang: Lang = 'en'): string {
  const at = new Date(iso);
  const strings = t(lang).format;
  if (Number.isNaN(at.getTime())) return strings.unknownTime;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${pad(at.getDate())}/${pad(at.getMonth() + 1)}/${at.getFullYear()} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

// ------------------------------------------------------------- status letters

export interface StatusLabel {
  /** Single-letter git porcelain code, shown verbatim. */
  code: string;
  /** Localized word, so status never depends on colour alone. */
  label: string;
  /** Corresponding custom SVG icon name from iconPaths. */
  icon: IconName;
}

const STATUS_ICONS: Readonly<Record<string, IconName>> = {
  M: 'diff-modified',
  A: 'diff-added',
  D: 'diff-removed',
  R: 'diff-renamed',
  C: 'copy',
  T: 'file-symlink-file',
  U: 'warning',
  '?': 'question',
  '!': 'diff-ignored',
  ' ': 'dash',
};

/** Every porcelain letter this UI must be able to name. Pinned by `a11y.test.ts`. */
export const PORCELAIN_CODES = ['M', 'A', 'D', 'R', 'C', 'T', 'U', '?', '!', ' '] as const;

/** Map a porcelain letter onto its localized label. Space means "unchanged" / "tidak berubah". */
export function statusLabel(code: string, lang: Lang = 'en'): StatusLabel {
  const letters = t(lang).format.statusLetters;
  const key = code.trim().charAt(0).toUpperCase();
  if (key.length === 0) {
    return { code: ' ', label: letters[' '], icon: 'dash' };
  }
  const rawKey = code.trim().charAt(0);
  const label =
    letters[key as keyof typeof letters] ??
    letters[rawKey as keyof typeof letters] ??
    letters.unknown;
  const icon = STATUS_ICONS[key] ?? STATUS_ICONS[rawKey] ?? 'question';
  const displayCode = letters[key as keyof typeof letters] !== undefined || letters[rawKey as keyof typeof letters] !== undefined ? (key || rawKey) : '·';
  return { code: displayCode, label, icon };
}

/** The letter that best describes an entry, preferring the index over the tree. */
export function entryStatus(entry: ChangeEntry, lang: Lang = 'en'): StatusLabel {
  if (entry.untracked) return statusLabel('?', lang);
  const code = entry.indexStatus.trim().length > 0 ? entry.indexStatus : entry.worktreeStatus;
  return statusLabel(code, lang);
}

/**
 * Tone key for a status letter, used to pick the badge colour token in CSS.
 *
 * Colour is the THIRD channel here, never the first: the glyph and the localized
 * word from {@link statusLabel} already carry the state, and this only adds the
 * "at a glance" hue the Unity reference gets from its C/D/A boxes. Several letters
 * deliberately share a tone (`A` and `C` are both "something appeared"), because a
 * hue per letter would invent nine colours nobody can tell apart.
 */
export type StatusTone = 'added' | 'removed' | 'changed' | 'pending' | 'special' | 'neutral';

const STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  M: 'changed',
  A: 'added',
  D: 'removed',
  R: 'special',
  C: 'added',
  T: 'special',
  U: 'removed',
  '?': 'pending',
  '!': 'neutral',
};

/** Tone for a porcelain letter. Unknown letters stay neutral rather than guessing. */
export function statusTone(code: string): StatusTone {
  return STATUS_TONES[code.trim().charAt(0).toUpperCase()] ?? 'neutral';
}

/**
 * One uppercase initial for an author, used inside a commit node like the avatars
 * in the Unity Branch Explorer.
 *
 * One letter, not two: the node is 12–14 px across at 100 % zoom inside a 16 px
 * lane, and two glyphs at that size are a smudge rather than a label. The full
 * name is still in the row text and in {@link rowLabel}, so this is a scanning
 * aid, never the only channel — which is also why the SVG text is `aria-hidden`
 * at the render site.
 *
 * Sanitised, and falls back to `?` when the name has no letter or digit at all
 * (an empty `user.name`, or a name made entirely of marks we replace).
 */
export function authorInitials(name: string): string {
  const clean = sanitizeGitText(name).trim();
  for (const char of clean) {
    if (/[\p{L}\p{N}]/u.test(char)) return char.toLocaleUpperCase('en-US');
  }
  return '?';
}

/** `lama → baru` for renames, plain path otherwise. Sanitised: paths come from git. */
export function displayPath(entry: ChangeEntry): string {
  const path = sanitizeGitText(entry.path);
  if (entry.origPath === undefined || entry.origPath.length === 0) return path;
  return `${sanitizeGitText(entry.origPath)} → ${path}`;
}

/** Trailing path segment, used as the tree row label. Sanitised. */
export function baseName(path: string): string {
  const parts = sanitizeGitText(path).split('/');
  return parts[parts.length - 1] ?? path;
}

// ------------------------------------------------------------------ breadcrumb

/**
 * Folder name of a repository root, for the context breadcrumb.
 *
 * The full absolute path is noise in a header and can be long enough to push the
 * branch name off screen in a sidebar; the folder name is what the user calls the
 * project. Handles both separators because the host runs on Windows too, and a
 * trailing separator (a drive root) falls back to the whole cleaned string rather
 * than to an empty crumb.
 */
export function repoName(repoRoot: string): string {
  const clean = sanitizeGitText(repoRoot).replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/);
  const last = parts[parts.length - 1] ?? '';
  return last.length === 0 ? clean : last;
}

/**
 * Where the branch stands against its remote, in one sentence.
 *
 * `ahead`/`behind` are the two numbers a newcomer most often misreads — a bare
 * `↑2 ↓3` says nothing about which direction is theirs — so each one is spelled out
 * as an action instead of a symbol. No upstream is stated as a fact plus its
 * consequence, because "no remote" is the case where work is silently unbacked.
 */
export function syncSummary(
  status: {
    upstream: string | null;
    ahead: number;
    behind: number;
  },
  lang: Lang = 'en',
): string {
  const strings = t(lang).format;
  if (status.upstream === null) {
    return strings.syncSummaryNoRemote;
  }
  const upstream = sanitizeGitText(status.upstream);
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(strings.syncSummaryAhead(formatCount(status.ahead, lang)));
  if (status.behind > 0) parts.push(strings.syncSummaryBehind(formatCount(status.behind, lang)));
  if (parts.length === 0) return strings.syncSummaryInSync(upstream);
  return `${parts.join(', ')} (${upstream}).`;
}

// ------------------------------------------------------- accessible names

/**
 * Text shown where a churn count would be when git reported none.
 *
 * `+0 / −0` is a lie for an untracked file: it has every line added, git simply
 * never diffs it. An em dash says "not counted", which is the truth.
 */
export const UNKNOWN_CHURN = '?';

/**
 * Why a row has no line counts, used as the `title` next to {@link UNKNOWN_CHURN}.
 *
 * The reasons are NOT interchangeable, which is why they are spelled out
 * separately. "Belum dilacak" tells the reader the file is new and git never
 * diffed it; the truncation reason tells them git was never asked, because the
 * change list was too large to count — a fact the reader cannot deduce from a dash
 * and would otherwise read as "this file did not change".
 *
 * `churnTruncated` is a PARAMETER, not a store read: this module is pure so the
 * visual row and the accessible name are built from the same words, and a store
 * lookup here would make both untestable.
 */
export function churnUnknownReason(entry: ChangeEntry, churnTruncated = false, lang: Lang = 'en'): string {
  const strings = t(lang).format;
  if (entry.untracked) return strings.churnUntracked;
  if (entry.binary) return strings.churnBinary;
  if (churnTruncated) {
    return strings.churnTruncated;
  }
  return strings.churnUncounted;
}

/**
 * Accessible name for one file row in the change tree.
 *
 * A sighted user reads four things off that row: the path, the status letter with
 * its localized word, the churn, and whether the file is binary. All four go in
 * here, in that order, so the two renderings cannot disagree. The visual spans are
 * `aria-hidden` at the render site precisely because this string replaces them.
 *
 * `null` counts are reported as unknown rather than as zero, matching the visual
 * `—`: a screen-reader user hearing "0 baris ditambah" for a brand-new file would
 * be told the file is empty.
 */
export function fileRowLabel(entry: ChangeEntry, churnTruncated = false, lang: Lang = 'en'): string {
  const strings = t(lang).format;
  const parts = [displayPath(entry)];
  if (entry.binary) parts.push(strings.churnBinary.split(',')[0] ?? strings.churnBinary);
  else if (entry.additions === null && entry.deletions === null)
    parts.push(churnUnknownReason(entry, churnTruncated, lang));
  else parts.push(strings.churnSummary(entry.additions ?? 0, entry.deletions ?? 0));
  return parts.join(', ');
}

/** Accessible name for a folder row: name plus how many files it holds. */
export function folderRowLabel(name: string, fileCount: number, lang: Lang = 'en'): string {
  return t(lang).format.folderRowAria(sanitizeGitText(name), formatCount(fileCount, lang));
}

/**
 * Accessible name for a conflict row's action buttons.
 *
 * Without the path every row's buttons are called `Selesaikan`, and a screen
 * reader user tabbing a ten-file conflict list hears the same word ten times.
 */
export function conflictActionLabel(action: string, path: string, lang: Lang = 'en'): string {
  return t(lang).format.conflictActionAria(action, sanitizeGitText(path));
}

/** Accessible name for a conflict row itself: path plus the explained code. */
export function conflictRowLabel(entry: ConflictEntry, lang: Lang = 'en'): string {
  return t(lang).format.conflictRowAria(sanitizeGitText(entry.path), conflictLabel(entry.code, lang));
}

/**
 * Accessible name for a commit row.
 *
 * Lives here rather than in `GraphCanvas.tsx` so it can be asserted without a DOM:
 * this string is the entire row for a screen-reader user, and it must carry every
 * fact the visual row shows. The visual row shows, left to right: the ref chips, the
 * HEAD / local / merge badges, the subject, then a quiet metadata group holding the
 * author, the relative time, and the short hash. All of them appear below, and each
 * visual part is `aria-hidden` at the render site because this replaces it.
 *
 * The ORDER here deliberately differs from the visual one: identity first (hash,
 * then subject), decorations last. A sighted user takes in a row at once and can
 * skip the chips; a screen-reader user hears it strictly in sequence, and leading
 * with "ref main, ref origin/main, HEAD" delays the two facts that identify which
 * commit is being described. Nothing is added or dropped, only ordered for a linear
 * reader.
 *
 * Sanitised for the same reason the visual row is: a screen-reader user makes the
 * same decisions from this string that a sighted user makes from the row, and the
 * two must not be able to disagree.
 */
export function rowLabel(node: GraphNode, now: number, lang: Lang = 'en'): string {
  const strings = t(lang).format;
  const parts = [
    strings.rowCommitPrefix(shortHash(node.hash)),
    sanitizeGitText(node.subject),
    strings.rowAuthorPrefix(sanitizeGitText(node.authorName)),
    relativeTime(node.authoredAt, now, lang),
  ];
  if (node.isHead) parts.push(strings.rowHeadBadge);
  if (node.isMerge) parts.push(strings.rowMergeBadge);
  if (node.local) parts.push(strings.rowLocalBadge);
  else parts.push(strings.rowRemoteBadge);
  // Ref chips are visual-only (`aria-hidden`), so their text must land here too.
  const refs = refNamesLabel(node.refNames, lang);
  if (refs !== null) parts.push(refs);
  return parts.join(', ');
}

/**
 * Ref names of a commit, spelled out in words, or `null` when there are none.
 * `tag: v1` becomes `tag v1` and `origin/main` becomes `remote origin/main`, which
 * is the same distinction the chip glyphs make visually.
 */
export function refNamesLabel(refNames: readonly string[], lang: Lang = 'en'): string | null {
  const strings = t(lang).format;
  const out: string[] = [];
  for (const raw of refNames) {
    const name = sanitizeGitText(raw).trim();
    if (name.length === 0 || name === 'HEAD') continue;
    if (name.startsWith('tag: ')) {
      out.push(strings.refTagPrefix(name.slice(5)));
      continue;
    }
    const short = name.replace('refs/heads/', '').replace('refs/remotes/', '');
    out.push(short.includes('/') && !name.startsWith('refs/heads/') ? strings.refRemotePrefix(short) : short);
  }
  return out.length === 0 ? null : strings.refGroupPrefix(out.join(', '));
}

// ------------------------------------------------------------------ conflicts

/** Explain a two-letter conflict code. */
export function conflictLabel(code: string, lang: Lang = 'en'): string {
  const strings = t(lang).format.conflictCodes;
  const key = sanitizeGitText(code).trim().toUpperCase();
  if (key in strings && key !== 'unknown') {
    return strings[key as keyof Omit<typeof strings, 'unknown'>];
  }
  return strings.unknown(key);
}

// ----------------------------------------------------------------- operations

export function operationLabel(operation: OperationState, lang: Lang = 'en'): string {
  return t(lang).format.operations[operation];
}

// --------------------------------------------------------------------- errors

export function remedyLabel(remedy: Remedy, lang: Lang = 'en'): string {
  return t(lang).format.remedyLabels[remedy];
}

/**
 * What pressing a remedy button will actually do to the repository.
 *
 * Every label above is one word, and those words are the vocabulary the user came
 * here NOT knowing — `Stash` is meaningless to someone avoiding the terminal, and a
 * button whose name is a term of art is a button pressed by guesswork. These
 * sentences ride in `title` on every remedy button so the answer to "and then what
 * happens to my files?" is one hover away, in the same voice as the file-row titles.
 */
export function remedyConsequence(remedy: Remedy, lang: Lang = 'en'): string {
  return t(lang).format.remedyConsequences[remedy];
}

/**
 * Display order for remedy buttons: the confirmation first, every safe way out
 * after it, and `Batal` / `Cancel` last.
 *
 * `.gc-modal__actions` is right-aligned, so "last" is the bottom-right corner — the
 * spot a hand goes to without reading, because that is where `OK` lives in every
 * dialog the user has ever dismissed. This dialog exists to stop exactly that press,
 * so the corner is reserved for Cancel no matter what order the host sent. The
 * default lists already end in `cancel`; this makes that a guarantee rather than a
 * coincidence, because a host that supplies `['cancel', 'confirm']` would otherwise
 * park an irreversible command under the reflex.
 *
 * Order only; nothing is added or removed, so a host that offers no `cancel` still
 * offers no `cancel` and the dialog's own fallback button still appears.
 */
const REMEDY_ORDER: Readonly<Record<Remedy, number>> = {
  confirm: 0,
  commit: 1,
  stash: 1,
  fetch: 1,
  'resolve-conflicts': 1,
  cancel: 2,
};

export function orderedRemedies(remedies: readonly Remedy[]): Remedy[] {
  return [...remedies].sort((a, b) => REMEDY_ORDER[a] - REMEDY_ORDER[b]);
}

export interface ErrorPresentation {
  /** Short headline for the banner or dialog title. */
  title: string;
  /** Plain explanation of what happened and why. */
  explanation: string;
  /** Buttons to offer, always ending in a way out. */
  remedies: Remedy[];
  /** `true` when the Output channel is the next useful step. */
  showLogs: boolean;
}

/**
 * Remedies to offer when the host names none.
 *
 * A banner with no way forward is a dead end, and `['cancel']` for every code is
 * only technically a way out. These are the buttons that actually match the
 * situation; the host's own list always wins when it supplies one. Force push is
 * absent by construction — `REMOTE_AHEAD` and `NON_FAST_FORWARD` lead to Fetch.
 */
const DEFAULT_REMEDIES: Readonly<Record<ErrorCode, readonly Remedy[]>> = {
  VALIDATION_ERROR: ['cancel'],
  AUTH_ERROR: ['cancel'],
  FORBIDDEN: ['cancel'],
  NOT_FOUND: ['cancel'],
  CONFLICT: ['fetch', 'cancel'],
  RATE_LIMITED: ['cancel'],
  SERVER_ERROR: ['cancel'],
  UNAVAILABLE: ['cancel'],
  REPOSITORY_LOCKED: ['cancel'],
  DIRTY_TREE: ['commit', 'stash', 'cancel'],
  REMOTE_AHEAD: ['fetch', 'cancel'],
  STALE_STATUS: ['fetch', 'cancel'],
  NON_FAST_FORWARD: ['fetch', 'cancel'],
  HOOK_REJECTED: ['cancel'],
  CONFIRMATION_REQUIRED: ['confirm', 'cancel'],
};

/** Every {@link ErrorCode}, derived from catalog entries so it cannot drift. */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'AUTH_ERROR',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'SERVER_ERROR',
  'UNAVAILABLE',
  'REPOSITORY_LOCKED',
  'DIRTY_TREE',
  'REMOTE_AHEAD',
  'STALE_STATUS',
  'NON_FAST_FORWARD',
  'HOOK_REJECTED',
  'CONFIRMATION_REQUIRED',
] as const satisfies readonly ErrorCode[];

/** Turn an {@link ErrorBody} into everything the UI needs to render it. */
export function presentError(error: ErrorBody, lang: Lang = 'en'): ErrorPresentation {
  const errorCatalog = t(lang).format.errors;
  const text = errorCatalog[error.code] ?? errorCatalog.SERVER_ERROR;
  const fallback = DEFAULT_REMEDIES[error.code] ?? ['cancel'];
  const remedies =
    error.remedies !== undefined && error.remedies.length > 0 ? error.remedies : [...fallback];
  // `error.message` can be git stderr, which means it can be hook output, which
  // means a repository chose it.
  const message = sanitizeGitText(error.message);
  return {
    title: text.title,
    explanation: message.length > 0 ? `${text.explanation} (${message})` : text.explanation,
    remedies: remedies as Remedy[],
    showLogs: error.code === 'SERVER_ERROR' || error.code === 'HOOK_REJECTED',
  };
}

export function riskLabel(risk: 'low' | 'medium' | 'high', lang: Lang = 'en'): string {
  return t(lang).format.riskLabels[risk];
}

// ------------------------------------------------------------------- numbers

/** Localized grouping for counters shown in banners. */
export function formatCount(value: number, lang: Lang = 'en'): string {
  return value.toLocaleString(t(lang).format.locale);
}

/** Truncate a subject for the graph row, keeping the full text for `title`. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// --------------------------------------------------------------- git actions

/**
 * The exact command the host will run. Read-only, shown in the guard dialog so
 * the user learns the git behind the button — the PRD's core teaching goal.
 *
 * Every interpolated ref is sanitised. This string exists to tell the user what is
 * about to happen; a bidi override inside a branch name would make it say
 * something else, which defeats the dialog's only purpose.
 */
export function gitCommandOf(action: GitActionRequest): string {
  const s = sanitizeGitText;
  switch (action.action) {
    case 'checkout-branch':
      return `git switch ${s(action.branch)}`;
    case 'checkout-commit':
      return `git checkout --detach ${shortHash(action.hash)}`;
    case 'create-branch':
      return `git switch --create ${s(action.name)} ${shortHash(action.startPoint)}`;
    case 'merge':
      return `git merge ${action.noFf === true ? '--no-ff ' : ''}${s(action.branch)}`;
    case 'merge-into': {
      const formattedSource = refOrShortHash(action.source);
      return `git switch ${s(action.target)} && git merge ${formattedSource}`;
    }
    case 'revert':
      return `git revert --no-edit ${shortHash(action.hash)}`;
    case 'reset-soft':
      return `git reset --soft ${shortHash(action.hash)}`;
    case 'reset-hard':
      return `git reset --hard ${shortHash(action.hash)}`;
    case 'push':
      return `git push ${action.setUpstream === true ? '-u ' : ''}${s(action.remote)} ${s(action.branch)}:${s(action.branch)}`;
    case 'push-up-to':
      return `git push ${s(action.remote)} ${shortHash(action.hash)}:refs/heads/${s(action.branch)}`;
    case 'fetch':
      return `git fetch ${action.remote === undefined ? '--all' : s(action.remote)}${action.prune === true ? ' --prune' : ''}`;
    case 'stash':
      return `git stash push${action.includeUntracked === true ? ' -u' : ''} -m "${s(action.message)}"`;
    case 'stash-pop':
      return 'git stash pop';
    case 'merge-continue':
      return 'git merge --continue';
    case 'merge-abort':
      return 'git merge --abort';
    default:
      return 'git';
  }
}

/** Consequence of an action, shown above the command. */
export function consequenceOf(action: GitActionRequest, lang: Lang = 'en'): string {
  const s = sanitizeGitText;
  const strings = t(lang).format.actionConsequences;
  switch (action.action) {
    case 'checkout-branch':
      return strings.checkoutBranch(s(action.branch));
    case 'checkout-commit':
      return strings.checkoutCommit;
    case 'create-branch':
      return strings.createBranch(s(action.name), shortHash(action.startPoint));
    case 'merge':
      return strings.merge(s(action.branch));
    case 'merge-into': {
      const formattedSource = refOrShortHash(action.source);
      return strings.mergeInto(s(action.target), formattedSource);
    }
    case 'revert':
      return strings.revert;
    case 'reset-soft':
      return strings.resetSoft;
    case 'reset-hard':
      return strings.resetHard;
    case 'push':
      return strings.push(s(action.branch), s(action.remote));
    case 'push-up-to':
      return strings.pushUpTo(shortHash(action.hash), s(action.remote), s(action.branch));
    case 'fetch':
      return strings.fetch;
    case 'stash':
      return strings.stash;
    case 'stash-pop':
      return strings.stashPop;
    case 'merge-continue':
      return strings.mergeContinue;
    case 'merge-abort':
      return strings.mergeAbort;
    default:
      return strings.defaultAction;
  }
}

/** Short menu/dialog title for an action. */
export function actionTitle(action: GitActionRequest, lang: Lang = 'en'): string {
  const s = sanitizeGitText;
  const strings = t(lang).format.actionTitles;
  switch (action.action) {
    case 'checkout-branch':
      return strings.checkoutBranch(s(action.branch));
    case 'checkout-commit':
      return strings.checkoutCommit(shortHash(action.hash));
    case 'create-branch':
      return strings.createBranch(s(action.name));
    case 'merge':
      return strings.merge(s(action.branch));
    case 'merge-into': {
      const formattedSource = refOrShortHash(action.source);
      return strings.mergeInto(s(action.target), formattedSource);
    }
    case 'revert':
      return strings.revert(shortHash(action.hash));
    case 'reset-soft':
      return strings.resetSoft(shortHash(action.hash));
    case 'reset-hard':
      return strings.resetHard(shortHash(action.hash));
    case 'push':
      return strings.push(s(action.branch));
    case 'push-up-to':
      return strings.pushUpTo(shortHash(action.hash));
    case 'fetch':
      return strings.fetch;
    case 'stash':
      return strings.stash;
    case 'stash-pop':
      return strings.stashPop;
    case 'merge-continue':
      return strings.mergeContinue;
    case 'merge-abort':
      return strings.mergeAbort;
    default:
      return strings.defaultAction;
  }
}

/** Target the action operates on, shown as the dialog's subject line. Sanitised. */
export function actionTarget(action: GitActionRequest): string {
  if (action.action === 'merge-into') return sanitizeGitText(action.target);
  if ('branch' in action && typeof action.branch === 'string') return sanitizeGitText(action.branch);
  if ('name' in action) return sanitizeGitText(action.name);
  if ('hash' in action) return shortHash(action.hash);
  if ('remote' in action && action.remote !== undefined) return sanitizeGitText(action.remote);
  return '?';
}

// ---------------------------------------------------------------------- github

export interface RateLimitBadge {
  /** Short text shown in the badge; never colour alone. */
  label: string;
  /** Longer tooltip / screen-reader text. */
  title: string;
  tone: 'info' | 'warning';
}

/**
 * Describe a rate-limit snapshot.
 *
 * Order matters: the breaker (`offline`) wins over exhaustion, exhaustion wins
 * over a plain remaining count, and `cached` is appended because it is
 * orthogonal — cached data can be served in any of those states.
 */
export function rateLimitBadge(
  rate: GitHubRateLimit | null,
  now: number = Date.now(),
  lang: Lang = 'en',
): RateLimitBadge {
  const strings = t(lang).format.rateLimit;
  if (rate === null) {
    return { label: strings.unknown, title: strings.unknownTitle, tone: 'info' };
  }
  const cached = rate.cached ? strings.cachedSuffix : '';
  if (rate.offline) {
    return {
      label: `${strings.offline}${cached}`,
      title: strings.offlineTitle,
      tone: 'warning',
    };
  }
  if (rate.remaining === 0) {
    const cd = countdown(rate.resetAt, now, lang);
    return {
      label: `${strings.exhausted(cd)}${cached}`,
      title: strings.exhaustedTitle(cd),
      tone: 'warning',
    };
  }
  if (rate.remaining === null) {
    return { label: `${strings.remainingUnknown}${cached}`, title: strings.remainingUnknownTitle, tone: 'info' };
  }
  const formattedCount = formatCount(rate.remaining, lang);
  const limit = rate.limit === null ? '' : strings.limitSuffix(formatCount(rate.limit, lang));
  return {
    label: `${strings.remaining(formattedCount)}${cached}`,
    title: strings.remainingTitle(formattedCount, limit),
    tone: 'info',
  };
}

/** `mm:ss` style countdown to a reset timestamp, clamped at zero. */
export function countdown(resetAt: number | null, now: number = Date.now(), lang: Lang = 'en'): string {
  const strings = t(lang).format.countdown;
  if (resetAt === null) return strings.aFewMoments;
  const seconds = Math.max(0, Math.ceil((resetAt - now) / 1000));
  if (seconds === 0) return strings.now;
  if (seconds < 60) return strings.seconds(seconds);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? strings.minutes(minutes) : strings.minutesSeconds(minutes, rest);
}

/** Chip text for a pull request: number, state word, and draft marker. */
export function pullRequestLabel(pr: PullRequestInfo, lang: Lang = 'en'): string {
  const strings = t(lang).format.prStates;
  const draft = pr.draft ? strings.draftSuffix : '';
  return `#${pr.number} ${strings[pr.state]}${draft}`;
}

export function pullRequestState(state: PullRequestInfo['state'], lang: Lang = 'en'): string {
  return t(lang).format.prStates[state];
}

/** Connection line for the GitHub panel. `login` is omitted when unknown. */
export function githubConnectionLabel(
  state: {
    connected: boolean;
    login: string | null;
    invalidToken?: boolean;
  },
  lang: Lang = 'en',
): string {
  const strings = t(lang).format.githubConnection;
  if (state.invalidToken === true) return strings.invalidToken;
  if (!state.connected) return strings.disconnected;
  // `login` comes from the GitHub API, so it is remote data like any other.
  const login = state.login === null ? '' : sanitizeGitText(state.login);
  return login.length === 0 ? strings.connected : strings.connectedAs(login);
}

/**
 * True when two linkages point at different GitHub repositories, which is when any
 * per-commit data cached for the previous one has to be dropped.
 */
export function linkageChangedRepo(
  before: { owner: string | null; repo: string | null } | null,
  after: { owner: string | null; repo: string | null } | null,
): boolean {
  if (before === null && after === null) return false;
  if (before === null || after === null) return true;
  return before.owner !== after.owner || before.repo !== after.repo;
}
