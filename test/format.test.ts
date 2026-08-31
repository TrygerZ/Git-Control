import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  absoluteTime,
  actionTarget,
  actionTitle,
  baseName,
  conflictLabel,
  consequenceOf,
  countdown,
  displayPath,
  entryStatus,
  formatCount,
  formatDateLabel,
  gitCommandOf,
  githubConnectionLabel,
  operationLabel,
  presentError,
  pullRequestLabel,
  rateLimitBadge,
  relativeTime,
  remedyLabel,
  riskLabel,
  SANITIZED_MARKER,
  sanitizeGitText,
  shortHash,
  statusLabel,
  truncate,
  linkageChangedRepo,
} from '../src/webview/format';
import type {
  ChangeEntry,
  ErrorCode,
  GitActionRequest,
  GitHubRateLimit,
  OperationState,
  PullRequestInfo,
  Remedy,
} from '../src/messages';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const HASH = 'abc1234def5678'.padEnd(40, '0');

/** Build an ISO timestamp `delta` ms before NOW. */
function ago(delta: number): string {
  return new Date(NOW - delta).toISOString();
}

test('shortHash takes seven characters by default', () => {
  assert.equal(shortHash(HASH), 'abc1234');
  assert.equal(shortHash(HASH, 10), 'abc1234def');
  assert.equal(shortHash('ab'), 'ab');
});

test('formatDateLabel formats timestamp into Indonesian date without em-dash', () => {
  const ts = new Date('2026-08-23T10:00:00.000Z').getTime();
  const label = formatDateLabel(ts);
  assert.match(label, /23 Agu 2026|24 Agu 2026/); // handles timezone
  assert.ok(!label.includes('—'));
});

test('formatDateLabel handles boundary values consistently (NaN, 0, negative, undefined, empty string)', () => {
  assert.equal(formatDateLabel(0), 'Tanggal tidak diketahui');
  assert.equal(formatDateLabel(-1000), 'Tanggal tidak diketahui');
  assert.equal(formatDateLabel(Number.NaN), 'Tanggal tidak diketahui');
  assert.equal(formatDateLabel(Number.POSITIVE_INFINITY), 'Tanggal tidak diketahui');
  assert.equal(formatDateLabel(undefined), 'Tanggal tidak diketahui');
  assert.equal(formatDateLabel(''), 'Tanggal tidak diketahui');
  assert.equal(formatDateLabel('invalid-date'), 'Tanggal tidak diketahui');
});

// ------------------------------------------------------- SEC-007 sanitisation

const M = SANITIZED_MARKER;

test('sanitizeGitText neutralises every bidi override, embedding, and isolate (SEC-007)', () => {
  // U+202A-U+202E: LRE, RLE, PDF, LRO, RLO. U+2066-U+2069: LRI, RLI, FSI, PDI.
  // U+200E/U+200F: LRM/RLM. U+061C: ALM.
  const bidi = [
    '\u202a',
    '\u202b',
    '\u202c',
    '\u202d',
    '\u202e',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
    '\u200e',
    '\u200f',
    '\u061c',
  ];
  for (const ch of bidi) {
    const code = ch.codePointAt(0)?.toString(16);
    assert.equal(sanitizeGitText(`a${ch}b`), `a${M}b`, `U+${code}`);
  }
  // The audit's concrete case: a subject crafted to render as something else.
  assert.equal(sanitizeGitText('Fix typo\u202ednuora'), `Fix typo${M}dnuora`);
  // And a branch name, which is what the guard dialog shows.
  assert.equal(sanitizeGitText('main\u202ednuora'), `main${M}dnuora`);
});

test('sanitizeGitText neutralises zero-width characters and the BOM (SEC-007)', () => {
  for (const ch of ['\u200b', '\u200c', '\ufeff']) {
    const code = ch.codePointAt(0)?.toString(16);
    assert.equal(sanitizeGitText(`a${ch}b`), `a${M}b`, `U+${code}`);
  }
  // Two refs that render identically without this: `main` and `ma<ZWSP>in`.
  assert.notEqual(sanitizeGitText('ma\u200bin'), 'main');
  assert.equal(sanitizeGitText('ma\u200bin'), `ma${M}in`);
});

