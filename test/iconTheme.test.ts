/**
 * Pure-core tests for the icon theme pipeline (`src/iconThemeCore.ts`).
 *
 * Everything here runs without the `vscode` API: the core takes plain data in
 * and returns plain data out. The vscode glue (`src/iconTheme.ts`) is covered
 * by the integration runner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleSnapshot,
  buildLanguageIndex,
  isWithin,
  normalizeStringMap,
  parseFontCharacter,
  parseThemeJsonText,
} from '../src/iconThemeCore';

const NO_ASSETS = (): string | undefined => undefined;
const LANGS = { byExtension: {}, byFilename: {} };

// ------------------------------------------------------------- fontCharacter

test('fontCharacter "\\E001" unescapes to the real glyph U+E001', () => {
  assert.equal(parseFontCharacter('\\E001'), '\uE001');
});

test('fontCharacter accepts lowercase hex and the \\u escape form', () => {
  assert.equal(parseFontCharacter('\\ea6c'), '\uEA6C');
  assert.equal(parseFontCharacter('\\uE005'), '\uE005');
});

test('fontCharacter passes through literal characters unchanged', () => {
  assert.equal(parseFontCharacter('●'), '●');
});

test('fontCharacter rejects junk shapes', () => {
  assert.equal(parseFontCharacter('\\ZZZZ'), '\\ZZZZ'); // not hex-shaped → passthrough
  assert.equal(parseFontCharacter(''), undefined);
  assert.equal(parseFontCharacter(42), undefined);
  assert.equal(parseFontCharacter(undefined), undefined);
});

// ------------------------------------------------------------------- merging

function baseDoc(): Record<string, unknown> {
  return {
    file: '_file.svg',
    iconDefinitions: {
      _default: { fontCharacter: '\\E001', fontColor: '#111111' },
      _extra: { iconPath: './icons/extra.svg' },
    },
    fileExtensions: { asm: '_asm', cls: '_salesforce' },
    fileNames: { 'makefile': '_makefile' },
  };
}

test('light overlay merges per map, not per document', () => {
  const doc = {
    ...baseDoc(),
    light: {
      iconDefinitions: { _default: { fontCharacter: '\\E002' } },
      fileExtensions: { asm: '_asm_light' },
    },
  };
  const snap = assembleSnapshot(doc, 'test', 'light', NO_ASSETS, LANGS);
  assert.ok(snap !== undefined);
  // Per-map merge: keys absent from the overlay survive from the base.
  assert.deepEqual(snap.fileExtensions, { asm: '_asm_light', cls: '_salesforce' });
  assert.deepEqual(snap.fileNames, { 'makefile': '_makefile' });
  // iconDefinitions merges too; overlay only overrides the key it names.
  assert.equal(snap.definitions['_default']?.fontCharacter, '\uE002');
  assert.ok(snap.definitions['_extra'] !== undefined);
  assert.equal(snap.definitions['_extra']?.iconUri, undefined); // resolver rejected path
});

test('dark kind applies no overlay', () => {
  const doc = { ...baseDoc(), light: { fileExtensions: { asm: '_light' } } };
  const snap = assembleSnapshot(doc, 'test', 'dark', NO_ASSETS, LANGS);
  assert.ok(snap !== undefined);
  assert.deepEqual(snap.fileExtensions, { asm: '_asm', cls: '_salesforce' });
});

test('highContrast prefers highContrast overlay, falls back to light for HC-light', () => {
  const hc = { ...baseDoc(), light: { fileExtensions: { asm: '_light' } }, highContrast: { fileExtensions: { asm: '_hc' } } };
  const snapHc = assembleSnapshot(hc, 'test', 'highContrast', NO_ASSETS, LANGS);
  assert.ok(snapHc !== undefined);
  assert.equal(snapHc.fileExtensions['asm'], '_hc');

  const noHc = { ...baseDoc(), light: { fileExtensions: { asm: '_light' } } };
  const snapHcLight = assembleSnapshot(noHc, 'test', 'highContrastLight', NO_ASSETS, LANGS);
  assert.ok(snapHcLight !== undefined);
  assert.equal(snapHcLight.fileExtensions['asm'], '_light');
});

test('hidesExplorerArrows is true when either base or overlay sets it', () => {
  const snap = assembleSnapshot({ ...baseDoc(), light: { hidesExplorerArrows: true } }, 't', 'light', NO_ASSETS, LANGS);
  assert.equal(snap?.hidesExplorerArrows, true);
  const off = assembleSnapshot(baseDoc(), 't', 'dark', NO_ASSETS, LANGS);
  assert.equal(off?.hidesExplorerArrows, false);
});

// --------------------------------------------------------------- lowercase keys

test('user-facing map keys are lowercased; definition keys are not', () => {
  const doc = {
    iconDefinitions: { '_Default': { fontCharacter: '\\E001' } },
    fileExtensions: { ASM: '_asm', TsX: '_react' },
    fileNames: { 'Dockerfile': '_docker' },
    folderNames: { 'SRC': '_folder_src' },
    folderNamesExpanded: { 'SRC': '_folder_src_open' },
    languageIds: { 'TypeScript': '_ts' },
  };
  const snap = assembleSnapshot(doc, 't', 'dark', NO_ASSETS, LANGS);
  assert.ok(snap !== undefined);
  assert.deepEqual(snap.fileExtensions, { asm: '_asm', tsx: '_react' });
  assert.deepEqual(snap.fileNames, { 'dockerfile': '_docker' });
  assert.deepEqual(snap.folderNames, { 'src': '_folder_src' });
  assert.deepEqual(snap.folderNamesExpanded, { 'src': '_folder_src_open' });
  assert.deepEqual(snap.languageIds, { 'typescript': '_ts' });
  // Definition ids keep their case — the maps reference them verbatim.
  assert.ok(snap.definitions['_Default'] !== undefined);
});

test('normalizeStringMap drops non-string values', () => {
  assert.deepEqual(normalizeStringMap({ a: 'x', b: 3, c: null }), { a: 'x' });
  assert.deepEqual(normalizeStringMap('nope'), {});
  assert.deepEqual(normalizeStringMap(null), {});
  assert.deepEqual(normalizeStringMap(['x']), {});
});

// ------------------------------------------------------------------- traversal

test('isWithin accepts containment and rejects traversal with .. or sibling prefixes', () => {
  const root = '/ext';
  assert.equal(isWithin(root, '/ext/icons/a.svg'), true);
  assert.equal(isWithin(root, '/ext/a.svg'), true);
  assert.equal(isWithin(root, '/ext/../evil.svg'), false); // joinPath collapses first
  assert.equal(isWithin(root, '/evil.svg'), false);
  assert.equal(isWithin('/ext', '/extension/evil.svg'), false); // sibling-prefix trap
});

test('isWithin is case-insensitive', () => {
  assert.equal(isWithin('/Ext', '/ext/icons/a.svg'), true);
  assert.equal(isWithin('/C:/Ext', '/c:/ext/a.svg'), true);
});

// --------------------------------------------------------------- parse errors

test('unparseable theme text returns undefined instead of throwing', () => {
  assert.equal(parseThemeJsonText('not json {'), undefined);
  assert.equal(parseThemeJsonText('{broken:'), undefined);
});

test('JSONC with // and /* */ comments parses', () => {
  const jsonc = [
    '{',
    '  // line comment',
    '  "file": "_file",',
    '  /* block',
    '     comment */',
    '  "fonts": [{ "id": "f", "src": [{ "path": "http://x/y.woff" /* inline */, "format": "woff" }] }]',
    '}',
  ].join('\n');
  const doc = parseThemeJsonText(jsonc);
  assert.ok(doc !== undefined);
  const fonts = (doc as { fonts?: Array<{ id?: string }> }).fonts;
  assert.equal(fonts?.[0]?.id, 'f');
});

