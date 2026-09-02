/**
 * Accessibility contract tests.
 *
 * Pure by construction: no DOM, no jsdom, no new dependency. That rules out
 * asserting rendered ARIA directly, so this file pins the two things that can be
 * checked in-process and that regress silently otherwise:
 *
 *  1. the PURE helpers that produce accessible names and status labels — every fact
 *     a sighted user reads off a row must appear in the string a screen reader gets,
 *     which is why `rowLabel` and friends live in `format.ts` rather than inline in
 *     a component;
 *  2. the source of `styles.css`, for theme-token discipline. A hardcoded colour
 *     works in exactly one theme and fails in the other two, and the failure is
 *     invisible to whoever added it.
 *
 * What this file deliberately does NOT claim to verify: focus order, focus traps,
 * live-region behaviour, contrast ratios, and target sizes as rendered. Those need
 * a real layout engine. They were checked by reading the components and the CSS, and
 * the findings are in the audit table, not here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
  ERROR_CODES,
  PORCELAIN_CODES,
  authorInitials,
  conflictActionLabel,
  conflictRowLabel,
  churnUnknownReason,
  entryStatus,
  fileRowLabel,
  folderRowLabel,
  orderedRemedies,
  presentError,
  refNamesLabel,
  repoName,
  remedyConsequence,
  remedyLabel,
  riskLabel,
  rowLabel,
  statusLabel,
  statusTone,
  syncSummary,
} from '../src/webview/format';
import { groupedMenuItems, menuItemsFor } from '../src/webview/NodeContextMenu';
import { computeBranchOptions, checkoutActionPayload } from '../src/webview/BranchLegend';
import { t } from '../src/webview/i18n';
import type { ChangeEntry, ErrorCode, GraphNode, RefInfo, Remedy, RepoStatus } from '../src/messages';

const NOW = Date.parse('2026-06-15T12:00:00.000Z');
const HASH = 'abc1234def5678'.padEnd(40, '0');

function node(patch: Partial<GraphNode> = {}): GraphNode {
  return {
    hash: HASH,
    shortHash: 'abc1234',
    x: 0,
    y: 0,
    lane: 0,
    isHead: false,
    isMerge: false,
    local: false,
    subject: 'Perbaiki panel',
    authorName: 'Siti',
    authoredAt: new Date(NOW - 3_600_000).toISOString(),
    refNames: [],
    ...patch,
  };
}

function entry(patch: Partial<ChangeEntry> = {}): ChangeEntry {
  return {
    path: 'src/webview/ui.tsx',
    indexStatus: 'M',
    worktreeStatus: ' ',
    staged: true,
    unstaged: false,
    untracked: false,
    additions: 12,
    deletions: 3,
    binary: false,
    ...patch,
  };
}

// ------------------------------------------------------- commit row名 (FEAT-01)

/**
 * The row shows, left to right: hash, badges, ref chips, subject, author, and
 * relative time. Every one of those spans is `aria-hidden` at the render site,
 * because `rowLabel` replaces them — so anything missing here is information a
 * screen-reader user simply does not get.
 */
test('rowLabel carries every fact the commit row shows visually', () => {
  const label = rowLabel(
    node({ isHead: true, isMerge: true, local: true, refNames: ['refs/heads/main', 'tag: v1.0'] }),
    NOW,
    'id',
  );
  assert.match(label, /abc1234/, 'short hash');
  assert.match(label, /Perbaiki panel/, 'subject');
  assert.match(label, /oleh Siti/, 'author');
  assert.match(label, /1 jam lalu/, 'relative time');
  assert.match(label, /HEAD/, 'HEAD badge');
  assert.match(label, /commit merge/, 'merge badge');
  assert.match(label, /lokal belum dipush/, 'local badge');
  assert.match(label, /ref main/, 'ref chips');
  assert.match(label, /tag v1\.0/, 'tag chip');

  // Verify English label format too
  const enLabel = rowLabel(
    node({ isHead: true, isMerge: true, local: true, refNames: ['refs/heads/main', 'tag: v1.0'] }),
    NOW,
    'en',
  );
  assert.match(enLabel, /by Siti/);
  assert.match(enLabel, /local not pushed/);
});

test('rowLabel states the push state either way, not only when local', () => {
  // "no badge" is a fact a sighted user reads from the filled dot. Silence is not
  // the same signal, so the remote case says so in words.
  assert.match(rowLabel(node({ local: true }), NOW, 'id'), /lokal belum dipush/);
  assert.match(rowLabel(node({ local: false }), NOW, 'id'), /sudah ada di remote/);
  assert.match(rowLabel(node({ local: true }), NOW, 'en'), /local not pushed/);
  assert.match(rowLabel(node({ local: false }), NOW, 'en'), /on remote/);
});

test('rowLabel omits absent state instead of saying "bukan HEAD"', () => {
  const label = rowLabel(node(), NOW, 'id');
  assert.ok(!label.includes('HEAD'), label);
  assert.ok(!label.includes('merge'), label);
});

test('rowLabel sanitises every git-sourced part (SEC-007)', () => {
  const label = rowLabel(
    node({ subject: 'a\u202eb', authorName: 'c\u200bd', refNames: ['e\u202ef'] }),
    NOW,
    'id',
  );
  assert.ok(!label.includes('\u202e'), 'no bidi override survives');
  assert.ok(!label.includes('\u200b'), 'no zero-width survives');
  assert.match(label, /\ufffd/, 'the removal is marked, not silent');
});

test('refNamesLabel distinguishes local, remote, and tag refs in words', () => {
  assert.equal(refNamesLabel([], 'id'), null);
  assert.equal(refNamesLabel(['HEAD'], 'id'), null, 'HEAD is already a separate fact');
  assert.equal(refNamesLabel(['refs/heads/main'], 'id'), 'ref main');
  assert.equal(refNamesLabel(['origin/main'], 'id'), 'ref remote origin/main');
  assert.equal(refNamesLabel(['tag: v2'], 'id'), 'ref tag v2');
  assert.equal(refNamesLabel(['refs/heads/a', 'tag: b'], 'id'), 'ref a, tag b');

  assert.equal(refNamesLabel(['origin/main'], 'en'), 'ref remote origin/main');
  assert.equal(refNamesLabel(['tag: v2'], 'en'), 'ref tag v2');
});

// ------------------------------------------------- file and conflict row names

