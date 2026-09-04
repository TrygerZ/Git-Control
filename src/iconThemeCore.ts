/**
 * Pure core of the file-icon-theme pipeline.
 *
 * Zero `vscode` imports on purpose: everything here takes plain data in and
 * returns plain data out, so it is unit-testable under `node:test` without a
 * vscode stub. I/O (workspace.fs, extensions registry, webview URI minting)
 * lives in `src/iconTheme.ts`.
 */
import type { IconThemeDef, IconThemeFont, IconThemeSnapshot } from './messages';

/** Mirrors `vscode.ColorThemeKind` values, kept as strings so this file stays vscode-free. */
export type ThemeKind = 'light' | 'dark' | 'highContrast' | 'highContrastLight';

/** Language id → extension/filename lookup tables, both lowercase. */
export interface LanguageIndex {
  byExtension: Record<string, string>;
  byFilename: Record<string, string>;
}

// ------------------------------------------------------------- resource caps

/**
 * Hard ceilings so a broken or hostile theme cannot freeze the extension host
 * (sync `JSON.parse` + the JSONC fallback pass transiently hold ~3x the file
 * size) or flood the webview with a huge `postMessage` payload. All published
 * themes stay far below these — Seti's JSON is < 100 KB with 1 font.
 */
/** Largest theme JSON accepted, rejected before decoding. */
export const MAX_THEME_JSON_BYTES = 5_000_000;
/** Max `iconDefinitions` entries kept; overflow is dropped, not fatal. */
export const MAX_THEME_DEFINITIONS = 10_000;
/** Max `fonts[]` entries kept; each becomes one `@font-face` rule. */
export const MAX_THEME_FONTS = 32;

// --------------------------------------------------------------- font whitelist

/**
 * H4: every font field is interpolated raw into the webview's `@font-face`
 * template, so values are whitelisted HERE, at the host, before the snapshot
 * crosses `postMessage` — the webview then never has to trust theme data.
 * `format` also lives in per-source entries (see `normalizeFonts`); the empty
 * string stays allowed because themes may omit `format` and the previous
 * behavior passed it through.
 */
const FONT_FORMATS: ReadonlySet<string> = new Set([
  '',
  'woff',
  'woff2',
  'truetype',
  'opentype',
  'embedded-opentype',
  'svg',
]);
const FONT_WEIGHTS = /^(?:[0-9]{1,3}|normal|bold)$/;
const FONT_STYLES: ReadonlySet<string> = new Set(['normal', 'italic', 'oblique']);
/** Font id lands in a CSS `font-family` name, so keep it to safe characters. */
const FONT_IDS = /^[A-Za-z0-9_-]{1,64}$/;

// ------------------------------------------------------------- fontCharacter

/**
 * Theme JSON encodes glyphs as `"\\E001"` (a literal backslash + hex in the
 * parsed string) or `"\\uea6c"`; some themes already ship the real character.
 * Returns the actual glyph character, or the input unchanged when it does not
 * match the escape form.
 */
export function parseFontCharacter(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const match = /^\\u?([0-9A-Fa-f]{3,6})$/.exec(raw);
  if (match !== null) {
    const hex = match[1];
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      // Hex-shaped input must decode to a valid Unicode scalar value or it is
      // not a glyph: above 0x10FFFF `String.fromCodePoint` throws RangeError
      // (H2), and surrogate halves 0xD800-0xDFFF are rejected too — they do
      // not throw, but they are not characters: they render as U+FFFD and are
      // lossy under UTF-8/JSON re-encoding, so the escaped form is junk either
      // way. Invalid → undefined, so the definition is treated as glyph-less.
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
      if (Number.isFinite(code)) return String.fromCodePoint(code);
    }
  }
  return raw;
}

// ------------------------------------------------------------------- parsing

/**
 * `JSON.parse` with a JSONC fallback: some theme files carry `//` and `/* *\/`
 * comments. Returns `undefined` (never throws) when both attempts fail.
 */
export function parseThemeJsonText(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the comment-stripping pass.
  }
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    return undefined;
  }
}

/** Remove `//` and `/* *\/` comments without touching their contents inside strings. */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    const next = text[i + 1];
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n'; // keep line numbers meaningful for whoever debugs the file
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // loop's own i++ lands after the closing '/'
    } else {
      out += ch;
    }
  }
  return out;
}

// -------------------------------------------------------------- normalization

/** `{ key: value }` with string values only and lowercased keys; junk in → `{}` out. */
export function normalizeStringMap(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
  }
  return out;
}

// ------------------------------------------------------------ path traversal

/**
 * True when `target` (already resolved by the caller) stays inside `root`.
 * Both are URI paths (`/`-separated). Case-insensitive: Windows/remote drive
 * casing must not slip a path past the check.
 */