test('sanitizeGitText marks a bare ZWJ but keeps emoji ZWJ sequences whole (SEC-007)', () => {
  // Between letters the joiner is just another invisible character.
  assert.equal(sanitizeGitText('main\u200dx'), `main${M}x`);
  assert.equal(sanitizeGitText('a\u200db'), `a${M}b`);
  // Between pictographs it IS the sequence, so it must survive verbatim.
  for (const emoji of ['👨\u200d💻', '👩\u200d🚀', '👨\u200d👩\u200d👧\u200d👦', '🏳\ufe0f\u200d🌈']) {
    assert.equal(sanitizeGitText(`fix: ${emoji} ok`), `fix: ${emoji} ok`, emoji);
  }
});

test('sanitizeGitText neutralises C0 and C1 controls but keeps tab and newline (SEC-007)', () => {
  // C0, excluding \t (U+0009), \n (U+000A), \r (U+000D).
  for (let code = 0x00; code <= 0x1f; code += 1) {
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    const ch = String.fromCharCode(code);
    assert.equal(sanitizeGitText(`a${ch}b`), `a${M}b`, `C0 U+${code.toString(16)}`);
  }
  // DEL plus the whole C1 block.
  for (let code = 0x7f; code <= 0x9f; code += 1) {
    const ch = String.fromCharCode(code);
    assert.equal(sanitizeGitText(`a${ch}b`), `a${M}b`, `C1 U+${code.toString(16)}`);
  }
  // A commit body is legitimately multi-line and is rendered in a `<pre>`.
  assert.equal(sanitizeGitText('baris satu\nbaris dua\r\n\tindentasi'), 'baris satu\nbaris dua\r\n\tindentasi');
});

test('sanitizeGitText leaves ordinary Indonesian and Unicode text untouched (SEC-007)', () => {
  const fine = [
    'Perbaiki panel Pending Changes',
    'Menambahkan fitur baru ke aplikasi',
    'café résumé naïve Ærøskøbing',
    'Añadir configuración',
    '修复图形渲染问题',
    'コミットメッセージ',
    '커밋 메시지',
    'إصلاح الخطأ',
    'תיקון באג',
    'Исправить ошибку',
    'ตรวจแก้ไข',
    'fix: emoji in a subject 🎉🚀👨‍👩‍👧‍👦',
    'feat(graph): lane colours — dashes, em dash, «quotes»',
    'path/with spaces/and-dashes_1.2.3.txt',
    'author <someone@example.com>',
  ];
  for (const value of fine) {
    assert.equal(sanitizeGitText(value), value, value);
  }
});

test('sanitizeGitText is idempotent and total (SEC-007)', () => {
  const nasty = `a\u202eb\u200bc\u0001d\u2066e`;
  const once = sanitizeGitText(nasty);
  assert.equal(sanitizeGitText(once), once, 'the marker itself is never replaced');
  assert.equal(sanitizeGitText(''), '');
  // Non-string input cannot crash a render path.
  assert.equal(sanitizeGitText(undefined as unknown as string), '');
  assert.equal(sanitizeGitText(null as unknown as string), '');
});

test('sanitizeGitText protects the guard dialog surfaces (SEC-007)', () => {
  // The command line the user reads before approving.
  assert.equal(
    gitCommandOf({ action: 'checkout-branch', branch: 'main\u202ednuora' }),
    `git switch main${M}dnuora`,
  );
  assert.equal(
    gitCommandOf({ action: 'merge', branch: 'fitur\u200bx' }),
    `git merge fitur${M}x`,
  );
  // The target line.
  assert.equal(actionTarget({ action: 'checkout-branch', branch: 'main\u202ex' }), `main${M}x`);
  assert.equal(
    actionTarget({ action: 'create-branch', name: 'a\u0007b', startPoint: HASH }),
    `a${M}b`,
  );
  // The consequence sentence and the dialog title.
  assert.ok(consequenceOf({ action: 'merge', branch: 'x\u202ey' }).includes(`x${M}y`));
  assert.ok(actionTitle({ action: 'checkout-branch', branch: 'x\u202ey' }).includes(`x${M}y`));
});

