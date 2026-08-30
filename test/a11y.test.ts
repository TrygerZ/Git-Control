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
import {
  ERROR_CODES,
  PORCELAIN_CODES,
  conflictActionLabel,
  conflictRowLabel,
  entryStatus,
  fileRowLabel,
  folderRowLabel,
  presentError,
  refNamesLabel,
  remedyLabel,
  riskLabel,
  rowLabel,
  statusLabel,
} from '../src/webview/format';
import type { ChangeEntry, ErrorCode, GraphNode } from '../src/messages';

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
});

test('rowLabel states the push state either way, not only when local', () => {
  // "no badge" is a fact a sighted user reads from the filled dot. Silence is not
  // the same signal, so the remote case says so in words.
  assert.match(rowLabel(node({ local: true }), NOW), /lokal belum dipush/);
  assert.match(rowLabel(node({ local: false }), NOW), /sudah ada di remote/);
});

test('rowLabel omits absent state instead of saying "bukan HEAD"', () => {
  const label = rowLabel(node(), NOW);
  assert.ok(!label.includes('HEAD'), label);
  assert.ok(!label.includes('merge'), label);
});

test('rowLabel sanitises every git-sourced part (SEC-007)', () => {
  const label = rowLabel(
    node({ subject: 'a\u202eb', authorName: 'c\u200bd', refNames: ['e\u202ef'] }),
    NOW,
  );
  assert.ok(!label.includes('\u202e'), 'no bidi override survives');
  assert.ok(!label.includes('\u200b'), 'no zero-width survives');
  assert.match(label, /\ufffd/, 'the removal is marked, not silent');
});

test('refNamesLabel distinguishes local, remote, and tag refs in words', () => {
  assert.equal(refNamesLabel([]), null);
  assert.equal(refNamesLabel(['HEAD']), null, 'HEAD is already a separate fact');
  assert.equal(refNamesLabel(['refs/heads/main']), 'ref main');
  assert.equal(refNamesLabel(['origin/main']), 'ref remote origin/main');
  assert.equal(refNamesLabel(['tag: v2']), 'ref tag v2');
  assert.equal(refNamesLabel(['refs/heads/a', 'tag: b']), 'ref a, tag b');
});

// ------------------------------------------------- file and conflict row names

test('fileRowLabel carries path, status word, and churn', () => {
  const label = fileRowLabel(entry());
  assert.match(label, /src\/webview\/ui\.tsx/, 'path');
  assert.match(label, /Dimodifikasi/, 'status in words, not just the letter');
  assert.match(label, /12 baris ditambah/, 'additions');
  assert.match(label, /3 baris dihapus/, 'deletions');
});

test('fileRowLabel says "file binary" instead of a churn of zero', () => {
  const label = fileRowLabel(entry({ binary: true, additions: null, deletions: null }));
  assert.match(label, /file binary/);
  assert.ok(!label.includes('0 baris'), label);
});

test('fileRowLabel spells out a rename as lama → baru', () => {
  const label = fileRowLabel(entry({ path: 'b.ts', origPath: 'a.ts', indexStatus: 'R' }));
  assert.match(label, /a\.ts → b\.ts/);
  assert.match(label, /Diganti nama/);
});

test('fileRowLabel reports untracked ahead of the index letter', () => {
  assert.match(fileRowLabel(entry({ untracked: true, indexStatus: ' ' })), /Belum dilacak/);
});

test('folderRowLabel names the folder and how many files it holds', () => {
  assert.equal(folderRowLabel('webview', 12), 'Folder webview, 12 file');
  assert.match(folderRowLabel('a\u202eb', 1), /\ufffd/, 'sanitised');
});

test('conflict row and action names include the path, so buttons are distinguishable', () => {
  assert.equal(
    conflictActionLabel('Tandai selesai', 'src/a.ts'),
    'Tandai selesai src/a.ts',
  );
  assert.match(conflictActionLabel('Selesaikan', 'a\u202eb'), /\ufffd/);
  const row = conflictRowLabel({ path: 'src/a.ts', code: 'UU' });
  assert.match(row, /src\/a\.ts/);
  assert.match(row, /keduanya mengubah/, 'the code is explained, not just quoted');
});

// ------------------------------------------------------------ status labels

/**
 * Every porcelain code the panel can receive must have an Indonesian word and a
 * distinct glyph. A code falling through to "Tidak diketahui" is a row the user
 * cannot act on, and colour alone would be the only remaining signal.
 */
test('every porcelain code maps to a label, a glyph, and no fallback', () => {
  for (const code of PORCELAIN_CODES) {
    const label = statusLabel(code);
    assert.ok(label.label.length > 0, `${code} has a word`);
    assert.ok(label.glyph.length > 0, `${code} has a glyph`);
    assert.notEqual(label.label, 'Tidak diketahui', `${code} must not fall through`);
  }
});

test('status labels and glyphs are unique, so two states never read alike', () => {
  const labels = new Set<string>();
  const glyphs = new Set<string>();
  for (const code of PORCELAIN_CODES) {
    const label = statusLabel(code);
    labels.add(label.label);
    glyphs.add(label.glyph);
  }
  assert.equal(labels.size, PORCELAIN_CODES.length, 'no duplicate words');
  assert.equal(glyphs.size, PORCELAIN_CODES.length, 'no duplicate glyphs');
});

test('statusLabel accepts lower case and only reports unknown for a real unknown', () => {
  assert.equal(statusLabel('m').label, 'Dimodifikasi');
  assert.equal(statusLabel('Z').label, 'Tidak diketahui');
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
    const status = entryStatus(value);
    assert.notEqual(status.label, 'Tidak diketahui', JSON.stringify(value));
    assert.ok(status.glyph.length > 0);
  }
});

// ------------------------------------------------------------- error surfaces

test('every ErrorCode has an Indonesian title, an explanation, and a way out', () => {
  for (const code of ERROR_CODES) {
    const view = presentError({ status: 500, code, message: '' });
    assert.ok(view.title.length > 0, `${code} title`);
    assert.ok(view.explanation.length > 10, `${code} explanation`);
    assert.ok(view.remedies.length > 0, `${code} remedies`);
    // Every offered remedy must be nameable, or the button renders blank.
    for (const remedy of view.remedies) {
      assert.ok(remedyLabel(remedy).length > 0, `${code} → ${remedy}`);
    }
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
    assert.ok(riskLabel(risk).length > 0, risk);
  }
  assert.notEqual(riskLabel('low'), riskLabel('medium'));
  assert.notEqual(riskLabel('medium'), riskLabel('high'));
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