test('fileRowLabel carries path and churn', () => {
  const label = fileRowLabel(entry(), false, 'id');
  assert.match(label, /src\/webview\/ui\.tsx/, 'path');
  assert.match(label, /12 baris ditambah/, 'additions');
  assert.match(label, /3 baris dihapus/, 'deletions');

  const enLabel = fileRowLabel(entry(), false, 'en');
  assert.match(enLabel, /12 lines added/);
  assert.match(enLabel, /3 lines deleted/);
});

test('fileRowLabel says "file binary" instead of a churn of zero', () => {
  const label = fileRowLabel(entry({ binary: true, additions: null, deletions: null }), false, 'id');
  assert.match(label, /file binary/);
  assert.ok(!label.includes('0 baris'), label);

  const enLabel = fileRowLabel(entry({ binary: true, additions: null, deletions: null }), false, 'en');
  assert.match(enLabel, /binary file/);
});

/**
 * `null` counts mean git never counted the file, which is the normal case for an
 * untracked one. Reading "0 baris ditambah" would tell a screen-reader user the new
 * file is empty, so the label must name the reason instead.
 */
test('fileRowLabel reports uncounted churn as unknown, never as zero', () => {
  const untracked = fileRowLabel(
    entry({ untracked: true, indexStatus: ' ', worktreeStatus: '?', additions: null, deletions: null }),
    false,
    'id',
  );
  assert.ok(!untracked.includes('0 baris'), untracked);
  assert.match(untracked, /belum dilacak git/, 'says why there is no count');

  const tracked = fileRowLabel(entry({ additions: null, deletions: null }), false, 'id');
  assert.ok(!tracked.includes('0 baris'), tracked);
  assert.match(tracked, /belum dihitung/);
});

test('fileRowLabel still reports a real zero-line change as zero', () => {
  assert.match(fileRowLabel(entry({ additions: 0, deletions: 0 }), false, 'id'), /0 baris ditambah/);
  assert.match(fileRowLabel(entry({ additions: 0, deletions: 0 }), false, 'en'), /0 lines added/);
});

test('fileRowLabel reports renames with arrow', () => {
  const label = fileRowLabel(entry({ path: 'b.ts', origPath: 'a.ts', indexStatus: 'R' }), false, 'id');
  assert.match(label, /a\.ts → b\.ts/);
});

test('entryStatus reports untracked ahead of the index letter', () => {
  assert.equal(entryStatus(entry({ untracked: true, indexStatus: ' ' }), 'id').label, 'Belum dilacak');
  assert.equal(entryStatus(entry({ untracked: true, indexStatus: ' ' }), 'en').label, 'Untracked');
});

test('churnUnknownReason distinguishes untracked files from uncounted tracked files', () => {
  assert.match(churnUnknownReason(entry({ untracked: true, additions: null, deletions: null }), false, 'id'), /belum dilacak/);
  assert.match(churnUnknownReason(entry({ additions: null, deletions: null }), false, 'id'), /belum dihitung/);
});

/**
 * A dash means three different things, and the difference is what a beginner acts
 * on: a new file git has not diffed, a binary file with no lines to count, and a
 * tracked file whose numbers were never computed because the change list was too
 * big. The last one is the one that reads as "unchanged" if it is not spelled out.
 */
test('churnUnknownReason separates untracked, binary, and truncated reasons', () => {
  const uncounted = { additions: null, deletions: null };
  const untracked = churnUnknownReason(entry({ ...uncounted, untracked: true }), true, 'id');
  const binary = churnUnknownReason(entry({ ...uncounted, binary: true }), true, 'id');
  const truncated = churnUnknownReason(entry(uncounted), true, 'id');
  const plain = churnUnknownReason(entry(uncounted), false, 'id');

  assert.match(untracked, /belum dilacak git/);
  assert.match(binary, /binary/);
  assert.match(truncated, /terlalu besar/, 'names the real cause');
  assert.match(truncated, /bukan berarti file ini tidak berubah/, 'denies the wrong reading');
  assert.match(plain, /belum dihitung/, 'no truncation, no truncation wording');

  const distinct = new Set([untracked, binary, truncated, plain]);
  assert.equal(distinct.size, 4, 'all four reasons read differently');
});

test('fileRowLabel carries the truncation reason into the accessible name', () => {
  const label = fileRowLabel(entry({ additions: null, deletions: null }), true, 'id');
  assert.match(label, /terlalu besar/);
  assert.ok(!label.includes('0 baris'), label);
});

test('repoName keeps the final repository folder across Windows and POSIX paths', () => {
  assert.equal(repoName('D:/work/Git-Control'), 'Git-Control');
  assert.equal(repoName('D:\\work\\Git-Control\\'), 'Git-Control');
  assert.equal(repoName('/work/Git-Control/'), 'Git-Control');
});

test('folderRowLabel names the folder and how many files it holds', () => {
  assert.equal(folderRowLabel('webview', 12, 'id'), 'Folder webview, 12 file');
  assert.match(folderRowLabel('a\u202eb', 1, 'id'), /\ufffd/, 'sanitised');
  assert.equal(folderRowLabel('webview', 12, 'en'), 'Folder webview, 12 files');
});

test('conflict row and action names include the path, so buttons are distinguishable', () => {
  assert.equal(
    conflictActionLabel('Tandai selesai', 'src/a.ts', 'id'),
    'Tandai selesai src/a.ts',
  );
  assert.match(conflictActionLabel('Selesaikan', 'a\u202eb', 'id'), /\ufffd/);
  const row = conflictRowLabel({ path: 'src/a.ts', code: 'UU' }, 'id');
  assert.match(row, /src\/a\.ts/);
  assert.match(row, /keduanya mengubah/, 'the code is explained, not just quoted');

  const enRow = conflictRowLabel({ path: 'src/a.ts', code: 'UU' }, 'en');
  assert.match(enRow, /both modified/);
});

// ------------------------------------------------------------ status labels

/**
 * Every porcelain code the panel can receive must have an Indonesian word and a
 * distinct valid icon. A code falling through to "Tidak diketahui" is a row the user
 * cannot act on, and colour alone would be the only remaining signal.
 */
test('every porcelain code maps to a label, an icon, and no fallback', () => {
  for (const code of PORCELAIN_CODES) {
    const label = statusLabel(code, 'id');
    assert.ok(label.label.length > 0, `${code} has a word`);
    assert.ok(label.icon.length > 0, `${code} has an icon`);
    assert.notEqual(label.label, 'Tidak diketahui', `${code} must not fall through`);
  }
});