test('sanitizeGitText protects paths, conflict codes, and error details (SEC-007)', () => {
  assert.equal(baseName('dir/a\u202eb.txt'), `a${M}b.txt`);
  assert.equal(
    displayPath({
      path: 'new\u200b.txt',
      origPath: 'old\u202e.txt',
      indexStatus: 'R',
      worktreeStatus: ' ',
      staged: true,
      unstaged: false,
      untracked: false,
      additions: null,
      deletions: null,
      binary: false,
    }),
    `old${M}.txt → new${M}.txt`,
  );
  assert.ok(conflictLabel('U\u202eU').includes(M));
  // Hook output reaches `presentError` through `ErrorBody.message`.
  const view = presentError({
    status: 409,
    code: 'HOOK_REJECTED',
    message: 'pre-commit\u202edetcejer',
  });
  assert.ok(view.explanation.includes(M));
  assert.ok(!view.explanation.includes('\u202e'));
});

test('sanitizeGitText protects the GitHub login line (SEC-007)', () => {
  assert.equal(
    githubConnectionLabel({ connected: true, login: 'octo\u202ecat' }),
    `Tersambung sebagai octo${M}cat.`,
  );
});

/**
 * Source-level guard for the render sites the pure helpers cannot cover.
 *
 * `GraphCanvas.tsx`, `Inspector.tsx`, `GitHubPanel.tsx`, and the rest import
 * `./store`, which constructs the webview bridge at module scope and touches
 * `window` — so they cannot be imported under `node:test` without a DOM harness,
 * which this project does not have (see the audit's "what I could not verify").
 *
 * Rather than assert nothing, this pins the render sites textually: every JSX
 * interpolation of a known git- or GitHub-sourced field must pass through
 * `sanitizeGitText`. It fails if someone adds `{node.subject}` back, which is the
 * regression that matters.
 *
 * Two kinds of interpolation are deliberately exempt and are excluded by
 * construction rather than by an allowlist:
 *
 *  - `key=` and `value=`, plus a `key`/`id` object property. These are identity,
 *    not display. A React `key` is never rendered, and an `<option value>` is
 *    compared against lane refs, so it must stay byte-identical to what git said.
 *  - objects that are locally computed rather than host-supplied — `badge` from
 *    `rateLimitBadge` and `view` from `presentError` build their strings from the
 *    fixed Indonesian tables in this file, and `presentError` already sanitises
 *    the one host value it interpolates.
 */