test('JSONC strip preserves comment markers inside string values', () => {
  const doc = parseThemeJsonText('{"fileExtensions": {"url": "_url//not-a-comment"}}');
  assert.ok(doc !== undefined);
  const map = (doc as { fileExtensions?: Record<string, string> }).fileExtensions;
  assert.equal(map?.['url'], '_url//not-a-comment');
});

// ---------------------------------------------------------- malformed inputs

test('assembleSnapshot with malformed document returns undefined, never crashes', () => {
  assert.equal(assembleSnapshot(undefined, 't', 'dark', NO_ASSETS, LANGS), undefined);
  assert.equal(assembleSnapshot('nope', 't', 'dark', NO_ASSETS, LANGS), undefined);
  assert.equal(assembleSnapshot([1, 2], 't', 'dark', NO_ASSETS, LANGS), undefined);
});

test('malformed packageJSON contributions yield an empty language index', () => {
  const idx = buildLanguageIndex([
    undefined,
    null,
    42,
    'nope',
    {},
    { id: 'typescript' }, // no extensions/filenames
    { extensions: ['.ts'] }, // no id
    { id: 'typescript', extensions: ['.TS', 'tsx'], filenames: ['Dockerfile', ''] },
    { id: 'javascript', extensions: ['.ts'] }, // duplicate: first wins
  ]);
  assert.deepEqual(idx.byExtension, { ts: 'typescript', tsx: 'typescript' });
  assert.deepEqual(idx.byFilename, { dockerfile: 'typescript' });
});

test('fonts with malformed src entries are skipped; first usable source wins', () => {
  const doc = {
    fonts: [
      { src: [{ path: './a.woff', format: 'woff' }] }, // no id → skipped
      { id: 'ok', src: [{ path: './b.woff', format: 'woff' }, { path: './c.ttf', format: 'truetype' }] },
      { id: 'badpath', src: [{ format: 'woff' }] }, // no path → skipped
    ],
    iconDefinitions: {},
  };
  const snap = assembleSnapshot(doc, 't', 'dark', (p) => `vscode-webview://x/${p}`, LANGS);
  assert.ok(snap !== undefined);
  assert.equal(snap.fonts.length, 1);
  assert.equal(snap.fonts[0]?.id, 'ok');
  assert.equal(snap.fonts[0]?.srcUri, 'vscode-webview://x/./b.woff');
});

test('asset resolver rejections produce definitions without iconUri, not crashes', () => {
  const doc = {
    iconDefinitions: {
      a: { iconPath: './ok.svg' },
      b: { iconPath: '../../evil.svg' },
      c: { iconPath: 42 }, // wrong type
    },
  };
  const snap = assembleSnapshot(doc, 't', 'dark', (p) => (p.includes('evil') ? undefined : `u:${p}`), LANGS);
  assert.ok(snap !== undefined);
  assert.equal(snap.definitions['a']?.iconUri, 'u:./ok.svg');
  assert.equal(snap.definitions['b']?.iconUri, undefined);
  assert.equal(snap.definitions['c']?.iconUri, undefined);
});