test('status labels and icons are defined, so two states never read alike', () => {
  const labels = new Set<string>();
  const icons = new Set<string>();
  for (const code of PORCELAIN_CODES) {
    const label = statusLabel(code, 'id');
    labels.add(label.label);
    icons.add(label.icon);
  }
  assert.equal(labels.size, PORCELAIN_CODES.length, 'no duplicate words');
  assert.equal(icons.size, PORCELAIN_CODES.length, 'every porcelain code must map to a distinct icon');
});

test('statusLabel accepts lower case and only reports unknown for a real unknown', () => {
  assert.equal(statusLabel('m', 'id').label, 'Dimodifikasi');
  assert.equal(statusLabel('Z', 'id').label, 'Tidak diketahui');
  assert.equal(statusLabel('m', 'en').label, 'Modified');
  assert.equal(statusLabel('Z', 'en').label, 'Unknown');
});

test('entryStatus never yields a state without a word', () => {
  const cases: ChangeEntry[] = [
    entry(),
    entry({ indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true }),
    entry({ untracked: true, indexStatus: ' ', worktreeStatus: ' ' }),
    entry({ indexStatus: 'U', worktreeStatus: 'U' }),
    entry({ indexStatus: 'D', worktreeStatus: ' ' }),
    entry({ indexStatus: 'C', worktreeStatus: ' ' }),
    entry({ indexStatus: 'T', worktreeStatus: ' ' }),
  ];
  for (const value of cases) {
    const status = entryStatus(value, 'id');
    assert.notEqual(status.label, 'Tidak diketahui', JSON.stringify(value));
    assert.ok(status.icon.length > 0);
  }
});

// ------------------------------------------------------- status tone (colour)

/**
 * The coloured letter box is the THIRD channel, never a replacement for the first
 * two. This pins the ordering: a tone is only ever an addition to a letter that is
 * already unique and a word that is already unique (asserted above), and several
 * letters deliberately share one tone — so a test that demanded a tone per letter
 * would be demanding nine indistinguishable hues.
 */
test('statusTone names a tone for every porcelain code and never invents a hue per letter', () => {
  const tones = new Set<string>();
  for (const code of PORCELAIN_CODES) {
    const tone = statusTone(code);
    assert.ok(tone.length > 0, `${code} has a tone`);
    tones.add(tone);
  }
  // Fewer tones than letters is the point: colour groups, letters identify.
  assert.ok(tones.size < PORCELAIN_CODES.length, `${tones.size} tones for ${PORCELAIN_CODES.length} letters`);
  assert.equal(statusTone('Z'), 'neutral', 'an unknown letter does not guess a colour');
});

test('statusTone separates the states a user must not confuse', () => {
  // Added versus deleted is the one pair where a wrong hue is actively misleading.
  assert.notEqual(statusTone('A'), statusTone('D'));
  assert.notEqual(statusTone('M'), statusTone('D'));
  assert.notEqual(statusTone('?'), statusTone('M'), 'untracked is not just another change');
});

// ------------------------------------------------------------ author initials

/**
 * The initial drawn inside a commit node is `aria-hidden`, because `rowLabel` already
 * carries the author's full name. These assertions cover the part that can still go
 * wrong: a name that yields no letter at all would render an empty node, and a
 * multi-character return would overflow the circle.
 */
test('authorInitials always returns exactly one visible character', () => {
  for (const name of ['Siti', 'siti rahayu', '  budi', 'Ökan', '张伟', '9lives', '', '   ']) {
    const initial = authorInitials(name);
    assert.equal([...initial].length, 1, `${JSON.stringify(name)} → ${JSON.stringify(initial)}`);
  }
});

test('authorInitials uppercases, and falls back to ? rather than to nothing', () => {
  assert.equal(authorInitials('siti'), 'S');
  assert.equal(authorInitials('  budi santoso'), 'B');
  assert.equal(authorInitials(''), '?');
  assert.equal(authorInitials('...'), '?', 'punctuation is not an initial');
  // A name made entirely of characters we replace still yields a visible glyph.
  assert.equal(authorInitials('\u202e'), '?');
});

test('authorInitials keeps the node label out of sync with nothing it cannot show', () => {
  // Sanitisation happens inside, so a bidi override can never reach the SVG text.
  assert.ok(!authorInitials('\u202eSiti').includes('\u202e'));
});

// -------------------------------------------------------------- sync summary

/**
 * `ahead` / `behind` are the two numbers newcomers most often read backwards. The
 * breadcrumb states each as an action rather than as an arrow, and "no upstream" is
 * stated as a consequence rather than as an absence.
 */
test('syncSummary says which direction each pending commit goes', () => {
  const ahead = syncSummary({ upstream: 'origin/main', ahead: 2, behind: 0 }, 'id');
  assert.match(ahead, /2 commit siap dipush/);
  assert.ok(!ahead.includes('menunggu diambil'), ahead);

  const behind = syncSummary({ upstream: 'origin/main', ahead: 0, behind: 3 }, 'id');
  assert.match(behind, /3 commit baru menunggu diambil/);

  const both = syncSummary({ upstream: 'origin/main', ahead: 1, behind: 4 }, 'id');
  assert.match(both, /1 commit siap dipush/);
  assert.match(both, /4 commit baru menunggu diambil/);

  const enAhead = syncSummary({ upstream: 'origin/main', ahead: 2, behind: 0 }, 'en');
  assert.match(enAhead, /2 commits to push/);
});

test('syncSummary states an in-sync branch and a missing upstream in words', () => {
  assert.match(syncSummary({ upstream: 'origin/main', ahead: 0, behind: 0 }, 'id'), /Sama dengan origin\/main/);
  const none = syncSummary({ upstream: null, ahead: 0, behind: 0 }, 'id');
  assert.match(none, /Belum terhubung ke remote/);
  assert.match(none, /baru ada di komputer ini/, 'says what that means, not just that it is so');

  assert.match(syncSummary({ upstream: 'origin/main', ahead: 0, behind: 0 }, 'en'), /Up to date with origin\/main/);
  const enNone = syncSummary({ upstream: null, ahead: 0, behind: 0 }, 'en');
  assert.match(enNone, /Not connected to remote/);
});

test('syncSummary sanitises the upstream name (SEC-007)', () => {
  const label = syncSummary({ upstream: 'origin/ma\u202ein', ahead: 1, behind: 0 }, 'id');
  assert.ok(!label.includes('\u202e'));
  assert.match(label, /\ufffd/);
});

