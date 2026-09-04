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
  MAX_THEME_DEFINITIONS,
  MAX_THEME_FONTS,
  MAX_THEME_JSON_BYTES,
  assembleSnapshot,
  buildLanguageIndex,
  isWithin,
  normalizeStringMap,
  parseFontCharacter,
  parseThemeJsonText,
  tryAssembleSnapshot,
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

// H2: hex-shaped input above the Unicode max must not throw (RangeError) — the
// definition is treated as glyph-less instead.
test('fontCharacter rejects code points above 0x10FFFF without throwing', () => {
  assert.equal(parseFontCharacter('\\FFFFFF'), undefined); // 0xFFFFFF > 0x10FFFF
  assert.equal(parseFontCharacter('\\110000'), undefined); // one past the max
  assert.equal(parseFontCharacter('\\10FFFF'), '\u{10FFFF}'); // boundary itself stays valid
  assert.equal(parseFontCharacter('\\0FFFFF'), '\u{FFFFF}');
});

// H2 (decision c): surrogate halves are not characters — they render as U+FFFD
// and are lossy under UTF-8/JSON re-encoding — so the escaped form is rejected.
test('fontCharacter rejects lone surrogate halves', () => {
  assert.equal(parseFontCharacter('\\D800'), undefined);
  assert.equal(parseFontCharacter('\\DFFF'), undefined);
  assert.equal(parseFontCharacter('\\D7FF'), '\u{D7FF}'); // just below the range
  assert.equal(parseFontCharacter('\\E000'), '\u{E000}'); // just above it
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

// QA item: `HighContrastLight` when a theme carries BOTH a `highContrast` and a
// `light` overlay was flagged as an unclear requirement. Locked behavior: the
// `highContrast` overlay WINS for HC-light themes — the HC variant of a theme
// is the author's deliberate contrast tuning, so it must beat the generic
// light overlay. This test exists so the precedence cannot change silently.
test('highContrastLight prefers the highContrast overlay over light when both exist', () => {
  const both = {
    ...baseDoc(),
    light: { fileExtensions: { asm: '_light' } },
    highContrast: { fileExtensions: { asm: '_hc' } },
  };
  const snap = assembleSnapshot(both, 'test', 'highContrastLight', NO_ASSETS, LANGS);
  assert.ok(snap !== undefined);
  assert.equal(snap.fileExtensions['asm'], '_hc');
  // Same precedence for fonts: HC overlay wins as a whole overlay document.
  const fontDoc = {
    light: { fonts: [{ id: 'light-font', src: [{ path: './l.woff', format: 'woff' }] }] },
    highContrast: { fonts: [{ id: 'hc-font', src: [{ path: './h.woff', format: 'woff' }] }] },
    iconDefinitions: {},
  };
  const snapFonts = assembleSnapshot(fontDoc, 't', 'highContrastLight', (p) => `u:${p}`, LANGS);
  assert.ok(snapFonts !== undefined);
  assert.deepEqual(
    snapFonts.fonts.map((f) => f.id),
    ['hc-font'],
  );
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

// ------------------------------------------------- hardening (H2/H4/H5)

// H2: the whole snapshot build must be fail-closed — an internal throw becomes
// `undefined`, never an exception reaching the async watcher caller.
test('tryAssembleSnapshot swallows internal throws into undefined', () => {
  const boom = (): string | undefined => {
    throw new Error('resolver exploded');
  };
  const doc = { iconDefinitions: { a: { iconPath: './x.svg' } } };
  assert.equal(tryAssembleSnapshot(doc, 't', 'dark', boom, LANGS), undefined);
  assert.doesNotThrow(() => tryAssembleSnapshot(doc, 't', 'dark', boom, LANGS));
});

// H4: font fields reach the webview CSS verbatim, so anything outside the
// whitelist drops the whole font entry; valid values pass unchanged.
test('font whitelist drops entries with hostile or malformed fields', () => {
  const doc = {
    fonts: [
      { id: 'ok', src: [{ path: './a.woff', format: 'woff' }] },
      { id: 'evil", x:', src: [{ path: './b.woff', format: 'woff' }] }, // id breaks out of the CSS string
      { id: 'ok', src: [{ path: './c.woff', format: "x');} *{background:url(//evil)} /*" }] }, // format injection
      { id: 'ok', src: [{ path: './d.woff', format: 'woff' }], weight: '900);}' }, // weight injection
      { id: 'ok', src: [{ path: './e.woff', format: 'woff' }], style: 'italic; content:url(x)' }, // style injection
      { id: 'ok', weight: 700, src: [{ path: './f.woff', format: 'woff' }] }, // non-string weight → entry dropped
      { id: '', src: [{ path: './g.woff', format: 'woff' }] }, // empty id unusable as font-family
      { id: 'x'.repeat(65), src: [{ path: './h.woff', format: 'woff' }] }, // over the 64-char cap
    ],
    iconDefinitions: {},
  };
  const snap = assembleSnapshot(doc, 't', 'dark', (p) => `u:${p}`, LANGS);
  assert.ok(snap !== undefined);
  assert.deepEqual(
    snap.fonts.map((f) => f.id),
    ['ok'],
  );
  assert.equal(snap.fonts[0]?.srcUri, 'u:./a.woff');
});

test('font whitelist accepts every documented format, weight, and style', () => {
  const formats = ['woff', 'woff2', 'truetype', 'opentype', 'embedded-opentype', 'svg', ''];
  const doc = {
    fonts: formats.map((format, i) => ({ id: `f${i}`, src: [{ path: `./a.${i}`, format }] })),
    iconDefinitions: {},
  };
  const snap = assembleSnapshot(doc, 't', 'dark', (p) => `u:${p}`, LANGS);
  assert.ok(snap !== undefined);
  assert.equal(snap.fonts.length, formats.length);
  const styled = {
    fonts: [
      { id: 'bold-italic', src: [{ path: './a', format: 'woff2' }], weight: 'bold', style: 'italic' },
      { id: 'numeric', src: [{ path: './b', format: 'woff2' }], weight: '300' },
      { id: 'oblique', src: [{ path: './c', format: 'woff2' }], style: 'oblique' },
    ],
    iconDefinitions: {},
  };
  const snap2 = assembleSnapshot(styled, 't', 'dark', (p) => `u:${p}`, LANGS);
  assert.ok(snap2 !== undefined);
  assert.equal(snap2.fonts.length, 3);
  assert.equal(snap2.fonts[0]?.weight, 'bold');
  assert.equal(snap2.fonts[1]?.weight, '300');
  assert.equal(snap2.fonts[2]?.style, 'oblique');
});

// H5: oversized inputs are capped, not fatal — a large but legitimate theme
// keeps working with the overflow dropped.
test('definition and font counts are capped without failing the snapshot', () => {
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < MAX_THEME_DEFINITIONS + 500; i++) defs[`d${i}`] = { fontCharacter: '\\E001' };
  const fonts = Array.from({ length: MAX_THEME_FONTS + 10 }, (_, i) => ({
    id: `f${i}`,
    src: [{ path: `./f${i}.woff`, format: 'woff' }],
  }));
  const snap = assembleSnapshot({ iconDefinitions: defs, fonts }, 't', 'dark', (p) => `u:${p}`, LANGS);
  assert.ok(snap !== undefined);
  assert.equal(Object.keys(snap.definitions).length, MAX_THEME_DEFINITIONS);
  assert.equal(snap.fonts.length, MAX_THEME_FONTS);
});

// H5: constants exist so the caps are pinned; the byte limit itself is enforced
// in `src/iconTheme.ts` before decode (I/O layer, covered by integration).
test('resource caps are exported with their documented values', () => {
  assert.equal(MAX_THEME_JSON_BYTES, 5_000_000);
  assert.equal(MAX_THEME_DEFINITIONS, 10_000);
  assert.equal(MAX_THEME_FONTS, 32);
});

// H5 side effect: the definitions cap must not silently kill the theme default
// when the theme is within limits — a normal small theme keeps everything.
test('small themes keep every definition', () => {
  const snap = assembleSnapshot(baseDoc(), 't', 'dark', NO_ASSETS, LANGS);
  assert.ok(snap !== undefined);
  assert.equal(Object.keys(snap.definitions).length, 2);
});

// ------------------------------------------------------------ prototype keys

// H6 (write side): a theme key `"__proto__"` must become an own data property,
// never repoint the definitions object's [[Prototype]]. The key arrives as an
// own property (JSON.parse of the theme file defines it), so the fixture is
// built the same way — a literal `{ __proto__: x }` would only set the fixture
// object's own prototype and test nothing.
test('__proto__ as a definition key stays own data, not prototype mutation', () => {
  const iconDefinitions: Record<string, unknown> = JSON.parse(
    '{"__proto__": {"fontCharacter": "\\\\E001"}, "_real": {"fontCharacter": "\\\\E002"}}',
  );
  assert.equal(Object.hasOwn(iconDefinitions, '__proto__'), true); // fixture is the real shape
  const snap = assembleSnapshot({ iconDefinitions }, 't', 'dark', NO_ASSETS, LANGS);
  assert.ok(snap !== undefined);
  assert.equal(Object.getPrototypeOf(snap.definitions), null);
  const def = Object.hasOwn(snap.definitions, '__proto__') ? snap.definitions['__proto__'] : undefined;
  assert.ok(def !== undefined);
  assert.equal(def.fontCharacter, '\uE001');
  assert.equal(snap.definitions['_real']?.fontCharacter, '\uE002');
});