export function isWithin(root: string, target: string): boolean {
  const segments = (p: string): string[] =>
    p.split(/[\\/]/).filter((s) => s.length > 0 && s !== '.');
  const rootSegs = segments(root);
  const targetSegs = segments(target);
  // Resolve any `..` the caller left in; escaping above the root fails closed.
  const resolved: string[] = [];
  for (const seg of targetSegs) {
    if (seg === '..') {
      if (resolved.length === 0) return false;
      resolved.pop();
      continue;
    }
    resolved.push(seg);
  }
  if (resolved.length < rootSegs.length) return false;
  for (let i = 0; i < rootSegs.length; i++) {
    const r = rootSegs[i];
    const t = resolved[i];
    if (r === undefined || t === undefined || r.toLowerCase() !== t.toLowerCase()) return false;
  }
  return true;
}

// ------------------------------------------------------------- language index

/**
 * Build lookup tables from `contributes.languages[]` entries across all
 * extensions. Malformed entries are skipped; first contribution wins for
 * duplicate extensions/filenames so the result is deterministic.
 */
export function buildLanguageIndex(contributions: readonly unknown[]): LanguageIndex {
  const byExtension: Record<string, string> = {};
  const byFilename: Record<string, string> = {};
  for (const entry of contributions) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : undefined;
    if (id === undefined || id.length === 0) continue;
    if (Array.isArray(rec.extensions)) {
      for (const ext of rec.extensions) {
        if (typeof ext !== 'string') continue;
        const key = ext.replace(/^\./, '').toLowerCase();
        if (key.length > 0 && byExtension[key] === undefined) byExtension[key] = id;
      }
    }
    if (Array.isArray(rec.filenames)) {
      for (const name of rec.filenames) {
        if (typeof name !== 'string') continue;
        const key = name.toLowerCase();
        if (key.length > 0 && byFilename[key] === undefined) byFilename[key] = id;
      }
    }
  }
  return { byExtension, byFilename };
}

// ---------------------------------------------------------------- assembler

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDef(
  raw: unknown,
  resolveAsset: (relPath: string) => string | undefined,
): IconThemeDef | undefined {
  if (!isObject(raw)) return undefined;
  const def: IconThemeDef = {};
  if (typeof raw.iconPath === 'string' && raw.iconPath.length > 0) {
    const iconUri = resolveAsset(raw.iconPath);
    if (iconUri !== undefined) def.iconUri = iconUri;
  }
  const fontCharacter = parseFontCharacter(raw.fontCharacter);
  if (fontCharacter !== undefined) def.fontCharacter = fontCharacter;
  if (typeof raw.fontColor === 'string') def.fontColor = raw.fontColor;
  if (typeof raw.fontId === 'string') def.fontId = raw.fontId;
  if (typeof raw.fontSize === 'string') def.fontSize = raw.fontSize;
  return def;
}

/**
 * H4 whitelist for one raw font entry. Every field here reaches the webview's
 * CSS template (or its `font-family` lookup) verbatim, so anything outside the
 * whitelist drops the whole font entry — no escaping, no pass-through.
 */
function isAllowedFont(entry: Record<string, unknown>): entry is Record<string, unknown> & { id: string } {
  if (typeof entry.id !== 'string' || !FONT_IDS.test(entry.id)) return false;
  // Non-string weight/style mean the theme JSON is not the shape themes ship;
  // the webview template interpolates these verbatim, so drop, don't coerce.
  if (entry.weight !== undefined && (typeof entry.weight !== 'string' || !FONT_WEIGHTS.test(entry.weight))) return false;
  if (entry.style !== undefined && (typeof entry.style !== 'string' || !FONT_STYLES.has(entry.style))) return false;
  for (const source of Array.isArray(entry.src) ? entry.src : []) {
    if (
      isObject(source) &&
      typeof source.format === 'string' &&
      !FONT_FORMATS.has(source.format)
    ) {
      return false;
    }
  }
  return true;
}

function normalizeFonts(
  raw: unknown,
  resolveAsset: (relPath: string) => string | undefined,
): IconThemeFont[] {
  if (!Array.isArray(raw)) return [];
  const fonts: IconThemeFont[] = [];
  for (const entry of raw) {
    if (fonts.length >= MAX_THEME_FONTS) break; // H5: cap @font-face rules
    if (!isObject(entry) || !isAllowedFont(entry)) continue;
    const id = entry.id;
    const src = entry.src;
    if (!Array.isArray(src)) continue;
    for (const source of src) {
      if (!isObject(source)) continue;
      const path = source.path;
      const format = source.format;
      if (typeof path !== 'string' || path.length === 0) continue;
      const srcUri = resolveAsset(path);
      if (srcUri === undefined) continue;
      const font: IconThemeFont = { id, srcUri, format: typeof format === 'string' ? format : '' };
      if (typeof entry.weight === 'string') font.weight = entry.weight;
      if (typeof entry.style === 'string') font.style = entry.style;
      if (typeof entry.size === 'string') font.size = entry.size;
      fonts.push(font);
      break; // first usable source wins; a font with several srcs still yields one @font-face
    }
  }
  return fonts;
}

