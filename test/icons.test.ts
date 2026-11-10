import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ICON_PATHS } from '../src/webview/iconPaths';
import type { IconName } from '../src/webview/icons';

/**
 * Static icon name list extracted from the IconName union in src/webview/icons.ts.
 * Verified bidirectional with ICON_PATHS keys to prevent sync drift.
 */
const ALL_ICON_NAMES: readonly IconName[] = [
  'search',
  'git-branch',
  'circle-filled',
  'cloud',
  'tag',
  'watch',
  'ellipsis',
  'home',
  'dash',
  'add',
  'chevron-right',
  'chevron-down',
  'chevron-left',
  'chevron-up',
  'warning',
  'error',
  'info',
  'close',
  'arrow-down',
  'arrow-up',
  'refresh',
  'discard',
  'graph',
  'diff-modified',
  'diff-added',
  'diff-removed',
  'diff-renamed',
  'copy',
  'file-symlink-file',
  'question',
  'diff-ignored',
  'external',
  'file',
  'folder',
  'archive',
  'check',
  'push',
  'pull',
  'fetch',
  'commit',
  'merge',
  'cherry-pick',
  'revert',
  'reset',
  'eye',
  'filter',
  'user',
  'users',
  'settings',
  'panel-left',
  'panel-right',
  'diff',
  'history',
  'branch-add',
  'trash',
  // Sidebar nav strip (P05). `branch` is not added: the Figma "branches" glyph is `git-branch`.
  'changes',
  'issue',
  'pr',
  'play',
  // Actions run status (P13).
  'status-running',
  'status-queued',
  'status-skipped',
  // Get started card (P16).
  'sparkle',
];

test('every IconName has an SVG render function in ICON_PATHS and no orphan paths exist', () => {
  const iconPathKeys = Object.keys(ICON_PATHS) as IconName[];

  // 1. Every declared IconName in ALL_ICON_NAMES has a render function in ICON_PATHS
  for (const name of ALL_ICON_NAMES) {
    const fn = ICON_PATHS[name];
    assert.equal(typeof fn, 'function', `Icon "${name}" must have a render function in ICON_PATHS`);
    const element = fn();
    assert.ok(element !== null && element !== undefined, `Icon "${name}" element must be defined`);
  }

  // 2. Bidirectional check: every key in ICON_PATHS is in ALL_ICON_NAMES and vice versa
  const unionSet = new Set<string>(ALL_ICON_NAMES);
  const pathKeySet = new Set<string>(iconPathKeys);

  for (const key of iconPathKeys) {
    assert.ok(unionSet.has(key), `ICON_PATHS has unexpected key "${key}" not in ALL_ICON_NAMES union`);
  }
  for (const name of ALL_ICON_NAMES) {
    assert.ok(pathKeySet.has(name), `ALL_ICON_NAMES has "${name}" which is missing in ICON_PATHS`);
  }
});

test('no string "codicon" exists in the webview, which draws SVG icons under strict CSP', () => {
  // Scoped to `src/webview` on purpose. The ban exists because the webview has no
  // codicon font: `default-src 'none'` blocks it, and every icon is an inline SVG
  // from `iconPaths.tsx`. The extension host is a different context, where the
  // native QuickPick resolves `$(name)` syntax itself, so a host string naming
  // that syntax is not the failure this guard is protecting against.
  const webviewDir = path.resolve(__dirname, '..', '..', 'src', 'webview');
  function scan(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scan(full);
      } else if (ent.isFile() && /\.(ts|tsx|css|json)$/.test(ent.name)) {
        const text = fs.readFileSync(full, 'utf8');
        assert.ok(!/codicon/i.test(text), `File ${full} must not contain "codicon" (case-insensitive)`);
      }
    }
  }
  scan(webviewDir);
});