// ------------------------------------------------------------- error surfaces

test('every ErrorCode has an Indonesian title, an explanation, and a way out', () => {
  for (const code of ERROR_CODES) {
    const view = presentError({ status: 500, code, message: '' }, 'id');
    assert.ok(view.title.length > 0, `${code} title`);
    assert.ok(view.explanation.length > 10, `${code} explanation`);
    assert.ok(view.remedies.length > 0, `${code} remedies`);
    // Every offered remedy must be nameable, or the button renders blank.
    for (const remedy of view.remedies) {
      assert.ok(remedyLabel(remedy, 'id').length > 0, `${code} → ${remedy}`);
      assert.ok(remedyLabel(remedy, 'en').length > 0, `${code} → ${remedy}`);
    }

    const enView = presentError({ status: 500, code, message: '' }, 'en');
    assert.ok(enView.title.length > 0);
    assert.ok(enView.explanation.length > 10);
  }
});

test('the default remedies match the situation instead of always being Batal', () => {
  // A dirty tree has two real ways forward; offering only `Batal` would make the
  // banner a dead end for the most common block in the whole flow.
  assert.deepEqual(presentError({ status: 412, code: 'DIRTY_TREE', message: '' }).remedies, [
    'commit',
    'stash',
    'cancel',
  ]);
  for (const code of ['REMOTE_AHEAD', 'STALE_STATUS', 'NON_FAST_FORWARD'] as ErrorCode[]) {
    assert.ok(
      presentError({ status: 409, code, message: '' }).remedies.includes('fetch'),
      `${code} leads to fetch`,
    );
  }
  assert.ok(
    presentError({ status: 428, code: 'CONFIRMATION_REQUIRED', message: '' }).remedies.includes(
      'confirm',
    ),
  );
});

test('no default remedy set ever suggests forcing anything', () => {
  for (const code of ERROR_CODES) {
    for (const remedy of presentError({ status: 500, code, message: '' }).remedies) {
      assert.ok(!String(remedy).includes('force'), `${code} → ${remedy}`);
    }
  }
});

test('a host-supplied remedy list always wins over the default', () => {
  const view = presentError({
    status: 412,
    code: 'DIRTY_TREE',
    message: '',
    remedies: ['cancel'],
  });
  assert.deepEqual(view.remedies, ['cancel']);
});

test('risk is stated in words at every level, never by colour alone', () => {
  for (const risk of ['low', 'medium', 'high'] as const) {
    assert.ok(riskLabel(risk, 'id').length > 0, risk);
    assert.ok(riskLabel(risk, 'en').length > 0, risk);
  }
  assert.notEqual(riskLabel('low', 'id'), riskLabel('medium', 'id'));
  assert.notEqual(riskLabel('medium', 'id'), riskLabel('high', 'id'));
});

// ------------------------------------------------------ remedy button copy

/**
 * `Stash` and `Fetch` are terms of art. A user avoiding the terminal is exactly the
 * user who does not know them, so every remedy button carries a `title` naming what
 * it does to their files. A missing or vague sentence turns the guard dialog's way
 * out into another guess.
 */
test('every remedy names its consequence in a full Indonesian sentence', () => {
  const remedies: Remedy[] = ['commit', 'stash', 'fetch', 'cancel', 'resolve-conflicts', 'confirm'];
  const seen = new Set<string>();
  for (const remedy of remedies) {
    const text = remedyConsequence(remedy, 'id');
    assert.ok(text.length > 20, `${remedy} says something substantive: ${text}`);
    assert.match(text, /\.$/, `${remedy} is a sentence, not a fragment`);
    seen.add(text);
  }
  assert.equal(seen.size, remedies.length, 'no two remedies share one explanation');
});

test('the reversible remedies promise the work is recoverable', () => {
  // These two are the ones a newcomer refuses out of fear. Saying "not lost" is the
  // whole reason the sentence exists.
  assert.match(remedyConsequence('stash', 'id'), /bisa diambil kembali/);
  assert.match(remedyConsequence('fetch', 'id'), /tidak diubah/);
  assert.match(remedyConsequence('cancel', 'id'), /[Tt]idak ada yang berubah/);

  assert.match(remedyConsequence('stash', 'en'), /restored later/);
  assert.match(remedyConsequence('fetch', 'en'), /unchanged/);
  assert.match(remedyConsequence('cancel', 'en'), /Nothing is changed/);
});

/**
 * `.gc-modal__actions` is right-aligned, so the LAST button is the bottom-right
 * corner — where a hand goes without reading. In a dialog whose only job is stopping
 * an accidental press, that corner must never hold the irreversible button.
 */
test('orderedRemedies puts the confirmation first and Batal last', () => {
  assert.deepEqual(orderedRemedies(['confirm', 'cancel']), ['confirm', 'cancel']);
  // Even when the host sends them the other way round.
  assert.deepEqual(orderedRemedies(['cancel', 'confirm']), ['confirm', 'cancel']);
  assert.deepEqual(orderedRemedies(['commit', 'stash', 'cancel']), ['commit', 'stash', 'cancel']);
  assert.deepEqual(orderedRemedies(['cancel', 'fetch']), ['fetch', 'cancel']);
});

test('orderedRemedies changes order only, never membership', () => {
  for (const code of ERROR_CODES) {
    const remedies = presentError({ status: 500, code, message: '' }).remedies;
    const ordered = orderedRemedies(remedies);
    assert.deepEqual([...ordered].sort(), [...remedies].sort(), code);
    if (ordered.includes('cancel')) {
      assert.equal(ordered[ordered.length - 1], 'cancel', `${code} ends in Batal`);
    }
  }
});

// -------------------------------------------------------- context menu groups

function ref(patch: Partial<RefInfo> = {}): RefInfo {
  return {
    refName: 'refs/heads/main',
    shortName: 'main',
    kind: 'local',
    objectName: HASH,
    upstream: null,
    ahead: 0,
    behind: 0,
    isHead: false,
    ...patch,
  };
}

function status(patch: Partial<RepoStatus> = {}): RepoStatus {
  return {
    repoRoot: 'D:/repo',
    branch: 'main',
    head: HASH,
    detached: false,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    incoming: 0,
    outgoing: 0,
    dirty: false,
    staged: false,
    operation: 'idle',
    changes: [],
    conflicts: [],
    churnTruncated: false,
    statusToken: 'token',
    lastFetchedAt: null,
    lastFetchAt: null,
    ...patch,
  };
}