test('every git-sourced field is sanitised at its render site (SEC-007)', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'webview');
  /** Fields whose value originates in git or in the GitHub API. */
  const risky = [
    'subject',
    'body',
    'authorName',
    'authorEmail',
    'committerName',
    'shortName',
    'refName',
    'title',
    'headRef',
    'baseRef',
    'author',
    'login',
    'scopeWarning',
    'origPath',
    'detail',
    'message',
  ].join('|');
  /** Objects built in this module from fixed tables, not from host data. */
  const localObjects = /^(?:badge|view|text|status|state)$/;
  const risky_ = new RegExp(
    String.raw`\{\s*([A-Za-z_$][\w$]*)[\w$?.]*\.(?:${risky})\b[^}]*\}`,
    'g',
  );
  const offenders: string[] = [];

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.tsx')) continue;
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim();
      // Comments explain the rule; they do not violate it.
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
      for (const match of line.matchAll(risky_)) {
        const whole = match[0];
        const root = match[1] ?? '';
        if (whole.includes('sanitizeGitText')) continue;
        if (localObjects.test(root)) continue;
        // Identity positions, never rendered as text.
        const before = line.slice(0, match.index ?? 0);
        if (/\b(?:key|value)=\s*$/.test(before)) continue;
        if (/\b(?:key|id):\s*$/.test(before)) continue;
        if (/`[^`]*$/.test(before) && /^\s*(?:key|id):/.test(trimmed)) continue;
        offenders.push(`${file}: ${trimmed}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `unsanitised git-sourced render sites:\n${offenders.join('\n')}`);
});

// ------------------------------------------------------------- relative time

test('relativeTime collapses the freshest window to "baru saja"', () => {
  assert.equal(relativeTime(ago(0), NOW), 'baru saja');
  assert.equal(relativeTime(ago(9_999), NOW), 'baru saja');
});

test('relativeTime crosses into seconds at ten seconds', () => {
  assert.equal(relativeTime(ago(10_000), NOW), '10 detik lalu');
  assert.equal(relativeTime(ago(59_999), NOW), '59 detik lalu');
});

test('relativeTime crosses into minutes at exactly one minute', () => {
  assert.equal(relativeTime(ago(60_000), NOW), '1 menit lalu');
  assert.equal(relativeTime(ago(59 * 60_000 + 59_000), NOW), '59 menit lalu');
});

test('relativeTime crosses into hours at exactly one hour', () => {
  assert.equal(relativeTime(ago(3_600_000), NOW), '1 jam lalu');
  assert.equal(relativeTime(ago(23 * 3_600_000), NOW), '23 jam lalu');
});

test('relativeTime crosses into days at exactly 24 hours', () => {
  assert.equal(relativeTime(ago(86_400_000), NOW), '1 hari lalu');
  assert.equal(relativeTime(ago(2 * 86_400_000), NOW), '2 hari lalu');
  assert.equal(relativeTime(ago(29 * 86_400_000), NOW), '29 hari lalu');
});

test('relativeTime crosses into months at thirty days', () => {
  assert.equal(relativeTime(ago(30 * 86_400_000), NOW), '1 bulan lalu');
  assert.equal(relativeTime(ago(364 * 86_400_000), NOW), '12 bulan lalu');
});

test('relativeTime crosses into years at 365 days', () => {
  assert.equal(relativeTime(ago(365 * 86_400_000), NOW), '1 tahun lalu');
  assert.equal(relativeTime(ago(3 * 365 * 86_400_000), NOW), '3 tahun lalu');
});

test('relativeTime clamps a future timestamp instead of going negative', () => {
  assert.equal(relativeTime(new Date(NOW + 60_000).toISOString(), NOW), 'baru saja');
});

test('relativeTime reports unknown for an unparsable value', () => {
  assert.equal(relativeTime('not a date', NOW), 'waktu tidak diketahui');
  assert.equal(absoluteTime('not a date'), 'waktu tidak diketahui');
});

test('absoluteTime renders a zero-padded local timestamp', () => {
  const rendered = absoluteTime('2026-01-05T08:07:00.000Z');
  assert.match(rendered, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
});

// ----------------------------------------------------------------- statuses

test('statusLabel maps every porcelain letter to Indonesian', () => {
  assert.deepEqual(statusLabel('M'), { code: 'M', label: 'Dimodifikasi', icon: 'diff-modified' });
  assert.deepEqual(statusLabel('A'), { code: 'A', label: 'Ditambahkan', icon: 'diff-added' });
  assert.deepEqual(statusLabel('D'), { code: 'D', label: 'Dihapus', icon: 'diff-removed' });
  assert.deepEqual(statusLabel('R'), { code: 'R', label: 'Diganti nama', icon: 'diff-renamed' });
  assert.deepEqual(statusLabel('C'), { code: 'C', label: 'Disalin', icon: 'copy' });
  assert.deepEqual(statusLabel('T'), { code: 'T', label: 'Tipe berubah', icon: 'file-symlink-file' });
  assert.deepEqual(statusLabel('U'), { code: 'U', label: 'Konflik', icon: 'warning' });
  assert.deepEqual(statusLabel('?'), { code: '?', label: 'Belum dilacak', icon: 'question' });
  assert.deepEqual(statusLabel('!'), { code: '!', label: 'Diabaikan', icon: 'diff-ignored' });
});

test('statusLabel treats blank as unchanged and unknown letters as unknown', () => {
  assert.deepEqual(statusLabel(' '), { code: ' ', label: 'Tidak berubah', icon: 'dash' });
  assert.deepEqual(statusLabel('Z'), { code: '·', label: 'Tidak diketahui', icon: 'question' });
});

test('every STATUS_LABELS entry and statusLabel result has an icon existing in vendored codicon.css', () => {
  const cssPath = path.join(__dirname, '..', '..', 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  const codiconClassRegex = /\.codicon-([\w-]+):before/g;
  const availableIcons = new Set<string>();
  for (const match of css.matchAll(codiconClassRegex)) {
    if (match[1]) availableIcons.add(match[1]);
  }

  const porcelainList = ['M', 'A', 'D', 'R', 'C', 'T', 'U', '?', '!', ' ', 'Z'];
  for (const code of porcelainList) {
    const res = statusLabel(code);
    assert.ok(res.icon !== undefined && res.icon.length > 0, `code ${code} must have non-empty icon`);
    assert.ok(
      availableIcons.has(res.icon),
      `icon "${res.icon}" for code "${code}" must exist in vendored codicon.css`,
    );
  }
});

test('entryStatus prefers the index letter but reports untracked first', () => {
  const base: ChangeEntry = {
    path: 'a.ts',
    indexStatus: ' ',
    worktreeStatus: 'M',
    staged: false,
    unstaged: true,
    untracked: false,
    additions: 0,
    deletions: 0,
    binary: false,
  };
  assert.equal(entryStatus(base).code, 'M');
  assert.equal(entryStatus({ ...base, indexStatus: 'A' }).code, 'A');
  assert.equal(entryStatus({ ...base, untracked: true }).code, '?');
});

test('displayPath renders renames as lama → baru', () => {
  const renamed: ChangeEntry = {
    path: 'src/new.ts',
    origPath: 'src/old.ts',
    indexStatus: 'R',
    worktreeStatus: ' ',
    staged: true,
    unstaged: false,
    untracked: false,
    additions: 0,
    deletions: 0,
    binary: false,
  };
  assert.equal(displayPath(renamed), 'src/old.ts → src/new.ts');
  assert.equal(displayPath({ ...renamed, origPath: undefined }), 'src/new.ts');
});

test('baseName returns the trailing segment', () => {
  assert.equal(baseName('a/b/c.ts'), 'c.ts');
  assert.equal(baseName('c.ts'), 'c.ts');
});

// ---------------------------------------------------------------- conflicts

test('conflictLabel explains every git conflict code', () => {
  assert.equal(conflictLabel('UU'), 'UU: keduanya mengubah');
  assert.equal(conflictLabel('DU'), 'DU: dihapus di sini, diubah di sana');
  assert.equal(conflictLabel('UD'), 'UD: diubah di sini, dihapus di sana');
  assert.equal(conflictLabel('AA'), 'AA: ditambahkan di kedua sisi');
  assert.equal(conflictLabel('DD'), 'DD: dihapus di kedua sisi');
  assert.equal(conflictLabel('AU'), 'AU: ditambahkan di sini, diubah di sana');
  assert.equal(conflictLabel('UA'), 'UA: diubah di sini, ditambahkan di sana');
  assert.equal(conflictLabel('xx'), 'XX: konflik tidak dikenal');
});

test('operationLabel names every operation state in Indonesian', () => {
  const states: OperationState[] = ['idle', 'merge', 'rebase', 'cherry-pick', 'revert', 'bisect'];
  for (const state of states) {
    assert.ok(operationLabel(state).length > 0, state);
  }
  assert.equal(operationLabel('merge'), 'Merge sedang berjalan');
});

// ------------------------------------------------------------------- errors

const ALL_CODES: ErrorCode[] = [
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
];

test('presentError covers every ErrorCode with a distinct title', () => {
  const titles = new Set<string>();
  for (const code of ALL_CODES) {
    const view = presentError({ status: 500, code, message: '' });
    assert.ok(view.title.length > 0, code);
    assert.ok(view.explanation.length > 0, code);
    titles.add(view.title);
  }
  assert.equal(titles.size, ALL_CODES.length);
});

test('presentError always offers a way out', () => {
  for (const code of ALL_CODES) {
    const view = presentError({ status: 500, code, message: 'x' });
    assert.ok(view.remedies.length > 0, code);
  }
});

test('presentError keeps host remedies when supplied', () => {
  const view = presentError({
    status: 412,
    code: 'DIRTY_TREE',
    message: 'Commit atau stash perubahan sebelum checkout.',
    remedies: ['commit', 'stash', 'cancel'],
  });
  assert.deepEqual(view.remedies, ['commit', 'stash', 'cancel']);
  assert.match(view.explanation, /Commit atau stash/);
});

test('presentError requests logs only for server and hook failures', () => {
  assert.equal(presentError({ status: 500, code: 'SERVER_ERROR', message: '' }).showLogs, true);
  assert.equal(presentError({ status: 409, code: 'HOOK_REJECTED', message: '' }).showLogs, true);
  assert.equal(presentError({ status: 412, code: 'DIRTY_TREE', message: '' }).showLogs, false);
});

test('presentError never suggests force push for REMOTE_AHEAD', () => {
  const view = presentError({
    status: 409,
    code: 'REMOTE_AHEAD',
    message: 'Remote memiliki histori berbeda.',
    remedies: ['fetch'],
  });
  assert.deepEqual(view.remedies, ['fetch']);
  assert.match(view.explanation, /Fetch dulu/);
});

test('remedyLabel names every remedy', () => {
  const remedies: Remedy[] = ['commit', 'stash', 'fetch', 'cancel', 'resolve-conflicts', 'confirm'];
  assert.deepEqual(
    remedies.map(remedyLabel),
    ['Commit', 'Stash', 'Fetch', 'Batal', 'Selesaikan konflik', 'Konfirmasi'],
  );
});

test('riskLabel spells risk in words, not colour', () => {
  assert.equal(riskLabel('low'), 'risiko rendah');
  assert.equal(riskLabel('medium'), 'berisiko');
  assert.equal(riskLabel('high'), 'sangat berisiko');
});

// -------------------------------------------------------------- git actions

const ACTIONS: GitActionRequest[] = [
  { action: 'checkout-branch', branch: 'main' },
  { action: 'checkout-commit', hash: HASH },
  { action: 'create-branch', name: 'fitur', startPoint: HASH },
  { action: 'merge', branch: 'fitur' },
  { action: 'revert', hash: HASH },
  { action: 'reset-soft', hash: HASH },
  { action: 'reset-hard', hash: HASH },
  { action: 'push', remote: 'origin', branch: 'main' },
  { action: 'push-up-to', remote: 'origin', branch: 'main', hash: HASH },
  { action: 'fetch', prune: true },
  { action: 'stash', message: 'wip' },
  { action: 'stash-pop' },
  { action: 'merge-continue' },
  { action: 'merge-abort' },
];

test('gitCommandOf renders a runnable command for every action', () => {
  for (const action of ACTIONS) {
    assert.match(gitCommandOf(action), /^git /, action.action);
  }
  assert.equal(gitCommandOf({ action: 'reset-hard', hash: HASH }), 'git reset --hard abc1234');
  assert.equal(
    gitCommandOf({ action: 'push', remote: 'origin', branch: 'main', setUpstream: true }),
    'git push -u origin main:main',
  );
});

test('gitCommandOf never emits a force flag', () => {
  for (const action of ACTIONS) {
    const command = gitCommandOf(action);
    assert.ok(!command.includes('--force'), command);
    assert.ok(!/\s-f\b/.test(command), command);
  }
});

test('consequenceOf and actionTitle describe every action in Indonesian', () => {
  for (const action of ACTIONS) {
    assert.ok(consequenceOf(action).length > 10, action.action);
    assert.ok(actionTitle(action).length > 0, action.action);
  }
  assert.match(consequenceOf({ action: 'reset-hard', hash: HASH }), /Tidak bisa dibatalkan/);
});

test('actionTarget picks the branch, name, hash, or remote', () => {
  assert.equal(actionTarget({ action: 'checkout-branch', branch: 'main' }), 'main');
  assert.equal(actionTarget({ action: 'create-branch', name: 'fitur', startPoint: HASH }), 'fitur');
  assert.equal(actionTarget({ action: 'revert', hash: HASH }), 'abc1234');
  assert.equal(actionTarget({ action: 'fetch', remote: 'origin' }), 'origin');
  assert.equal(actionTarget({ action: 'stash-pop' }), '?');
});

// ------------------------------------------------------------------ numbers

test('formatCount groups thousands the Indonesian way', () => {
  assert.equal(formatCount(10_000), '10.000');
  assert.equal(formatCount(7), '7');
});

test('truncate appends an ellipsis only when needed', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
});

// ------------------------------------------------------------------- github

function rate(patch: Partial<GitHubRateLimit> = {}): GitHubRateLimit {
  return { limit: 5000, remaining: 4987, resetAt: null, cached: false, offline: false, ...patch };
}

test('rateLimitBadge reports the remaining quota in Indonesian', () => {
  const badge = rateLimitBadge(rate());
  assert.equal(badge.label, 'Sisa 4.987 permintaan');
  assert.equal(badge.tone, 'info');
  assert.match(badge.title, /dari 5\.000/);
});

test('rateLimitBadge shows a countdown once the quota is spent', () => {
  const now = 1_700_000_000_000;
  const badge = rateLimitBadge(rate({ remaining: 0, resetAt: now + 125_000 }), now);
  assert.equal(badge.tone, 'warning');
  assert.match(badge.label, /^Habis · 2 menit 5 detik/);
});

test('rateLimitBadge marks cached and offline states with words, not colour', () => {
  assert.match(rateLimitBadge(rate({ cached: true })).label, /cached$/);
  const offline = rateLimitBadge(rate({ offline: true, cached: true }));
  assert.equal(offline.label, 'offline · cached');
  assert.equal(offline.tone, 'warning');
  // Offline wins over exhaustion, because no request is being made at all.
  assert.equal(rateLimitBadge(rate({ offline: true, remaining: 0 })).label, 'offline');
});

test('rateLimitBadge degrades when nothing is known yet', () => {
  assert.equal(rateLimitBadge(null).label, 'Tidak diketahui');
  assert.equal(rateLimitBadge(rate({ remaining: null })).label, 'Tidak diketahui');
});

test('countdown clamps, rounds, and falls back', () => {
  const now = 1_700_000_000_000;
  assert.equal(countdown(null, now), 'beberapa saat');
  assert.equal(countdown(now - 5000, now), 'sekarang');
  assert.equal(countdown(now + 30_000, now), '30 detik');
  assert.equal(countdown(now + 120_000, now), '2 menit');
  assert.equal(countdown(now + 90_000, now), '1 menit 30 detik');
});

test('pullRequestLabel states the number, state word, and draft marker', () => {
  const base: PullRequestInfo = {
    number: 12,
    title: 'Tambah panel',
    state: 'open',
    url: 'https://github.com/o/r/pull/12',
    headRef: 'fitur/panel',
    baseRef: 'main',
    draft: false,
    author: 'octocat',
    updatedAt: '2026-06-15T10:00:00.000Z',
  };
  assert.equal(pullRequestLabel(base), '#12 Terbuka');
  assert.equal(pullRequestLabel({ ...base, draft: true }), '#12 Terbuka · draft');
  assert.equal(pullRequestLabel({ ...base, state: 'merged' }), '#12 Digabung');
  assert.equal(pullRequestLabel({ ...base, state: 'closed' }), '#12 Ditutup');
});

test('githubConnectionLabel covers connected, anonymous, and invalid-token', () => {
  assert.equal(githubConnectionLabel({ connected: false, login: null }), 'Belum tersambung.');
  assert.equal(githubConnectionLabel({ connected: true, login: 'octocat' }), 'Tersambung sebagai octocat.');
  assert.equal(githubConnectionLabel({ connected: true, login: null }), 'Tersambung.');
  assert.equal(
    githubConnectionLabel({ connected: false, login: null, invalidToken: true }),
    'Token GitHub tidak valid.',
  );
});

// -------------------------------------------------------- ChangeTree ARIA grid invariants

test('ChangeTree file row gridcells have valid ARIA semantics and no contradictory aria-hidden', () => {
  // Read ChangeTree source directly to verify static JSX treegrid structure invariants
  const changeTreePath = path.join(__dirname, '..', '..', 'src', 'webview', 'ChangeTree.tsx');
  const source = fs.readFileSync(changeTreePath, 'utf8');

  // 1. No element with role="gridcell" has aria-hidden="true" or aria-hidden={...}
  const gridcellRegex = /<[^>]*role=["']gridcell["'][^>]*>/g;
  const gridcells = source.match(gridcellRegex) ?? [];
  assert.ok(gridcells.length > 0, 'must have gridcell definitions');
  for (const cell of gridcells) {
    assert.ok(
      !cell.includes('aria-hidden'),
      `gridcell element must not have aria-hidden: ${cell}`,
    );
  }

  // 2. Treegrid declares aria-colcount={5}
  assert.match(source, /role=["']treegrid["'][^>]*aria-colcount=\{5\}/);

  // 3. FileRow function body declares contiguous, ordered, unique aria-colindex sequence 2, 3, 4, 5 (col 1 is in parent row checkbox)
  const fileRowStartIndex = source.indexOf('function FileRow(');
  assert.ok(fileRowStartIndex !== -1, 'FileRow function must exist');
  const fileRowEndIndex = source.indexOf('function TriCheckbox(', fileRowStartIndex);
  assert.ok(fileRowEndIndex !== -1, 'TriCheckbox function must exist after FileRow');
  const fileRowBody = source.slice(fileRowStartIndex, fileRowEndIndex);

  const colindexRegex = /aria-colindex=\{([0-9]+)\}/g;
  const colindices = Array.from(fileRowBody.matchAll(colindexRegex)).map((m) => parseInt(m[1] as string, 10));

  // FileRow contains col 2 (status), col 3 (file), col 4 (stats/binary), and optionally col 5 (action)
  // Check that every index is in range [2, 5] and strictly increasing
  assert.deepEqual(
    colindices,
    [2, 3, 4, 4, 4, 5], // 4 appears in ternary branches for binary / churnUnknown / normal stats
    'FileRow gridcells must declare contiguous colindex sequence 2 -> 3 -> 4 -> 5',
  );

  // In each branch of FileRow, the active sequence is [2, 3, 4] or [2, 3, 4, 5]
  const uniqueIndices = Array.from(new Set(colindices));
  assert.deepEqual(uniqueIndices, [2, 3, 4, 5], 'FileRow must cover columns 2, 3, 4, 5');

  // Check row item checkbox has colindex 1
  const rowCheckboxMatch = source.match(/role="gridcell"\s+aria-colindex=\{1\}/);
  assert.ok(rowCheckboxMatch !== null, 'Row must declare gridcell with aria-colindex={1} for checkbox');
});

// ---------------------------------------------------------------- linkageChangedRepo

test('linkageChangedRepo returns false when both are null or pointing to same owner and repo', () => {
  assert.equal(linkageChangedRepo(null, null), false);
  assert.equal(
    linkageChangedRepo({ owner: 'alice', repo: 'project' }, { owner: 'alice', repo: 'project' }),
    false,
  );
  assert.equal(linkageChangedRepo({ owner: null, repo: null }, { owner: null, repo: null }), false);
});

test('linkageChangedRepo returns true when comparing null against non-null', () => {
  assert.equal(linkageChangedRepo(null, { owner: 'alice', repo: 'project' }), true);
  assert.equal(linkageChangedRepo({ owner: 'alice', repo: 'project' }, null), true);
});

test('linkageChangedRepo returns true when owner or repo differs', () => {
  assert.equal(
    linkageChangedRepo({ owner: 'alice', repo: 'project' }, { owner: 'bob', repo: 'project' }),
    true,
  );
  assert.equal(
    linkageChangedRepo({ owner: 'alice', repo: 'project' }, { owner: 'alice', repo: 'other' }),
    true,
  );
  assert.equal(
    linkageChangedRepo({ owner: 'alice', repo: 'project' }, { owner: 'bob', repo: 'other' }),
    true,
  );
  assert.equal(
    linkageChangedRepo({ owner: 'alice', repo: null }, { owner: 'alice', repo: 'project' }),
    true,
  );
});
