/**
 * Extension-host side of the File Icon Theme pipeline.
 *
 * Reads the active file icon theme (JSON, possibly JSONC), merges the
 * light/highContrast overlay, resolves every referenced asset to a webview URI
 * and produces the serializable snapshot from `src/messages.ts`. The pure
 * logic lives in `src/iconThemeCore.ts` so it stays unit-testable.
 *
 * File access is `vscode.workspace.fs` + `vscode.Uri.joinPath` ONLY — no node
 * `fs`, no `path.resolve`, no `extensionPath`. The URIs involved may carry
 * `vscode-remote:`/`vscode-vfs:` schemes where node APIs do not exist.
 */
import * as vscode from 'vscode';
import {
  assembleSnapshot,
  buildLanguageIndex,
  isWithin,
  parseThemeJsonText,
  type LanguageIndex,
  type ThemeKind,
} from './iconThemeCore';
import type { IconThemeSnapshot } from './messages';

export interface ActiveIconTheme {
  extensionUri: vscode.Uri;
  themeJsonUri: vscode.Uri;
  themeId: string;
}

/** Defensive read of `extension.packageJSON.contributes[key]` — array or undefined. */
function contributeArray(extension: vscode.Extension<unknown>, key: string): readonly unknown[] {
  const packageJson = extension.packageJSON as Record<string, unknown> | undefined;
  const contributes = packageJson?.contributes;
  if (typeof contributes !== 'object' || contributes === null) return [];
  const entries = (contributes as Record<string, unknown>)[key];
  return Array.isArray(entries) ? entries : [];
}

/** Find the extension + theme JSON contributing the active `workbench.iconTheme`. */
export function findActiveIconTheme(): ActiveIconTheme | undefined {
  const activeId = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme', 'vs-seti');
  if (typeof activeId !== 'string' || activeId.length === 0) return undefined;

  for (const extension of vscode.extensions.all) {
    for (const theme of contributeArray(extension, 'iconThemes')) {
      if (typeof theme !== 'object' || theme === null) continue;
      const rec = theme as Record<string, unknown>;
      if (rec.id !== activeId) continue;
      const themePath = rec.path;
      if (typeof themePath !== 'string' || themePath.length === 0) continue;
      // `extensionUri` keeps the real scheme (`vscode-remote:`, `vscode-vfs:` …);
      // `extensionPath` is a node-only fsPath string and must not be used.
      const extensionUri = extension.extensionUri;
      return {
        extensionUri,
        themeJsonUri: vscode.Uri.joinPath(extensionUri, themePath),
        themeId: activeId,
      };
    }
  }
  return undefined;
}

function themeKindOf(kind: vscode.ColorThemeKind): ThemeKind {
  switch (kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
      return 'highContrast';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'highContrastLight';
    default:
      return 'dark';
  }
}

/**
 * Resolve a theme-JSON-relative asset path to a webview URI string, rejecting
 * anything that escapes the theme's extension directory (defense against
 * `../../../` inside third-party theme JSON).
 */
function makeAssetResolver(
  webview: vscode.Webview,
  themeJsonUri: vscode.Uri,
  extensionUri: vscode.Uri,
): (relPath: string) => string | undefined {
  const themeDir = vscode.Uri.joinPath(themeJsonUri, '..');
  return (relPath: string) => {
    if (relPath.length === 0) return undefined;
    const target = vscode.Uri.joinPath(themeDir, relPath);
    // joinPath collapses `..` segments; `isWithin` then guarantees containment.
    if (!isWithin(extensionUri.path, target.path)) return undefined;
    return webview.asWebviewUri(target).toString();
  };
}

function languageIndex(): LanguageIndex {
  const contributions: unknown[] = [];
  for (const extension of vscode.extensions.all) {
    contributions.push(...contributeArray(extension, 'languages'));
  }
  return buildLanguageIndex(contributions);
}

/**
 * Build the snapshot for the currently active icon theme, or `undefined` when
 * the theme is off (`null`), not found, unreadable, or unparseable.
 */
export async function buildIconThemeSnapshot(webview: vscode.Webview): Promise<IconThemeSnapshot | undefined> {
  const active = findActiveIconTheme();
  if (active === undefined) return undefined;

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(active.themeJsonUri);
  } catch {
    return undefined;
  }
  const doc = parseThemeJsonText(new TextDecoder().decode(bytes));
  if (doc === undefined) return undefined;

  const resolveAsset = makeAssetResolver(webview, active.themeJsonUri, active.extensionUri);
  const snapshot = assembleSnapshot(
    doc,
    active.themeId,
    themeKindOf(vscode.window.activeColorTheme.kind),
    resolveAsset,
    languageIndex(),
  );
  return snapshot;
}

/**
 * `extensionUri` of the extension contributing the active icon theme, for
 * inclusion in `localResourceRoots`. `undefined` when no theme is active.
 */
export function iconThemeRootUri(): vscode.Uri | undefined {
  return findActiveIconTheme()?.extensionUri;
}
