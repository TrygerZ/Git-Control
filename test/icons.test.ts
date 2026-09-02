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
  'warning',
  'error',
  'info',
  'close',
  'arrow-down',
  'arrow-up',
  'refresh',
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

test('no string "codicon" exists in src/ directory', () => {
  const srcDir = path.resolve(__dirname, '..', '..', 'src');
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
  scan(srcDir);
});