/**
 * Turn a parsed theme document (+ its `light`/`highContrast` overlay) into the
 * serializable snapshot. `resolveAsset` resolves a JSON-relative path to a
 * webview URI, or `undefined` when the path must be rejected (traversal, read
 * failure). Overlay merge is shallow **per map** — `{...base, ...overlay}` —
 * never a whole-document replace.
 */
export function assembleSnapshot(
  doc: unknown,
  themeId: string,
  kind: ThemeKind,
  resolveAsset: (relPath: string) => string | undefined,
  languages: LanguageIndex,
): IconThemeSnapshot | undefined {
  if (!isObject(doc)) return undefined;

  // Overlay selection: light → `light`; HC dark → `highContrast` if present;
  // HC light → `highContrast` if present, else `light`; dark → none.
  let overlay: Record<string, unknown> | undefined;
  if (kind === 'light') overlay = isObject(doc.light) ? doc.light : undefined;
  else if (kind === 'dark') overlay = undefined;
  else if (isObject(doc.highContrast)) overlay = doc.highContrast;
  else if (kind === 'highContrastLight') overlay = isObject(doc.light) ? doc.light : undefined;

  const mergedMap = (key: string): Record<string, string> => ({
    ...normalizeStringMap(doc[key]),
    ...normalizeStringMap(overlay?.[key]),
  });

  const mergedDefsRaw: Record<string, unknown> = {
    ...normalizeStringMapKeysOnly(doc.iconDefinitions),
    ...normalizeStringMapKeysOnly(overlay?.iconDefinitions),
  };
  // H6: null prototype — a theme key `"__proto__"` must set an own data
  // property here, never trigger the inherited setter and repoint this
  // object's [[Prototype]] at a theme-controlled definition.
  const definitions: Record<string, IconThemeDef> = Object.create(null) as Record<string, IconThemeDef>;
  let definitionCount = 0;
  for (const [key, raw] of Object.entries(mergedDefsRaw)) {
    if (definitionCount >= MAX_THEME_DEFINITIONS) break; // H5: cap, not fatal
    const def = normalizeDef(raw, resolveAsset);
    if (def !== undefined) {
      definitions[key] = def;
      definitionCount++;
    }
  }

  const mergedFileExtensions = mergedMap('fileExtensions');
  const mergedFileNames = mergedMap('fileNames');
  const mergedFolderNames = mergedMap('folderNames');
  const mergedFolderNamesExpanded = mergedMap('folderNamesExpanded');
  const mergedLanguageIds = mergedMap('languageIds');

  const pickString = (key: string): string | undefined => {
    const fromOverlay = overlay?.[key];
    if (typeof fromOverlay === 'string') return fromOverlay;
    const fromBase = doc[key];
    return typeof fromBase === 'string' ? fromBase : undefined;
  };

  const hidesBase = doc.hidesExplorerArrows === true;
  const hidesOverlay = overlay?.hidesExplorerArrows === true;

  return {
    themeId,
    definitions,
    file: pickString('file'),
    folder: pickString('folder'),
    folderExpanded: pickString('folderExpanded'),
    fileExtensions: mergedFileExtensions,
    fileNames: mergedFileNames,
    folderNames: mergedFolderNames,
    folderNamesExpanded: mergedFolderNamesExpanded,
    languageIds: mergedLanguageIds,
    languageByExtension: languages.byExtension,
    languageByFilename: languages.byFilename,
    fonts: normalizeFonts(overlay?.fonts ?? doc.fonts, resolveAsset),
    hidesExplorerArrows: hidesBase || hidesOverlay,
  };
}

/**
 * Key-preserving map copy used for `iconDefinitions` (ids are matched
 * verbatim, so unlike the user-facing maps their keys are NOT lowercased).
 * Non-object input → `{}`.
 */
function normalizeStringMapKeysOnly(raw: unknown): Record<string, unknown> {
  return isObject(raw) ? { ...raw } : {};
}

/**
 * `assembleSnapshot` with a fail-closed contract: any internal throw (e.g. an
 * injected `resolveAsset` that misbehaves) becomes `undefined`. The host's
 * async watcher has no catch around this call, so the exception must die here
 * (H2). Separated from `assembleSnapshot` so the never-throw guarantee is
 * testable without the `vscode` API.
 */
export function tryAssembleSnapshot(
  doc: unknown,
  themeId: string,
  kind: ThemeKind,
  resolveAsset: (relPath: string) => string | undefined,
  languages: LanguageIndex,
): IconThemeSnapshot | undefined {
  try {
    return assembleSnapshot(doc, themeId, kind, resolveAsset, languages);
  } catch {
    return undefined;
  }
}