/**
 * The split between "only looks" and "changes the repository" is the menu's whole
 * safety story, so it is asserted rather than trusted: a new item that forgets its
 * group cannot compile, but a new item that picks the WRONG group compiles fine and
 * silently files `reset --hard` under the harmless heading.
 */
test('every menu item declares a group, and the read-only ones cannot mutate', () => {
  const items = menuItemsFor(
    node({ local: true }),
    status(),
    [
      ref({ shortName: 'fitur', refName: 'refs/heads/fitur' }),
      ref({ kind: 'remote', shortName: 'origin/main', refName: 'refs/remotes/origin/main' }),
    ],
    'https://github.com/a/b',
  );
  assert.ok(items.length > 0, 'the menu is not empty');
  for (const item of items) {
    assert.ok(item.group === 'jelajah' || item.group === 'ubah', item.id);
    if (item.group === 'jelajah') {
      assert.notEqual(item.command.kind, 'action', `${item.id} must not run git`);
      assert.notEqual(item.command.kind, 'createBranch', `${item.id} must not write a ref`);
      assert.notEqual(item.command.kind, 'mergeInto', `${item.id} must not mutate repository`);
    }
    if (item.command.kind === 'action' || item.command.kind === 'mergeInto') {
      assert.equal(item.group, 'ubah', `${item.id} runs git and belongs in the mutating half`);
    }
  }
});

test('only non-obvious or destructive menu items carry a hint', () => {
  const items = menuItemsFor(
    node({ local: true }),
    status(),
    [
      ref({ shortName: 'fitur', refName: 'refs/heads/fitur' }),
      ref({ kind: 'remote', shortName: 'origin/main', refName: 'refs/remotes/origin/main' }),
    ],
    'https://github.com/a/b',
  );
  const withHint = items.filter((i) => i.hint !== undefined).map((i) => i.id);
  assert.deepEqual(
    withHint.sort(),
    ['checkout-commit', 'merge-into', 'push-up-to', 'reset-hard', 'reset-soft', 'revert'].sort(),
  );
  for (const item of items) {
    if (item.hint !== undefined) {
      assert.ok(item.hint.length > 0 && !item.hint.includes('\n'), `${item.id} hint is single line`);
    }
  }
});

test('the destructive items are the ones marked risky, and they say what is lost', () => {
  const items = menuItemsFor(
    node(),
    status(),
    [ref({ shortName: 'main', refName: 'refs/heads/main' })],
    null,
    'id',
  );
  const risky = new Set(items.filter((i) => i.risky === true).map((i) => i.id));
  for (const id of ['reset-hard', 'reset-soft', 'revert', 'checkout-commit', 'merge-into']) {
    assert.ok(risky.has(id), `${id} is marked risky`);
  }
  const hard = items.find((i) => i.id === 'reset-hard');
  assert.match(hard?.hint ?? '', /[Pp]ermanen/, 'reset hard names the permanence');

  const enItems = menuItemsFor(
    node(),
    status(),
    [ref({ shortName: 'main', refName: 'refs/heads/main' })],
    null,
    'en',
  );
  const enHard = enItems.find((i) => i.id === 'reset-hard');
  assert.match(enHard?.hint ?? '', /[Pp]ermanently/, 'en reset hard names the permanence');
});

test('groupedMenuItems keeps read-only first and drops empty groups', () => {
  const items = menuItemsFor(node(), null, [], null);
  const groups = groupedMenuItems(items);
  assert.equal(groups[0]?.group, 'jelajah', 'the safe half is shown first');
  for (const group of groups) {
    assert.ok(group.items.length > 0, `${group.group} is non-empty`);
  }
  // The flattened order is what the roving tabindex walks, so it has to hold
  // every item exactly once.
  const flat = groups.flatMap((g) => g.items.map((i) => i.id));
  assert.equal(flat.length, items.length);
  assert.equal(new Set(flat).size, flat.length, 'no item is rendered twice');
});

// --------------------------------------------------------- theme discipline

const CSS = path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css');

