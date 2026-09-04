/**
 * Synchronous File Icon Theme resolver (pure, no React, no store).
 *
 * Consumes the `IconThemeSnapshot` the host pushes over
 * `event/iconThemeChanged` (see `src/iconTheme.ts`). All matching is lowercase
 * against maps the host has already normalised, and every failure mode degrades
 * to the next precedence tier rather than to nothing, so a truncated or broken
 * theme still yields an icon whenever one exists. `undefined` = caller renders
 * the generic fallback icon.
 */
import type { IconThemeDef, IconThemeSnapshot } from '../messages';

export type ResolvedIcon =
  | { kind: 'svg'; uri: string }
  | { kind: 'glyph'; char: string; color?: string; fontId?: string; fontSize?: string };

/** Map a definition id onto a usable `ResolvedIcon`; `null` = unusable entry. */
function defToIcon(snapshot: IconThemeSnapshot, id: string | undefined): ResolvedIcon | null {
  if (id === undefined) return null;
  const def: IconThemeDef | undefined = snapshot.definitions[id];
  if (def === undefined) return null;
  if (def.iconUri !== undefined && def.iconUri.length > 0) return { kind: 'svg', uri: def.iconUri };
  if (def.fontCharacter !== undefined && def.fontCharacter.length > 0) {
    // A glyph without its own size inherits the font's declared size ("150%"
    // for Seti), so themes scale their glyphs without per-icon overrides.
    const font = snapshot.fonts.find((f) => f.id === def.fontId);
    return {
      kind: 'glyph',
      char: def.fontCharacter,
      color: def.fontColor,
      fontId: def.fontId,
      fontSize: def.fontSize ?? font?.size,
    };
  }
  // Definition with neither an image nor a glyph is dead weight; keep looking.
  return null;
}

/** File precedence: full name → longest extension → language id → default. */
export function resolveFileIcon(
  fileName: string,
  snapshot: IconThemeSnapshot | null,
): ResolvedIcon | undefined {
  if (snapshot === null) return undefined;
  const name = fileName.toLowerCase();
  if (name.length === 0) return undefined;

  // 1. Exact filename beats everything ("dockerfile", ".eslintrc.json").
  const byName = defToIcon(snapshot, snapshot.fileNames[name]);
  if (byName !== null) return byName;

  // 2. Extensions, longest first. Segment after the FIRST dot, so
  // `app.test.tsx` tries `test.tsx` then `tsx`, and `.eslintrc.json` tries
  // `eslintrc.json` then `json`. A dotfile with no second dot (`.gitignore`)
  // yields `gitignore`, which many themes really do key on.
  const dot = name.indexOf('.');
  if (dot !== -1) {
    let candidate = name.slice(dot + 1);
    while (candidate.length > 0) {
      const byExt = defToIcon(snapshot, snapshot.fileExtensions[candidate]);
      if (byExt !== null) return byExt;
      const nextDot = candidate.indexOf('.');
      if (nextDot === -1) break;
      candidate = candidate.slice(nextDot + 1);
    }
  }

  // 3. Language id, keyed by exact filename first, then by last extension.
  const lastDot = name.lastIndexOf('.');
  const extension = lastDot === -1 ? '' : name.slice(lastDot + 1);
  const lang = snapshot.languageByFilename[name] ?? snapshot.languageByExtension[extension];
  if (lang !== undefined) {
    const byLang = defToIcon(snapshot, snapshot.languageIds[lang]);
    if (byLang !== null) return byLang;
  }

  // 4. Theme default file icon.
  return defToIcon(snapshot, snapshot.file) ?? undefined;
}

/** Folder precedence: expanded name → collapsed name → default (open → closed). */
export function resolveFolderIcon(
  folderName: string,
  expanded: boolean,
  snapshot: IconThemeSnapshot | null,
): ResolvedIcon | undefined {
  if (snapshot === null) return undefined;
  const name = folderName.toLowerCase();
  if (expanded) {
    const byName = defToIcon(snapshot, snapshot.folderNamesExpanded[name]);
    if (byName !== null) return byName;
    // An open folder without a dedicated open icon falls back to the closed one.
    const byCollapsed = defToIcon(snapshot, snapshot.folderNames[name]);
    if (byCollapsed !== null) return byCollapsed;
  } else {
    const byName = defToIcon(snapshot, snapshot.folderNames[name]);
    if (byName !== null) return byName;
  }
  const byDefault = expanded
    ? defToIcon(snapshot, snapshot.folderExpanded) ?? defToIcon(snapshot, snapshot.folder)
    : defToIcon(snapshot, snapshot.folder);
  return byDefault ?? undefined;
}
