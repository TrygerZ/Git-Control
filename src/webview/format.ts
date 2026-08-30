/**
 * Pure presentation helpers. No DOM, no React, no bridge — so every rule below
 * is unit-testable under `node:test`.
 *
 * Every user-facing string lives here or in the component that owns it, and all
 * of them are Indonesian.
 */
import type {
  ChangeEntry,
  ErrorBody,
  ErrorCode,
  GitActionRequest,
  GitHubRateLimit,
  OperationState,
  PullRequestInfo,
  Remedy,
} from '../messages';

// --------------------------------------------------------------------- hashes

const SHORT_HASH_LENGTH = 7;

/** First 7 characters of a hash, or the whole thing when it is shorter. */
export function shortHash(hash: string, length: number = SHORT_HASH_LENGTH): string {
  return hash.slice(0, Math.max(1, length));
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

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Calendar-free approximations: good enough for "2 bulan lalu". */
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
/** Anything fresher than this reads as "baru saja". */
const JUST_NOW_MS = 10 * SECOND_MS;

/**
 * Indonesian relative time. Boundaries are inclusive at the lower unit, so
 * exactly 60 s reads `1 menit lalu` and exactly 24 h reads `1 hari lalu`.
 * A timestamp in the future is clamped to `baru saja` rather than going negative.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'waktu tidak diketahui';
  const delta = now - at;
  if (delta < JUST_NOW_MS) return 'baru saja';
  if (delta < MINUTE_MS) return `${Math.floor(delta / SECOND_MS)} detik lalu`;
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)} menit lalu`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)} jam lalu`;
  if (delta < MONTH_MS) return `${Math.floor(delta / DAY_MS)} hari lalu`;
  if (delta < YEAR_MS) return `${Math.floor(delta / MONTH_MS)} bulan lalu`;
  return `${Math.floor(delta / YEAR_MS)} tahun lalu`;
}

/** Absolute timestamp, `id-ID` locale, stable enough to read in a tooltip. */
export function absoluteTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'waktu tidak diketahui';
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
  /** Indonesian word, so status never depends on colour alone. */
  label: string;
  /** Text glyph; no icon font is permitted under the CSP. */
  glyph: string;
}

const STATUS_LABELS: Readonly<Record<string, StatusLabel>> = {
  M: { code: 'M', label: 'Dimodifikasi', glyph: '±' },
  A: { code: 'A', label: 'Ditambahkan', glyph: '+' },
  D: { code: 'D', label: 'Dihapus', glyph: '−' },
  R: { code: 'R', label: 'Diganti nama', glyph: '→' },
  C: { code: 'C', label: 'Disalin', glyph: '⧉' },
  T: { code: 'T', label: 'Tipe berubah', glyph: '⇄' },
  U: { code: 'U', label: 'Konflik', glyph: '!' },
  '?': { code: '?', label: 'Belum dilacak', glyph: '?' },
  '!': { code: '!', label: 'Diabaikan', glyph: '·' },
};

const UNKNOWN_STATUS: StatusLabel = { code: '·', label: 'Tidak diketahui', glyph: '·' };

/** Map a porcelain letter onto its Indonesian label. Space means "tidak berubah". */
export function statusLabel(code: string): StatusLabel {
  const key = code.trim().charAt(0).toUpperCase();
  if (key.length === 0) return { code: ' ', label: 'Tidak berubah', glyph: '=' };
  return STATUS_LABELS[key] ?? STATUS_LABELS[code.trim().charAt(0)] ?? UNKNOWN_STATUS;
}

