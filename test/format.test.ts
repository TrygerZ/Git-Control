import test from 'node:test';
import assert from 'node:assert/strict';
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
  gitCommandOf,
  githubConnectionLabel,
  operationLabel,
  presentError,
  pullRequestLabel,
  rateLimitBadge,
  relativeTime,
  remedyLabel,
  riskLabel,
  shortHash,
  statusLabel,
  truncate,
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
  assert.deepEqual(statusLabel('M'), { code: 'M', label: 'Dimodifikasi', glyph: '±' });
  assert.equal(statusLabel('A').label, 'Ditambahkan');
  assert.equal(statusLabel('D').label, 'Dihapus');
  assert.equal(statusLabel('R').label, 'Diganti nama');
  assert.equal(statusLabel('C').label, 'Disalin');
  assert.equal(statusLabel('T').label, 'Tipe berubah');
  assert.equal(statusLabel('U').label, 'Konflik');
  assert.equal(statusLabel('?').label, 'Belum dilacak');
  assert.equal(statusLabel('!').label, 'Diabaikan');
});

test('statusLabel treats blank as unchanged and unknown letters as unknown', () => {
  assert.equal(statusLabel(' ').label, 'Tidak berubah');
  assert.equal(statusLabel('Z').label, 'Tidak diketahui');
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
  assert.equal(conflictLabel('UU'), 'UU — keduanya mengubah');
  assert.equal(conflictLabel('DU'), 'DU — dihapus di sini, diubah di sana');
  assert.equal(conflictLabel('UD'), 'UD — diubah di sini, dihapus di sana');
  assert.equal(conflictLabel('AA'), 'AA — ditambahkan di kedua sisi');
  assert.equal(conflictLabel('DD'), 'DD — dihapus di kedua sisi');
  assert.equal(conflictLabel('AU'), 'AU — ditambahkan di sini, diubah di sana');
  assert.equal(conflictLabel('UA'), 'UA — diubah di sini, ditambahkan di sana');
  assert.equal(conflictLabel('xx'), 'XX — konflik tidak dikenal');
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
  assert.equal(actionTarget({ action: 'stash-pop' }), '—');
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