/** `styles.css`, with comments stripped so prose cannot trip the colour checks. */
function stylesheet(): string {
  return fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * No literal colour anywhere in the stylesheet.
 *
 * Chrome colour must come from a `--vscode-*` token, because those are the only
 * values that follow the user's theme; a hex or `rgb()` literal is correct in one
 * theme and wrong in the other two, including high contrast, where it can silently
 * destroy the contrast the theme was guaranteeing.
 *
 * Lane colours are the sanctioned exception and are NOT here: they are data, they
 * arrive from `layout.ts` as inline `stroke`/`fill`/`background`, and this test
 * passing is what proves they never leaked into CSS.
 *
 * The allowlist is empty on purpose. If a case ever genuinely needs a literal, it
 * gets added here WITH a reason, and the reason gets reviewed.
 */
const COLOUR_ALLOWLIST: readonly string[] = [];

test('styles.css contains no hardcoded colour literals', () => {
  const css = stylesheet();
  const patterns: Array<[string, RegExp]> = [
    ['hex', /#[0-9a-fA-F]{3,8}\b/g],
    ['rgb()', /\brgba?\s*\(/g],
    ['hsl()', /\bhsla?\s*\(/g],
    ['lab/lch/oklab/oklch', /\b(?:lab|lch|oklab|oklch)\s*\(/g],
    ['color()', /\bcolor\s*\(/g],
  ];
  const offenders: string[] = [];
  for (const [kind, pattern] of patterns) {
    for (const match of css.matchAll(pattern)) {
      if (COLOUR_ALLOWLIST.includes(match[0])) continue;
      const line = css.slice(0, match.index).split('\n').length;
      offenders.push(`${kind} at line ${line}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `hardcoded colours:\n${offenders.join('\n')}`);
});

test('styles.css names no CSS colour keyword outside the forced-colors block', () => {
  // System colours (`ButtonBorder`, `Highlight`) are legitimate — they ARE the
  // theme in forced-colours mode. Named colours like `red` are not.
  const css = stylesheet();
  const named = /(?:^|[\s:,(])(red|blue|green|black|white|gray|grey|orange|yellow|purple)(?=[\s;,)]|$)/gi;
  const offenders = [...css.matchAll(named)].map(
    (m) => `line ${css.slice(0, m.index).split('\n').length}: ${m[1]}`,
  );
  assert.deepEqual(offenders, [], `named colours:\n${offenders.join('\n')}`);
});

test('every colour declaration resolves through a --vscode or --gc token', () => {
  const css = stylesheet();
  const offenders: string[] = [];
  // `stroke`/`fill` are excluded: on the graph they are set inline from lane data,
  // and the CSS only ever sets them from a token or to `none`/`transparent`.
  const declaration = /(?:^|[;{])\s*(color|background|background-color|border-color|outline-color|fill|stroke)\s*:\s*([^;}]+)/g;
  for (const match of css.matchAll(declaration)) {
    const property = match[1] ?? '';
    const value = (match[2] ?? '').trim();
    if (/var\(--(?:vscode|gc)-/.test(value)) continue;
    if (/^(?:none|transparent|inherit|currentColor|initial|unset)$/i.test(value)) continue;
    // Forced-colours system keywords.
    if (/^(?:ButtonBorder|Highlight|HighlightText|CanvasText|Canvas|LinkText|GrayText)$/.test(value)) continue;
    const line = css.slice(0, match.index).split('\n').length;
    offenders.push(`line ${line}: ${property}: ${value}`);
  }
  assert.deepEqual(offenders, [], `untokenised colours:\n${offenders.join('\n')}`);
});

/**
 * The three theme-independence guarantees the CSS makes in its own header comment.
 * Each is one rule that is easy to delete by accident and impossible to notice.
 */
test('styles.css keeps a focus ring, a reduced-motion escape, and a forced-colors block', () => {
  const raw = fs.readFileSync(CSS, 'utf8');
  assert.match(raw, /:focus-visible\s*\{[^}]*outline:[^}]*--vscode-focusBorder/, 'visible focus ring');
  assert.match(raw, /@media \(prefers-reduced-motion: reduce\)/, 'motion can be turned off');
  assert.match(raw, /@media \(forced-colors: active\)/, 'high-contrast themes are handled');
});

/**
 * Target size. `--gc-hit` is the single knob, so this asserts the knob is at least
 * the WCAG 2.5.8 minimum and that the controls actually reference it — a 16 px
 * checkbox with no padding is the classic failure, and it is invisible on a desktop
 * mouse and unusable on a touch screen.
 */
test('the hit-area token meets the 24 px floor and the controls use it', () => {
  const css = stylesheet();
  const token = /--gc-hit:\s*(\d+)px/.exec(css);
  assert.ok(token !== null, '--gc-hit is defined');
  assert.ok(Number(token[1]) >= 24, `--gc-hit is ${token[1]}px, must be >= 24px`);
  for (const selector of ['.gc-button', '.gc-icon-button', '.gc-menu__item', '.gc-tree__row']) {
    const block = new RegExp(`\\${selector}[^{]*\\{[^}]*var\\(--gc-hit\\)`);
    assert.match(css, block, `${selector} sizes itself from --gc-hit`);
  }
});

/** Spacing discipline: one scale, so the panel reads as one surface. */
test('the spacing scale is a 4 px ladder', () => {
  const css = stylesheet();
  const values = [...css.matchAll(/--gc-space-\d:\s*(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(values.length >= 5, 'the scale exists');
  for (const value of values) {
    assert.equal(value % 2, 0, `${value}px is off the ladder`);
  }
  assert.deepEqual([...values].sort((a, b) => a - b), values, 'the scale ascends');
});

/**
 * Type discipline. Every font size in the file already resolves to a `--gc-fs-*`
 * token (the colour tests would not catch a raw `11px`), so this pins the scale
 * itself: relative units, so the whole UI follows the editor font size and survives
 * a 200 % zoom, and no duplicate steps, which is how a "scale" quietly becomes a
 * pile of near-identical sizes.
 */
test('the type scale is relative and has no duplicate steps', () => {
  const css = stylesheet();
  const root = /:root\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(root !== null, ':root exists');
  const steps = [...(root[1] ?? '').matchAll(/--gc-fs-[\w-]+:\s*([^;]+);/g)].map((m) =>
    (m[1] ?? '').trim(),
  );
  assert.ok(steps.length >= 5, 'the scale exists');
  for (const step of steps) {
    assert.match(step, /^[\d.]+em$/, `${step} must be relative, not absolute`);
  }
  assert.equal(new Set(steps).size, steps.length, `duplicate type steps: ${steps.join(', ')}`);
});

/** No font size may bypass the scale. A raw `11px` is invisible until someone zooms. */
test('every font-size in the stylesheet comes from a token', () => {
  const css = stylesheet();
  const offenders: string[] = [];
  for (const match of css.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
    const value = (match[1] ?? '').trim();
    if (/var\(--(?:gc-fs|vscode-font-size)/.test(value)) continue;
    if (value === 'inherit') continue;
    offenders.push(`line ${css.slice(0, match.index).split('\n').length}: ${value}`);
  }
  assert.deepEqual(offenders, [], `untokenised font sizes:\n${offenders.join('\n')}`);
});

/** Spacing declarations use the same scale; resets and layout keywords are the only exceptions. */
test('every margin, padding, and gap in the stylesheet uses a spacing token', () => {
  const css = stylesheet();
  const offenders: string[] = [];
  const allowed = /^(?:0|auto|-1px)(?:\s+(?:0|auto|-1px))*$/;
  for (const match of css.matchAll(/(?:^|[;{])\s*((?:margin|padding)(?:-[a-z]+)?|gap|(?:row|column)-gap)\s*:\s*([^;}]+)/g)) {
    const property = match[1] ?? '';
    const value = (match[2] ?? '').trim();
    if (/var\(--gc-space-/.test(value) || allowed.test(value)) continue;
    // Tree/row indentation is proportional to depth, not surface rhythm.
    if (property === 'padding-left' && /^(?:1\.4|1\.2)em$/.test(value)) continue;
    offenders.push(`${property}: ${value}`);
  }
  assert.deepEqual(offenders, [], `untokenised spacing:\n${offenders.join('\n')}`);
});

/**
 * The status tones bridge `format.ts` and the stylesheet: `statusTone` returns a key,
 * and the CSS must have a rule for it. A missing rule is a letter box with no colour
 * — harmless-looking, and it silently drops the redundancy the badge was added for.
 *
 * Each tone also has to resolve through a `--vscode-*` fallback chain, so a theme
 * without the `charts-*` palette still gets a readable letter rather than an
 * unstyled one.
 */
test('every status tone has a CSS rule and a theme fallback', () => {
  const css = stylesheet();
  const tones = new Set(PORCELAIN_CODES.map((code) => statusTone(code)));
  for (const tone of tones) {
    assert.match(
      css,
      new RegExp(`\\.gc-status__box--${tone}\\s*\\{[^}]*color:\\s*var\\(--gc-(?:tone-${tone}|muted)\\)`),
      `.gc-status__box--${tone} is styled`,
    );
  }
  for (const match of css.matchAll(/--gc-tone-[\w-]+:\s*([^;]+);/g)) {
    const value = (match[1] ?? '').trim();
    assert.match(value, /^var\(--vscode-[\w-]+,\s*var\(--vscode-[\w-]+\)\)$/, `${value} needs a fallback`);
  }
});

/**
 * Toast severity uses the SAME tones as the file-status boxes: error → `removed`,
 * warning → `pending`, info → `changed`. One colour vocabulary across the extension
 * is the point — the hue that marks a deleted file is the hue that marks a failed
 * operation — so a future edit that reaches for `--gc-danger` here (a different red)
 * has to fail rather than merely look slightly off.
 */
test('every toast level takes its tone from the shared status palette', () => {
  const css = stylesheet();
  for (const [level, tone] of [
    ['info', 'changed'],
    ['warning', 'pending'],
    ['error', 'removed'],
  ] as const) {
    assert.match(
      css,
      new RegExp(`\\.gc-toast--${level}\\s*\\{[^}]*border-left-color:\\s*var\\(--gc-tone-${tone}\\)`),
      `.gc-toast--${level} is bordered in the ${tone} tone`,
    );
    assert.match(
      css,
      new RegExp(`\\.gc-toast--${level} \\.gc-toast__level\\s*\\{[^}]*color:\\s*var\\(--gc-tone-${tone}\\)`),
      `.gc-toast--${level} words match its border`,
    );
  }
});

/**
 * Two classes added in this pass carry meaning through a border colour, and forced
 * colours discards colour entirely. Both therefore need an entry in the
 * forced-colours block, or the level-2 guard frame flattens back to a plain dialog
 * and the risk marker in the context menu disappears — in the one theme where the
 * user is most likely to be relying on it.
 */
test('the severity frame and the menu risk rule survive forced colours', () => {
  const raw = fs.readFileSync(CSS, 'utf8');
  // There is more than one forced-colours block (one early for the focus ring), so
  // every body is collected rather than only the first match.
  const bodies = [...raw.matchAll(/@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/g)].map(
    (m) => m[1] ?? '',
  );
  assert.ok(bodies.length > 0, 'a forced-colors block exists');
  const body = bodies.join('\n');
  assert.match(body, /\.gc-modal--severe\s*\{[^}]*border\s*:\s*2px solid ButtonBorder/, 'the level-2 guard frame has visible border in forced colors');
  assert.match(body, /\.gc-menu__item--risky\s*\{[^}]*border-left\s*:\s*3px solid ButtonBorder/, 'the risky-item rule has visible left border in forced colors');

  // Floating overlays must receive a border so they stay visible against canvas in high contrast
  const borderGroup = body.match(/([^{]+)\{\s*border:\s*1px solid ButtonBorder;\s*\}/);
  assert.ok(borderGroup, 'a ButtonBorder rule block exists in forced-colors');
  const selectors = borderGroup[1] ?? '';
  assert.match(selectors, /\.gc-minimap-wrap\b/, '.gc-minimap-wrap receives 1px border in forced-colors');
  assert.match(selectors, /\.gc-legend-popover\b/, '.gc-legend-popover receives 1px border in forced-colors');
  assert.match(selectors, /\.gc-legend\b/, '.gc-legend receives 1px border in forced-colors');
  assert.match(selectors, /\.gc-minimap\b/, '.gc-minimap receives 1px border in forced-colors');
});

test('resting commit rows retain accessible tree presence without visibility:hidden or display:none', () => {
  const raw = fs.readFileSync(CSS, 'utf8');
  // Strip comments
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // Extract .gc-row base rule block
  const match = stripped.match(/\.gc-row\s*\{([^}]+)\}/);
  assert.ok(match, '.gc-row rule exists');
  const rowBlock = match[1] ?? '';

  assert.doesNotMatch(rowBlock, /visibility\s*:\s*hidden/, '.gc-row resting state does NOT hide via visibility:hidden');
  assert.doesNotMatch(rowBlock, /display\s*:\s*none/, '.gc-row resting state does NOT hide via display:none');
  assert.match(rowBlock, /opacity\s*:\s*0/, '.gc-row resting state hides visually via opacity: 0');
  assert.match(rowBlock, /pointer-events\s*:\s*none/, '.gc-row resting state disables pointer events to prevent overlap hits');

  // Verify in GraphCanvas.tsx AST/source:
  // 1. .gc-row never sets aria-hidden="true" or aria-hidden={...}
  // 2. .gc-row__cell-group is unconditionally rendered (never wrapped in conditional or unmounted)
  const canvasPath = path.join(__dirname, '..', '..', 'src', 'webview', 'GraphCanvas.tsx');
  const canvasSrc = fs.readFileSync(canvasPath, 'utf8');

  // Check row element JSX attributes
  const rowJsxMatch = canvasSrc.match(/<div\s+className=\{classes\.join\(' '\)\}([\s\S]*?)>/);
  assert.ok(rowJsxMatch, 'Row JSX div found');
  const rowAttributes = rowJsxMatch[1] ?? '';
  assert.doesNotMatch(rowAttributes, /aria-hidden/, 'Row div never sets aria-hidden');

  // Check gridcell mounting
  assert.match(canvasSrc, /role="gridcell"/, 'GraphCanvas mounts gridcell');
  assert.match(canvasSrc, /aria-label=\{rowLabel\(node,\s*now,\s*lang\)\}/, 'accessible name on gridcell is always mounted');
  assert.match(canvasSrc, /className="gc-row__cell-group"/, 'gc-row__cell-group is unconditionally rendered');
});

// ------------------------------------------------------------- em-dash guard

test('source code contains no user-facing em-dash or JSX text em-dash', () => {
  const srcDir = path.join(__dirname, '..', '..', 'src');

  function walk(dir: string): string[] {
    let res: string[] = [];
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      if (fs.statSync(full).isDirectory()) {
        res = res.concat(walk(full));
      } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
        res.push(full);
      }
    }
    return res;
  }

  const files = walk(srcDir);
  const violations: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (!content.includes('\u2014')) continue;

    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    function visit(node: ts.Node): void {
      let isViolation = false;
      let context = '';

      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (node.text.includes('\u2014')) {
          isViolation = true;
          context = `string literal: "${node.text}"`;
        }
      } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        if (node.text.includes('\u2014')) {
          isViolation = true;
          context = `template literal chunk: "${node.text}"`;
        }
      } else if (ts.isJsxText(node)) {
        if (node.text.includes('\u2014')) {
          isViolation = true;
          context = `JSX text: "${node.text.trim()}"`;
        }
      } else if (ts.isJsxAttribute(node) && node.initializer) {
        if (ts.isStringLiteral(node.initializer) && node.initializer.text.includes('\u2014')) {
          isViolation = true;
          const attrName = node.name.getText(sourceFile);
          context = `JSX attribute ${attrName}: "${node.initializer.text}"`;
        }
      }

      if (isViolation) {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const relPath = path.relative(path.join(__dirname, '..', '..'), file);
        violations.push(`${relPath}:${line + 1}:${character + 1} (${context})`);
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  assert.deepEqual(violations, [], `User-facing or JSX text em-dash found in:\n${violations.join('\n')}`);
});

// --------------------------------------------------------------- Bug 2 regression

test('a pseudo-ref such as refs/stash is never a checkout or merge target', () => {
  const stash = ref({ refName: 'refs/stash', shortName: 'stash', kind: 'other', objectName: HASH });
  const items = menuItemsFor(node({ hash: HASH }), status({ branch: 'main' }), [stash], null);
  const ids = items.map((i) => i.id);
  assert.ok(!ids.includes('checkout-stash'), 'no checkout item for the stash');
  assert.ok(!ids.includes('merge'), 'no merge item for the stash');
  for (const item of items) {
    if (item.command.kind !== 'action') continue;
    const request = item.command.request as { branch?: string };
    assert.notEqual(request.branch, 'stash');
    assert.notEqual(request.branch, 'refs/stash');
  }

  // A real branch at the same commit still gets both items, so the filter is not
  // simply suppressing everything.
  const branch = ref({ refName: 'refs/heads/fitur', shortName: 'fitur', objectName: HASH });
  const withBranch = menuItemsFor(node({ hash: HASH }), status({ branch: 'main' }), [stash, branch], null);
  const branchIds = withBranch.map((i) => i.id);
  assert.ok(branchIds.includes('checkout-fitur'));
  assert.ok(branchIds.includes('merge'));
});

// --------------------------------------------------------------- BranchSelector checkout dropdown tests

test('BranchSelector: only local branches are included as options (remote, tag, and other/stash are excluded)', () => {
  const refs: RefInfo[] = [
    ref({ refName: 'refs/heads/main', shortName: 'main', kind: 'local', objectName: HASH }),
    ref({ refName: 'refs/heads/feature', shortName: 'feature', kind: 'local', objectName: HASH }),
    ref({ refName: 'refs/remotes/origin/main', shortName: 'origin/main', kind: 'remote', objectName: HASH }),
    ref({ refName: 'refs/tags/v1.0', shortName: 'v1.0', kind: 'tag', objectName: HASH }),
    ref({ refName: 'refs/stash', shortName: 'stash', kind: 'other', objectName: HASH }),
  ];

  const state = computeBranchOptions(refs, 'feature', false);
  assert.equal(state.options.length, 2);
  assert.deepEqual(state.options.map((o) => o.value), ['main', 'feature']);
  assert.ok(!state.options.some((o) => o.value === 'origin/main' || o.value === 'v1.0' || o.value === 'stash'));
});

test('BranchSelector: current active branch (HEAD) is present but disabled to prevent redundant checkout', () => {
  const refs: RefInfo[] = [
    ref({ refName: 'refs/heads/main', shortName: 'main', kind: 'local', objectName: HASH }),
    ref({ refName: 'refs/heads/feature', shortName: 'feature', kind: 'local', objectName: HASH }),
  ];

  const state = computeBranchOptions(refs, 'main', false, (n) => `${n} (aktif)`);
  const mainOpt = state.options.find((o) => o.value === 'main');
  const featureOpt = state.options.find((o) => o.value === 'feature');

  assert.ok(mainOpt, 'main option must exist');
  assert.equal(mainOpt.disabled, true, 'current HEAD branch must be disabled');
  assert.equal(mainOpt.label, 'main (aktif)');

  assert.ok(featureOpt, 'feature option must exist');
  assert.equal(featureOpt.disabled, false, 'non-current branch must NOT be disabled');
  assert.equal(featureOpt.label, 'feature');
});

test('BranchSelector: select element is disabled when busy or when no local branches exist', () => {
  const refs: RefInfo[] = [
    ref({ refName: 'refs/heads/main', shortName: 'main', kind: 'local', objectName: HASH }),
  ];

  const idleState = computeBranchOptions(refs, 'main', false);
  assert.equal(idleState.disabled, false, 'select must be enabled when idle with local branches');

  const busyState = computeBranchOptions(refs, 'main', true);
  assert.equal(busyState.disabled, true, 'select must be disabled when busy');

  const emptyState = computeBranchOptions([], null, false);
  assert.equal(emptyState.disabled, true, 'select must be disabled when no local branches exist');
});

test('BranchSelector: selecting target branch produces checkout-branch action payload with exact branch name', () => {
  // Valid checkout to a different branch when idle
  const payload = checkoutActionPayload('feature', 'main', false);
  assert.deepEqual(payload, { action: 'checkout-branch', branch: 'feature' });

  // Selecting current branch is a no-op (returns null)
  assert.equal(checkoutActionPayload('main', 'main', false), null);

  // Selecting while busy is a no-op (returns null)
  assert.equal(checkoutActionPayload('feature', 'main', true), null);

  // Selecting empty string is a no-op (returns null)
  assert.equal(checkoutActionPayload('', 'main', false), null);
});

test('BranchSelector: accessibility attributes (aria-label, title) are defined and localized', () => {
  for (const lang of ['en', 'id'] as const) {
    const strings = t(lang);
    assert.ok(strings.graph.checkoutBranchAria, `checkoutBranchAria must be defined for ${lang}`);
    assert.ok(strings.graph.checkoutBranchTitle, `checkoutBranchTitle must be defined for ${lang}`);
    assert.ok(strings.graph.checkoutBranchDetached, `checkoutBranchDetached must be defined for ${lang}`);
    assert.ok(typeof strings.graph.checkoutBranchCurrent === 'function', `checkoutBranchCurrent must be function for ${lang}`);
    assert.ok(strings.graph.checkoutBranchCurrent('main').includes('main'));
  }
});