/** The letter that best describes an entry, preferring the index over the tree. */
export function entryStatus(entry: ChangeEntry): StatusLabel {
  if (entry.untracked) return statusLabel('?');
  const code = entry.indexStatus.trim().length > 0 ? entry.indexStatus : entry.worktreeStatus;
  return statusLabel(code);
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

// ------------------------------------------------------------------ conflicts

const CONFLICT_CODES: Readonly<Record<string, string>> = {
  DD: 'DD — dihapus di kedua sisi',
  AU: 'AU — ditambahkan di sini, diubah di sana',
  UD: 'UD — diubah di sini, dihapus di sana',
  UA: 'UA — diubah di sini, ditambahkan di sana',
  DU: 'DU — dihapus di sini, diubah di sana',
  AA: 'AA — ditambahkan di kedua sisi',
  UU: 'UU — keduanya mengubah',
};

/** Explain a two-letter conflict code in Indonesian. */
export function conflictLabel(code: string): string {
  const key = sanitizeGitText(code).trim().toUpperCase();
  return CONFLICT_CODES[key] ?? `${key} — konflik tidak dikenal`;
}

// ----------------------------------------------------------------- operations

const OPERATION_LABELS: Readonly<Record<OperationState, string>> = {
  idle: 'Tidak ada operasi',
  merge: 'Merge sedang berjalan',
  rebase: 'Rebase sedang berjalan',
  'cherry-pick': 'Cherry-pick sedang berjalan',
  revert: 'Revert sedang berjalan',
  bisect: 'Bisect sedang berjalan',
};

export function operationLabel(operation: OperationState): string {
  return OPERATION_LABELS[operation];
}

// --------------------------------------------------------------------- errors

const REMEDY_LABELS: Readonly<Record<Remedy, string>> = {
  commit: 'Commit',
  stash: 'Stash',
  fetch: 'Fetch',
  cancel: 'Batal',
  'resolve-conflicts': 'Selesaikan konflik',
  confirm: 'Konfirmasi',
};

export function remedyLabel(remedy: Remedy): string {
  return REMEDY_LABELS[remedy];
}

export interface ErrorPresentation {
  /** Short headline for the banner or dialog title. */
  title: string;
  /** Plain-Indonesian explanation of what happened and why. */
  explanation: string;
  /** Buttons to offer, always ending in a way out. */
  remedies: Remedy[];
  /** `true` when the Output channel is the next useful step. */
  showLogs: boolean;
}

const ERROR_TEXT: Readonly<Record<ErrorCode, { title: string; explanation: string }>> = {
  VALIDATION_ERROR: {
    title: 'Permintaan tidak valid',
    explanation: 'Data yang dikirim tidak sesuai aturan. Muat ulang lalu coba lagi.',
  },
  AUTH_ERROR: {
    title: 'Autentikasi gagal',
    explanation: 'Kredensial tidak diterima. Sambungkan ulang akun GitHub Anda.',
  },
  FORBIDDEN: {
    title: 'Akses ditolak',
    explanation: 'Anda tidak punya izin untuk tindakan ini pada repository tersebut.',
  },
  NOT_FOUND: {
    title: 'Tidak ditemukan',
    explanation: 'Repository, commit, atau branch yang diminta tidak ada.',
  },
  CONFLICT: {
    title: 'Bentrok status',
    explanation: 'Repository berubah atau ada operasi lain yang belum selesai. Muat ulang dulu.',
  },
  RATE_LIMITED: {
    title: 'Terlalu banyak permintaan',
    explanation: 'Batas permintaan tercapai. Tunggu sebentar lalu coba lagi.',
  },
  SERVER_ERROR: {
    title: 'Terjadi kesalahan',
    explanation: 'Git gagal dijalankan. Lihat log untuk keluaran lengkapnya.',
  },
  UNAVAILABLE: {
    title: 'Layanan tidak tersedia',
    explanation: 'Fitur ini belum tersedia atau git tidak merespons.',
  },
  REPOSITORY_LOCKED: {
    title: 'Repository terkunci',
    explanation: 'Ada proses git lain yang sedang berjalan. Tunggu hingga selesai.',
  },
  DIRTY_TREE: {
    title: 'Ada perubahan belum disimpan',
    explanation: 'Commit atau stash perubahan Anda dulu supaya tidak ada yang hilang.',
  },
  REMOTE_AHEAD: {
    title: 'Remote lebih baru',
    explanation: 'Remote punya commit yang belum Anda miliki. Fetch dulu, jangan force push.',
  },
  STALE_STATUS: {
    title: 'Status remote kedaluwarsa',
    explanation: 'Data remote sudah lama. Fetch dulu agar keputusan dibuat atas data terbaru.',
  },
  NON_FAST_FORWARD: {
    title: 'Push bukan fast-forward',
    explanation: 'Push akan menimpa histori remote. Fetch dan integrasikan dulu.',
  },
  HOOK_REJECTED: {
    title: 'Ditolak git hook',
    explanation: 'Sebuah git hook menolak operasi ini. Pesan hook ada di detail.',
  },
  CONFIRMATION_REQUIRED: {
    title: 'Perlu konfirmasi',
    explanation: 'Tindakan ini berisiko mengubah histori atau membuang perubahan.',
  },
};

/** Turn an {@link ErrorBody} into everything the UI needs to render it. */
export function presentError(error: ErrorBody): ErrorPresentation {
  const text = ERROR_TEXT[error.code] ?? ERROR_TEXT.SERVER_ERROR;
  const remedies = error.remedies !== undefined && error.remedies.length > 0 ? error.remedies : ['cancel'];
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

const RISK_LABELS: Readonly<Record<'low' | 'medium' | 'high', string>> = {
  low: 'risiko rendah',
  medium: 'berisiko',
  high: 'sangat berisiko',
};

export function riskLabel(risk: 'low' | 'medium' | 'high'): string {
  return RISK_LABELS[risk];
}

// ------------------------------------------------------------------- numbers

/** `1.234` style grouping for counters shown in banners. */
export function formatCount(value: number): string {
  return value.toLocaleString('id-ID');
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
      return `git branch ${s(action.name)} ${shortHash(action.startPoint)}`;
    case 'merge':
      return `git merge ${action.noFf === true ? '--no-ff ' : ''}${s(action.branch)}`;
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

/** Plain-Indonesian consequence of an action, shown above the command. */
export function consequenceOf(action: GitActionRequest): string {
  const s = sanitizeGitText;
  switch (action.action) {
    case 'checkout-branch':
      return `Pindah ke branch ${s(action.branch)}. File di folder kerja akan mengikuti branch itu.`;
    case 'checkout-commit':
      return 'Masuk ke mode detached HEAD. Commit baru tidak menempel pada branch mana pun.';
    case 'create-branch':
      return `Membuat branch ${s(action.name)} pada commit ${shortHash(action.startPoint)} tanpa berpindah.`;
    case 'merge':
      return `Menggabungkan ${s(action.branch)} ke branch aktif. Bisa memunculkan konflik.`;
    case 'revert':
      return 'Membuat commit baru yang membatalkan perubahan commit tersebut. Histori tetap utuh.';
    case 'reset-soft':
      return 'Memindahkan branch ke commit tersebut. Perubahan tetap ada di staging area.';
    case 'reset-hard':
      return 'Memindahkan branch DAN membuang semua perubahan setelah commit tersebut. Tidak bisa dibatalkan.';
    case 'push':
      return `Mengirim branch ${s(action.branch)} ke ${s(action.remote)}.`;
    case 'push-up-to':
      return `Mengirim histori sampai ${shortHash(action.hash)} ke ${s(action.remote)}/${s(action.branch)}.`;
    case 'fetch':
      return 'Mengambil data terbaru dari remote. Folder kerja tidak diubah.';
    case 'stash':
      return 'Menyimpan perubahan ke stash dan membersihkan folder kerja.';
    case 'stash-pop':
      return 'Mengembalikan perubahan dari stash terakhir.';
    case 'merge-continue':
      return 'Melanjutkan merge setelah semua konflik selesai.';
    case 'merge-abort':
      return 'Membatalkan merge dan kembali ke keadaan sebelum merge.';
    default:
      return 'Menjalankan perintah git.';
  }
}

/** Short menu/dialog title for an action. */
export function actionTitle(action: GitActionRequest): string {
  const s = sanitizeGitText;
  switch (action.action) {
    case 'checkout-branch':
      return `Checkout branch ${s(action.branch)}`;
    case 'checkout-commit':
      return `Checkout commit ${shortHash(action.hash)}`;
    case 'create-branch':
      return `Buat branch ${s(action.name)}`;
    case 'merge':
      return `Merge ${s(action.branch)} ke branch aktif`;
    case 'revert':
      return `Revert ${shortHash(action.hash)}`;
    case 'reset-soft':
      return `Reset soft ke ${shortHash(action.hash)}`;
    case 'reset-hard':
      return `Reset hard ke ${shortHash(action.hash)}`;
    case 'push':
      return `Push ${s(action.branch)}`;
    case 'push-up-to':
      return `Push sampai ${shortHash(action.hash)}`;
    case 'fetch':
      return 'Fetch';
    case 'stash':
      return 'Stash perubahan';
    case 'stash-pop':
      return 'Stash pop';
    case 'merge-continue':
      return 'Lanjutkan merge';
    case 'merge-abort':
      return 'Batalkan merge';
    default:
      return 'Tindakan git';
  }
}

/** Target the action operates on, shown as the dialog's subject line. Sanitised. */
export function actionTarget(action: GitActionRequest): string {
  if ('branch' in action && typeof action.branch === 'string') return sanitizeGitText(action.branch);
  if ('name' in action) return sanitizeGitText(action.name);
  if ('hash' in action) return shortHash(action.hash);
  if ('remote' in action && action.remote !== undefined) return sanitizeGitText(action.remote);
  return '—';
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
 * Describe a rate-limit snapshot in Indonesian.
 *
 * Order matters: the breaker (`offline`) wins over exhaustion, exhaustion wins
 * over a plain remaining count, and `cached` is appended because it is
 * orthogonal — cached data can be served in any of those states.
 */
export function rateLimitBadge(
  rate: GitHubRateLimit | null,
  now: number = Date.now(),
): RateLimitBadge {
  if (rate === null) {
    return { label: 'Tidak diketahui', title: 'Status batas permintaan belum diketahui.', tone: 'info' };
  }
  const cached = rate.cached ? ' · cached' : '';
  if (rate.offline) {
    return {
      label: `offline${cached}`,
      title: 'GitHub tidak dapat dijangkau. Data dari cache bila tersedia.',
      tone: 'warning',
    };
  }
  if (rate.remaining === 0) {
    return {
      label: `Habis · ${countdown(rate.resetAt, now)}${cached}`,
      title: `Batas permintaan tercapai. Coba lagi dalam ${countdown(rate.resetAt, now)}.`,
      tone: 'warning',
    };
  }
  if (rate.remaining === null) {
    return { label: `Tidak diketahui${cached}`, title: 'Sisa permintaan belum diketahui.', tone: 'info' };
  }
  const limit = rate.limit === null ? '' : ` dari ${formatCount(rate.limit)}`;
  return {
    label: `Sisa ${formatCount(rate.remaining)} permintaan${cached}`,
    title: `Sisa ${formatCount(rate.remaining)}${limit} permintaan pada jendela saat ini.`,
    tone: 'info',
  };
}

/** `mm:ss` style countdown to a reset timestamp, clamped at zero. */
export function countdown(resetAt: number | null, now: number = Date.now()): string {
  if (resetAt === null) return 'beberapa saat';
  const seconds = Math.max(0, Math.ceil((resetAt - now) / 1000));
  if (seconds === 0) return 'sekarang';
  if (seconds < 60) return `${seconds} detik`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} menit` : `${minutes} menit ${rest} detik`;
}

const PR_STATE_LABELS: Readonly<Record<PullRequestInfo['state'], string>> = {
  open: 'Terbuka',
  closed: 'Ditutup',
  merged: 'Digabung',
};

/** Chip text for a pull request: number, state word, and draft marker. */
export function pullRequestLabel(pr: PullRequestInfo): string {
  const draft = pr.draft ? ' · draft' : '';
  return `#${pr.number} ${PR_STATE_LABELS[pr.state]}${draft}`;
}

export function pullRequestState(state: PullRequestInfo['state']): string {
  return PR_STATE_LABELS[state];
}

/** Connection line for the GitHub panel. `login` is omitted when unknown. */
export function githubConnectionLabel(state: {
  connected: boolean;
  login: string | null;
  invalidToken?: boolean;
}): string {
  if (state.invalidToken === true) return 'Token GitHub tidak valid.';
  if (!state.connected) return 'Belum tersambung.';
  // `login` comes from the GitHub API, so it is remote data like any other.
  const login = state.login === null ? '' : sanitizeGitText(state.login);
  return login.length === 0 ? 'Tersambung.' : `Tersambung sebagai ${login}.`;
}

